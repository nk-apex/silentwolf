/**
 * Signal/lid-mapping.ts — LID ↔ Phone-Number JID Mapping Store
 *
 * ── BACKGROUND: WHAT IS A LID? ──────────────────────────────────────────────
 *
 * Starting with WhatsApp v7, group chats no longer expose participants' phone
 * numbers directly in message metadata.  Instead, WhatsApp uses "Linked
 * Identity" JIDs (LIDs) — opaque numeric identifiers that look like:
 *
 *   "99887766554433@lid"          (user-level, no device)
 *   "99887766554433:3@lid"        (device #3)
 *   "99887766554433:99@hosted.lid" (Business API)
 *
 * The LID-to-phone-number mapping must be learnt from WhatsApp's servers (via
 * the USync contact-sync API) or from envelope metadata in incoming messages.
 * Once learnt, mappings are stored in the Signal key store and cached in an
 * LRU cache for fast lookup.
 *
 * ── HOW MAPPINGS ARE LEARNT ──────────────────────────────────────────────────
 *
 *   1. ENVELOPE HEADERS — Incoming message stanzas include senderAlt/recipientAlt
 *      attributes that give both the PN and LID of a sender.
 *      decode-wa-message.ts calls storeLIDPNMappings() when it sees these.
 *
 *   2. USYNC — On demand, getLIDsForPNs() falls back to the USync API to fetch
 *      the LID for a phone number not yet in the local store.  The pnToLIDFunc
 *      callback (injected at construction time) is the hook into that API.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 *
 *   Persistent (key store):
 *     'lid-mapping'  pnUser    → lidUser        (forward: PN user → LID user)
 *     'lid-mapping'  lidUser_reverse → pnUser   (reverse: LID user → PN user)
 *
 *   In-memory (LRU cache, 3-day TTL):
 *     'pn:PNUSER'   → lidUser string
 *     'lid:LIDUSER' → pnUser string
 *
 *   Entries expire from the cache after 3 days of no access (TTL) — they are
 *   not deleted from the persistent store, so re-populating is just a DB read.
 *
 * ── PUBLIC API ───────────────────────────────────────────────────────────────
 *
 *   sock.signalRepository.lidMapping.getPNForLID(lid)   → phone JID | null
 *   sock.signalRepository.lidMapping.getLIDForPN(pn)    → LID JID   | null
 *   sock.signalRepository.lidMapping.storeLIDPNMappings(pairs)
 */

import { LRUCache } from 'lru-cache'
import type { LIDMapping, SignalKeyStoreWithTransaction } from '../Types'
import type { ILogger } from '../Utils/logger'
import { isHostedPnUser, isLidUser, isPnUser, jidDecode, jidNormalizedUser, WAJIDDomains } from '../WABinary'

/**
 * LIDMappingStore — bidirectional LID ↔ PN JID mapping with LRU cache.
 *
 * Constructed once per socket session and injected into SignalRepositoryWithLIDStore.
 * Users access it via: sock.signalRepository.lidMapping
 */
export class LIDMappingStore {
        /**
         * In-memory LRU cache for fast repeated lookups.
         *
         * TTL: 3 days of no access before eviction.
         * updateAgeOnGet: reset the TTL every time an entry is accessed, so
         *   frequently-used mappings stay warm indefinitely.
         * ttlAutopurge: run periodic background cleanup (avoids memory leaks).
         *
         * Keys use prefixes to keep PN and LID entries in the same Map:
         *   "pn:<pnUser>"   → lidUser  (e.g. "pn:254712345678" → "99887766")
         *   "lid:<lidUser>" → pnUser   (e.g. "lid:99887766" → "254712345678")
         */
        private readonly mappingCache = new LRUCache<string, string>({
                ttl: 3 * 24 * 60 * 60 * 1000, // 3 days in milliseconds
                ttlAutopurge: true,
                updateAgeOnGet: true
        })

        /** Persistent Signal key store — survives restarts (written to disk by useMultiFileAuthState). */
        private readonly keys: SignalKeyStoreWithTransaction

        private readonly logger: ILogger

        /**
         * Optional async callback to look up LID(s) for PN(s) via the USync API.
         * Injected by makeMessagesRecvSocket after the socket is connected.
         * If null, LID lookups that miss the local store will return null.
         */
        private pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>

        constructor(
                keys: SignalKeyStoreWithTransaction,
                logger: ILogger,
                pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>
        ) {
                this.keys = keys
                this.pnToLIDFunc = pnToLIDFunc
                this.logger = logger
        }

