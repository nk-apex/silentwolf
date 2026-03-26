/**
 * Utils/auth-utils.ts — Authentication Credentials and Signal Key Store Utilities
 *
 * This file has two major exports:
 *
 *   1. initAuthCreds()
 *      Generates a brand-new set of cryptographic credentials for a device that
 *      has never linked to WhatsApp before.  Called once by useMultiFileAuthState
 *      when no existing creds.json is found on disk.
 *
 *   2. makeCacheableSignalKeyStore()
 *      Wraps a raw SignalKeyStore with an in-memory cache so that hot keys
 *      (pre-keys, sessions) don't hit disk on every message decryption.
 *
 *   3. addTransactionCapability()
 *      Wraps a SignalKeyStore with database-style transaction semantics:
 *        • BEGIN  — create an in-memory snapshot
 *        • WORK   — all reads come from the snapshot; writes go to a local buffer
 *        • COMMIT — flush the buffer to the real store with retry logic
 *        • ROLLBACK — (implicit on error) discard the buffer
 *
 *      Transactions are important for Signal protocol operations that read
 *      then write key material (e.g. consuming a pre-key):  without a
 *      transaction, a crash mid-operation could leave the store in an
 *      inconsistent state where a pre-key is "consumed" in memory but
 *      not yet deleted from disk.
 *
 * ── SIGNAL PROTOCOL KEY TYPES ─────────────────────────────────────────────────
 *
 *   pre-key              — One-time ephemeral keys (812 generated on registration)
 *   signed-pre-key       — Medium-term key signed with the identity key
 *   session              — Per-contact ratchet state (one per device you've chatted with)
 *   sender-key           — Group message encryption key (one per group)
 *   app-state-sync-key   — Keys for syncing app state (chats, contacts, settings)
 *   lid-mapping          — LID ↔ PN JID mapping (silentwolf extension)
 */

import NodeCache from '@cacheable/node-cache'
import { AsyncLocalStorage } from 'async_hooks'
import { Mutex } from 'async-mutex'
import { randomBytes } from 'crypto'
import PQueue from 'p-queue'
import { DEFAULT_CACHE_TTLS } from '../Defaults'
import type {
        AuthenticationCreds,
        CacheStore,
        SignalDataSet,
        SignalDataTypeMap,
        SignalKeyStore,
        SignalKeyStoreWithTransaction,
        TransactionCapabilityOptions
} from '../Types'
import { Curve, signedKeyPair } from './crypto'
import { delay, generateRegistrationId } from './generics'
import type { ILogger } from './logger'
import { PreKeyManager } from './pre-key-manager'

// ── Transaction Context ───────────────────────────────────────────────────────

/**
 * Data stored in AsyncLocalStorage for the duration of one transaction.
 *
 * AsyncLocalStorage is Node.js's equivalent of thread-local storage.  Because
 * we're async (not multi-threaded), it tracks which async call chain is inside
 * a transaction, so nested async calls automatically see the transaction context
 * without needing to pass it as a parameter.
 */
interface TransactionContext {
        /** In-memory snapshot: reads during the transaction come from here first. */
        cache: SignalDataSet

        /** Write buffer: set() calls during the transaction accumulate here. */
        mutations: SignalDataSet

        /** Count of actual key-store reads (for performance logging). */
        dbQueries: number
}

// ── makeCacheableSignalKeyStore ───────────────────────────────────────────────

/**
 * Wrap a SignalKeyStore with an in-memory LRU cache.
 *
 * The Signal protocol reads keys very frequently (on every message decrypt).
 * Without a cache this means many disk reads.  This wrapper keeps hot keys in
 * memory for up to 5 minutes (DEFAULT_CACHE_TTLS.SIGNAL_STORE).
 *
 * The cache uses a Mutex to prevent concurrent reads from racing each other
 * and causing duplicate store fetches.
 *
 * @param store   - The underlying key store to wrap (e.g. the file-system store)
 * @param logger  - Optional logger for cache miss tracing
 * @param _cache  - Optional external cache (useful in tests); defaults to NodeCache
 * @returns A SignalKeyStore with transparent caching
 */