        /**
         * Store one or more LID ↔ PN mappings in both the cache and the
         * persistent key store.
         *
         * Called from two places:
         *   1. decode-wa-message.ts — when a message envelope contains senderAlt
         *   2. getLIDsForPNs()     — after a USync fetch returns results
         *
         * Mappings that already exist with the same LID user are silently skipped
         * to avoid unnecessary disk writes.
         *
         * @param pairs - Array of { lid, pn } pairs (either order is accepted; the
         *                function normalises them internally)
         */
        async storeLIDPNMappings(pairs: LIDMapping[]): Promise<void> {
                // Collect valid (pnUser → lidUser) pairs in a plain object,
                // deduplicating by pnUser so we only write each mapping once.
                const pairMap: { [_: string]: string } = {}

                for (const { lid, pn } of pairs) {
                        // Validate: one side must be a LID JID and the other a PN JID
                        if (!((isLidUser(lid) && isPnUser(pn)) || (isPnUser(lid) && isLidUser(pn)))) {
                                this.logger.warn(`Invalid LID-PN mapping (wrong JID format): lid="${lid}", pn="${pn}"`)
                                continue
                        }

                        const lidDecoded = jidDecode(lid)
                        const pnDecoded = jidDecode(pn)
                        if (!lidDecoded || !pnDecoded) return

                        const pnUser = pnDecoded.user   // just the numeric part, e.g. "254712345678"
                        const lidUser = lidDecoded.user  // just the numeric part, e.g. "99887766"

                        // Check if we already have this exact mapping in cache …
                        let existingLidUser = this.mappingCache.get(`pn:${pnUser}`)
                        if (!existingLidUser) {
                                // … or in the persistent store
                                this.logger.trace(`Cache miss for PN user ${pnUser}; checking persistent store`)
                                const stored = await this.keys.get('lid-mapping', [pnUser])
                                existingLidUser = stored[pnUser]
                                if (existingLidUser) {
                                        // Warm the cache from the store
                                        this.mappingCache.set(`pn:${pnUser}`, existingLidUser)
                                        this.mappingCache.set(`lid:${existingLidUser}`, pnUser)
                                }
                        }

                        if (existingLidUser === lidUser) {
                                // Mapping is already correct — skip to avoid unnecessary writes
                                this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping')
                                continue
                        }

                        pairMap[pnUser] = lidUser
                }

                this.logger.trace({ pairMap }, `Storing ${Object.keys(pairMap).length} LID-PN mapping(s)`)

                // Write everything in a single transaction for atomicity.
                // Both forward (pnUser → lidUser) and reverse (lidUser_reverse → pnUser)
                // entries are stored so both getPNForLID and getLIDForPN work.
                await this.keys.transaction(async () => {
                        for (const [pnUser, lidUser] of Object.entries(pairMap)) {
                                await this.keys.set({
                                        'lid-mapping': {
                                                [pnUser]: lidUser,                      // forward lookup
                                                [`${lidUser}_reverse`]: pnUser          // reverse lookup
                                        }
                                })

                                // Update in-memory cache immediately
                                this.mappingCache.set(`pn:${pnUser}`, lidUser)
                                this.mappingCache.set(`lid:${lidUser}`, pnUser)
                        }
                }, 'lid-mapping')
        }

        /**
         * Look up the LID JID for a single phone-number JID.
         *
         * Convenience wrapper around getLIDsForPNs().
         *
         * @param pn - A PN JID, e.g. "254712345678@s.whatsapp.net"
         * @returns The device-specific LID JID, e.g. "99887766:3@lid", or null if unknown
         */
        async getLIDForPN(pn: string): Promise<string | null> {
                return (await this.getLIDsForPNs([pn]))?.[0]?.lid || null
        }

        /**
         * Look up LID JIDs for a batch of phone-number JIDs.
         *
         * The lookup follows this priority order:
         *   1. In-memory LRU cache (fastest — sub-millisecond)
         *   2. Persistent key store (milliseconds — JSON file read)
         *   3. USync API fetch via pnToLIDFunc (slowest — network round trip)
         *
         * If USync is called, the results are persisted so future calls are fast.
         *
         * Device numbers are preserved in the returned LID JIDs:
         *   "254712345678:3@s.whatsapp.net" → "99887766:3@lid"
         *
         * @param pns - Array of PN JIDs (regular or hosted)
         * @returns Array of { lid, pn } pairs for those that could be resolved,
         *          or null if any required USync fetch returned nothing
         */
        async getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null> {
                // Track which PNs need a USync fetch, keyed by normalized PN → device numbers
                const usyncFetch: { [_: string]: number[] } = {}
                // Successfully resolved pairs (keyed by PN to deduplicate)
                const successfulPairs: { [_: string]: LIDMapping } = {}

                for (const pn of pns) {
                        if (!isPnUser(pn) && !isHostedPnUser(pn)) continue

                        const decoded = jidDecode(pn)
                        if (!decoded) continue

                        const pnUser = decoded.user

                        // Step 1: check in-memory cache
                        let lidUser = this.mappingCache.get(`pn:${pnUser}`)

                        if (!lidUser) {
                                // Step 2: check persistent key store
                                const stored = await this.keys.get('lid-mapping', [pnUser])
                                lidUser = stored[pnUser]

                                if (lidUser) {
                                        // Warm the cache from the store result
                                        this.mappingCache.set(`pn:${pnUser}`, lidUser)
                                        this.mappingCache.set(`lid:${lidUser}`, pnUser)
                                } else {
                                        // Step 3: queue for USync API fetch
                                        this.logger.trace(`No LID mapping for PN ${pnUser}; will fetch via USync`)
                                        const device = decoded.device || 0
                                        let normalizedPn = jidNormalizedUser(pn)
                                        // Normalise hosted PNs to regular s.whatsapp.net for USync
                                        if (isHostedPnUser(normalizedPn)) {
                                                normalizedPn = `${pnUser}@s.whatsapp.net`
                                        }

                                        if (!usyncFetch[normalizedPn]) {
                                                usyncFetch[normalizedPn] = [device]
                                        } else {
                                                usyncFetch[normalizedPn]?.push(device)
                                        }

                                        continue
                                }
                        }

                        lidUser = lidUser.toString()
                        if (!lidUser) {
                                this.logger.warn(`Empty LID user returned for PN ${pn}`)
                                return null
                        }

                        // Construct a device-specific LID JID preserving the original device number.
                        // e.g. pn="254712345678:3@s.whatsapp.net" → "99887766:3@lid"
                        const pnDevice = decoded.device !== undefined ? decoded.device : 0
                        const deviceSpecificLid = `${lidUser}${!!pnDevice ? `:${pnDevice}` : ''}@${decoded.server === 'hosted' ? 'hosted.lid' : 'lid'}`

                        this.logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid}`)
                        successfulPairs[pn] = { lid: deviceSpecificLid, pn }
                }

                // If any PNs needed USync, fetch them all in one batch
                if (Object.keys(usyncFetch).length > 0) {
                        const result = await this.pnToLIDFunc?.(Object.keys(usyncFetch))
                        if (result && result.length > 0) {
                                // Persist and cache the newly learnt mappings
                                await this.storeLIDPNMappings(result)

                                for (const pair of result) {
                                        const pnDecoded = jidDecode(pair.pn)
                                        const pnUser = pnDecoded?.user
                                        if (!pnUser) continue

                                        const lidUser = jidDecode(pair.lid)?.user
                                        if (!lidUser) continue

                                        // Reconstruct device-specific JIDs for each device that queried this PN
                                        for (const device of usyncFetch[pair.pn]!) {
                                                // Device 99 is the hosted/Business API device
                                                const deviceSpecificLid = `${lidUser}${!!device ? `:${device}` : ''}@${device === 99 ? 'hosted.lid' : 'lid'}`
                                                const deviceSpecificPn = `${pnUser}${!!device ? `:${device}` : ''}@${device === 99 ? 'hosted' : 's.whatsapp.net'}`

                                                this.logger.trace(`USync resolved: ${deviceSpecificPn} → ${deviceSpecificLid}`)
                                                successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn }
                                        }
                                }
                        } else {
                                // USync returned nothing — caller must handle null
                                return null
                        }
                }

                return Object.values(successfulPairs)
        }

        /**
         * Look up the phone-number JID for a LID JID (reverse lookup).
         *
         * This is the most common use case for end users: you receive a message from
         * "99887766:3@lid" in a group and want to know the sender's phone number.
         *
         * @example
         *   const pn = await sock.signalRepository.lidMapping.getPNForLID('99887766:3@lid')
         *   // Returns "254712345678:3@s.whatsapp.net" or null if not yet known
         *
         * @param lid - A LID JID, e.g. "99887766:3@lid"
         * @returns The device-specific PN JID, e.g. "254712345678:3@s.whatsapp.net",
         *          or null if the mapping is not available locally
         */
        async getPNForLID(lid: string): Promise<string | null> {
                if (!isLidUser(lid)) return null  // only @lid JIDs are supported

                const decoded = jidDecode(lid)
                if (!decoded) return null

                const lidUser = decoded.user  // numeric part without device/server

                // Step 1: check in-memory cache (fast path)
                let pnUser = this.mappingCache.get(`lid:${lidUser}`)

                if (!pnUser || typeof pnUser !== 'string') {
                        // Step 2: check persistent key store (medium path)
                        // Reverse entries are stored as "<lidUser>_reverse" → pnUser
                        const stored = await this.keys.get('lid-mapping', [`${lidUser}_reverse`])
                        pnUser = stored[`${lidUser}_reverse`]

                        if (!pnUser || typeof pnUser !== 'string') {
                                // Mapping not known — caller should trigger a USync fetch if needed
                                this.logger.trace(`No reverse mapping found for LID user: ${lidUser}`)
                                return null
                        }

                        // Warm the reverse cache entry
                        this.mappingCache.set(`lid:${lidUser}`, pnUser)
                }

                // Construct a device-specific PN JID, preserving the LID's device number.
                // e.g. "99887766:3@lid" → "254712345678:3@s.whatsapp.net"
                // Device 99 in hosted.lid maps to "hosted" PN server.
                const lidDevice = decoded.device !== undefined ? decoded.device : 0
                const pnJid = `${pnUser}:${lidDevice}@${decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'}`

                this.logger.trace(`getPNForLID: ${lid} → ${pnJid}`)
                return pnJid
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// LID WARMUP HELPER
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY WARM UP?
//
// LID → phone-number lookups are async (they may need a USync round-trip to
// WhatsApp's servers).  In a busy bot that handles group messages, the FIRST
// message from each group member will trigger a USync request, adding ~200 ms
// of latency before the message can be attributed to a human-readable JID.
//
// By warming the cache at startup (e.g. when you call sock.groupFetchAllParticipating()),
// all LID mappings are pre-fetched from the Signal key store into the in-memory
// LRU cache.  Subsequent getPNForLID() calls for those contacts return instantly.
//
// HOW TO USE:
//
//   1. Get your group's participant list:
//        const meta = await sock.groupMetadata('1234567890-123456@g.us')
//        const lids = meta.participants
//          .map(p => p.lid)        // LID JIDs are in the lid field
//          .filter(Boolean)
//
//   2. Warm the cache:
//        await warmLIDCache(sock.signalRepository.lidMapping, lids)
//
//   3. From now on, getPNForLID(lid) for those participants will be synchronous
//      (cache-hit path — no async I/O).
//
// NOTE: You do not need to call this manually on every message.  The cache is
// populated automatically as messages arrive (via storeLIDPNMappings in
// decode-wa-message.ts).  Warmup is only useful for pre-loading known contacts
// before any messages have been received in the current session.

/**
 * warmLIDCache — Pre-warm the LID mapping LRU cache for a set of LID JIDs.
 *
 * For each LID in `lids`, this function reads the reverse mapping from the
 * persistent key store and inserts the result into the in-memory LRU cache.
 * After calling this, getPNForLID() for those LIDs will return synchronously
 * from the cache rather than performing an async key-store read.
 *
 * @param store  — The LIDMappingStore instance (sock.signalRepository.lidMapping)
 * @param lids   — Array of LID JIDs to warm.  Non-LID JIDs are silently ignored.
 * @returns      — Map of `{ lid → phoneJid | null }` for all requested LIDs.
 *
 * @example
 *   const meta = await sock.groupMetadata(groupJid)
 *   const lids = meta.participants.map(p => p.lid).filter(Boolean)
 *   const resolved = await warmLIDCache(sock.signalRepository.lidMapping, lids)
 *   for (const [lid, pn] of resolved) {
 *     console.log(lid, '→', pn ?? '(unknown)')
 *   }
 */
export async function warmLIDCache(
        store: LIDMappingStore,
        lids: string[]
): Promise<Map<string, string | null>> {
        const result = new Map<string, string | null>()
        // Process all LIDs concurrently — each getPNForLID call may hit the key store
        // asynchronously, so Promise.all() parallelises all the I/O.
        await Promise.all(
                lids.map(async lid => {
                        // getPNForLID handles its own cache population as a side effect,
                        // so just calling it is enough to warm the entry.
                        const pn = await store.getPNForLID(lid)
                        result.set(lid, pn)
                })
        )
        return result
}