export function makeCacheableSignalKeyStore(
        store: SignalKeyStore,
        logger?: ILogger,
        _cache?: CacheStore
): SignalKeyStore {
        const cache =
                _cache ||
                new NodeCache<SignalDataTypeMap[keyof SignalDataTypeMap]>({
                        stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE,  // 5 minutes
                        useClones: false,   // store references, not deep copies (faster)
                        deleteOnExpire: true
                })

        // Serialise all cache operations to prevent race conditions when multiple
        // messages arrive simultaneously and all need the same session key.
        const cacheMutex = new Mutex()

        /** Build a cache key like "session.254712345678:3@s.whatsapp.net" */
        function getUniqueId(type: string, id: string) {
                return `${type}.${id}`
        }

        return {
                async get(type, ids) {
                        return cacheMutex.runExclusive(async () => {
                                const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
                                const idsToFetch: string[] = []

                                // Split IDs into "cached" and "needs store fetch"
                                for (const id of ids) {
                                        const item = (await cache.get<SignalDataTypeMap[typeof type]>(getUniqueId(type, id))) as any
                                        if (typeof item !== 'undefined') {
                                                data[id] = item  // cache hit
                                        } else {
                                                idsToFetch.push(id)  // cache miss → fetch from store
                                        }
                                }

                                if (idsToFetch.length) {
                                        logger?.trace({ items: idsToFetch.length }, 'loading from store')
                                        const fetched = await store.get(type, idsToFetch)
                                        for (const id of idsToFetch) {
                                                const item = fetched[id]
                                                if (item) {
                                                        data[id] = item
                                                        // Warm the cache for next time
                                                        await cache.set(getUniqueId(type, id), item as SignalDataTypeMap[keyof SignalDataTypeMap])
                                                }
                                        }
                                }

                                return data
                        })
                },

                async set(data) {
                        return cacheMutex.runExclusive(async () => {
                                let keys = 0
                                for (const type in data) {
                                        for (const id in data[type as keyof SignalDataTypeMap]) {
                                                // Update cache first (will be read back immediately if needed)
                                                await cache.set(getUniqueId(type, id), data[type as keyof SignalDataTypeMap]![id]!)
                                                keys += 1
                                        }
                                }

                                logger?.trace({ keys }, 'updated cache')
                                // Then flush to the real store
                                await store.set(data)
                        })
                },

                async clear() {
                        await cache.flushAll()
                        await store.clear?.()
                }
        }
}

// ── addTransactionCapability ──────────────────────────────────────────────────

/**
 * Wrap a SignalKeyStore with transaction semantics.
 *
 * This is the outermost layer of the Signal key store stack:
 *
 *   [transaction layer]     ← this function adds this
 *     → [cache layer]       ← makeCacheableSignalKeyStore
 *       → [file-system layer] ← useMultiFileAuthState
 *
 * TRANSACTION LIFECYCLE:
 *
 *   await keys.transaction(async () => {
 *     const preKey = await keys.get('pre-key', ['123'])  // reads from cache/db
 *     await keys.set({ 'pre-key': { '123': null } })     // buffered (not written yet)
 *   }, 'some-key')
 *   // ↑ transaction commits here — writes are flushed with retry
 *
 * WHY TRANSACTIONS?
 *
 * The Signal protocol has multi-step operations:
 *   1. Fetch a pre-key from the store
 *   2. Use it to decrypt a message
 *   3. Delete the pre-key (one-time use)
 *
 * Without a transaction, a crash between steps 2 and 3 leaves a "used" pre-key
 * in the store, which will cause decryption failures for future messages from
 * the same sender.  With a transaction, steps 2 and 3 are atomic.
 *
 * NESTED TRANSACTIONS:
 * If transaction() is called while already inside a transaction (e.g. from
 * a recursive call), it reuses the existing context rather than creating a
 * new one.  This prevents deadlocks on the mutex.
 *
 * CONCURRENCY:
 * Each "key" (the second parameter to transaction()) has its own Mutex.
 * Transactions on different keys can run in parallel.
 *
 * @param state                - The underlying key store to wrap
 * @param logger               - Logger for transaction trace output
 * @param maxCommitRetries     - How many times to retry a failed commit
 * @param delayBetweenTriesMs  - Milliseconds to wait between commit retries
 */
export const addTransactionCapability = (
        state: SignalKeyStore,
        logger: ILogger,
        { maxCommitRetries, delayBetweenTriesMs }: TransactionCapabilityOptions
): SignalKeyStoreWithTransaction => {
        // AsyncLocalStorage carries the transaction context through async call chains.
        // Think of it as a "stack frame" attached to an async operation tree.
        const txStorage = new AsyncLocalStorage<TransactionContext>()

        // Per-key-type serial queues — ensure writes of the same type don't race
        const keyQueues = new Map<string, PQueue>()
        // Per-key mutexes — only one transaction per key can run at a time
        const txMutexes = new Map<string, Mutex>()

        // Pre-key manager handles the special rules around pre-key deletion
        // (pre-keys must not be deleted until they've been confirmed used)
        const preKeyManager = new PreKeyManager(state, logger)

        /** Get-or-create a serial queue for a given key type (e.g. 'pre-key'). */
        function getQueue(key: string): PQueue {
                if (!keyQueues.has(key)) {
                        keyQueues.set(key, new PQueue({ concurrency: 1 }))
                }

                return keyQueues.get(key)!
        }

        /** Get-or-create a Mutex for a given transaction key. */
        function getTxMutex(key: string): Mutex {
                if (!txMutexes.has(key)) {
                        txMutexes.set(key, new Mutex())
                }

                return txMutexes.get(key)!
        }

        /** Return true if the current async context is inside a transaction. */
        function isInTransaction(): boolean {
                return !!txStorage.getStore()
        }

        /**
         * Attempt to commit all buffered mutations to the underlying store.
         *
         * Retries up to `maxCommitRetries` times with a fixed delay between
         * attempts.  On final failure, throws so the caller knows the transaction
         * did not commit cleanly.
         */
        async function commitWithRetry(mutations: SignalDataSet): Promise<void> {
                if (Object.keys(mutations).length === 0) {
                        logger.trace('no mutations to commit')
                        return
                }

                logger.trace('committing transaction')

                for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
                        try {
                                await state.set(mutations)
                                logger.trace({ mutationCount: Object.keys(mutations).length }, 'transaction committed')
                                return
                        } catch (error) {
                                const retriesLeft = maxCommitRetries - attempt - 1
                                logger.warn({ error, retriesLeft }, 'transaction commit failed — will retry')

                                if (retriesLeft === 0) {
                                        throw error  // No more retries — propagate the error
                                }

                                await delay(delayBetweenTriesMs)
                        }
                }
        }

        return {
                /**
                 * Read key(s) from the store.
                 *
                 * INSIDE a transaction: reads come from the in-memory snapshot first,
                 * falling back to the underlying store for keys not yet in the snapshot.
                 * This ensures you see your own transaction's writes immediately.
                 *
                 * OUTSIDE a transaction: reads go directly to the underlying store.
                 */
                get: async (type, ids) => {
                        const ctx = txStorage.getStore()

                        if (!ctx) {
                                // No active transaction — plain store read
                                return state.get(type, ids)
                        }

                        // Inside transaction: check the snapshot first
                        const cached = ctx.cache[type] || {}
                        const missing = ids.filter(id => !(id in cached))

                        if (missing.length > 0) {
                                ctx.dbQueries++
                                logger.trace({ type, count: missing.length }, 'fetching missing keys within transaction')

                                // Fetch missing keys from the underlying store (mutex-protected)
                                const fetched = await getTxMutex(type).runExclusive(() => state.get(type, missing))

                                // Merge into the snapshot
                                ctx.cache[type] = ctx.cache[type] || ({} as any)
                                Object.assign(ctx.cache[type]!, fetched)
                        }

                        // Return the requested IDs from the snapshot
                        const result: { [key: string]: any } = {}
                        for (const id of ids) {
                                const value = ctx.cache[type]?.[id]
                                if (value !== undefined && value !== null) {
                                        result[id] = value
                                }
                        }

                        return result
                },

                /**
                 * Write key(s) to the store.
                 *
                 * INSIDE a transaction: writes go into the mutation buffer and the
                 * snapshot.  Nothing is written to disk until the transaction commits.
                 *
                 * OUTSIDE a transaction: writes go directly to the underlying store
                 * via the per-type serial queue (to prevent concurrent write races).
                 */
                set: async data => {
                        const ctx = txStorage.getStore()

                        if (!ctx) {
                                // No active transaction — write directly to the store
                                const types = Object.keys(data)

                                // Validate pre-key deletions (special handling — see PreKeyManager)
                                for (const type_ of types) {
                                        const type = type_ as keyof SignalDataTypeMap
                                        if (type === 'pre-key') {
                                                await preKeyManager.validateDeletions(data, type)
                                        }
                                }

                                // Write each type through its serial queue for concurrency safety
                                await Promise.all(
                                        types.map(type =>
                                                getQueue(type).add(async () => {
                                                        const typeData = { [type]: data[type as keyof SignalDataTypeMap] } as SignalDataSet
                                                        await state.set(typeData)
                                                })
                                        )
                                )
                                return
                        }

                        // Inside a transaction — buffer writes into the mutation accumulator
                        logger.trace({ types: Object.keys(data) }, 'buffering mutations in transaction')

                        for (const key_ in data) {
                                const key = key_ as keyof SignalDataTypeMap

                                ctx.cache[key] = ctx.cache[key] || ({} as any)
                                ctx.mutations[key] = ctx.mutations[key] || ({} as any)

                                if (key === 'pre-key') {
                                        // Pre-keys need special handling to track deletion safety
                                        await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true)
                                } else {
                                        // Normal keys: merge into both snapshot and mutation buffer
                                        Object.assign(ctx.cache[key]!, data[key])
                                        Object.assign(ctx.mutations[key]!, data[key])
                                }
                        }
                },

                /** Return true if currently inside a transaction. */
                isInTransaction,

                /**
                 * Run `work` atomically inside a transaction.
                 *
                 * @param work - Async function containing the transactional logic
                 * @param key  - A string that identifies this transaction type;
                 *               only one transaction per key can run concurrently
                 * @returns The return value of `work`
                 */
                transaction: async (work, key) => {
                        const existing = txStorage.getStore()

                        if (existing) {
                                // Already inside a transaction — reuse the existing context
                                // (prevents deadlock on the mutex and avoids double-commit)
                                logger.trace('reusing existing transaction context (nested call)')
                                return work()
                        }

                        // Acquire the per-key mutex and create a fresh transaction context
                        return getTxMutex(key).runExclusive(async () => {
                                const ctx: TransactionContext = {
                                        cache: {},      // in-memory snapshot (reads come from here)
                                        mutations: {},  // write buffer (committed at the end)
                                        dbQueries: 0    // for perf logging
                                }

                                logger.trace('starting transaction')

                                try {
                                        // Run the user's async work inside the AsyncLocalStorage context.
                                        // Any async function called from `work` will see ctx via getStore().
                                        const result = await txStorage.run(ctx, work)

                                        // Work completed successfully — commit the buffered mutations
                                        await commitWithRetry(ctx.mutations)

                                        logger.trace({ dbQueries: ctx.dbQueries }, 'transaction complete')

                                        return result
                                } catch (error) {
                                        // Work threw an error — discard the mutation buffer (rollback)
                                        logger.error({ error }, 'transaction failed — rolling back (mutations discarded)')
                                        throw error
                                }
                        })
                }
        }
}

// ── initAuthCreds ─────────────────────────────────────────────────────────────

/**
 * Generate a fresh set of authentication credentials for a new device.
 *
 * This is called exactly once when a device links for the first time.
 * Every field is generated fresh:
 *   • noiseKey              — Curve25519 key for the Noise transport handshake
 *   • pairingEphemeralKeyPair — Ephemeral key for the link-device protocol
 *   • signedIdentityKey     — Long-term Signal identity key (the "root" of trust)
 *   • signedPreKey          — First signed pre-key (more uploaded on registration)
 *   • registrationId        — Random 16-bit device ID
 *   • advSecretKey          — 32 random bytes for Advanced Device Verification
 *
 * After linking, WhatsApp fills in me.id (your JID), me.lid (your LID), and
 * other server-assigned fields by mutating the creds object in-place and
 * calling saveCreds().
 *
 * @returns A new AuthenticationCreds object ready for a first-time registration
 */
export const initAuthCreds = (): AuthenticationCreds => {
        const identityKey = Curve.generateKeyPair()
        return {
                noiseKey: Curve.generateKeyPair(),
                pairingEphemeralKeyPair: Curve.generateKeyPair(),
                signedIdentityKey: identityKey,
                signedPreKey: signedKeyPair(identityKey, 1),  // keyId = 1 (first key)
                registrationId: generateRegistrationId(),
                advSecretKey: randomBytes(32).toString('base64'),

                // These start empty and are filled in by the server after login
                processedHistoryMessages: [],
                nextPreKeyId: 1,               // next pre-key to generate
                firstUnuploadedPreKeyId: 1,    // next pre-key to upload to server
                accountSyncCounter: 0,
                accountSettings: {
                        unarchiveChats: false
                },
                registered: false,             // set to true after first successful registration
                pairingCode: undefined,        // set during pair-code linking
                lastPropHash: undefined,       // used to detect server property changes
                routingInfo: undefined,        // only set for Business API accounts
                additionalData: undefined      // reserved for future use
        }
}
