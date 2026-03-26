/**
 * Utils/use-multi-file-auth-state.ts — File-System Authentication State
 *
 * This file provides the most common way to persist a WhatsApp session between
 * process restarts: storing the session as JSON files in a folder on disk.
 *
 * ── WHAT IS AUTH STATE? ──────────────────────────────────────────────────────
 *
 * The WhatsApp Multi-Device protocol requires two categories of persistent data:
 *
 *   1. CREDENTIALS (creds.json)
 *      Everything about YOUR device's identity:
 *        • noiseKey          — Curve25519 key pair for the Noise transport layer
 *        • signedIdentityKey — Your long-term Signal identity key pair
 *        • signedPreKey      — Your signed pre-key (rotated periodically)
 *        • registrationId    — Random device registration ID
 *        • advSecretKey      — Advanced Device Verification secret
 *        • routingInfo       — Routing metadata (Business API only)
 *        • me.id / me.lid    — Your JID and LID after successful login
 *        … and more (see Types/Auth.ts)
 *
 *   2. SIGNAL KEYS (one file per key)
 *      The Signal Protocol (Double Ratchet) session keys and pre-keys.
 *      These are named like:  pre-key-1.json, session-254712345678.json, etc.
 *      There can be thousands of these files for active accounts.
 *
 * ── FILE NAMING ───────────────────────────────────────────────────────────────
 *
 * The `fixFileName` function replaces '/' with '__' and ':' with '-' so that
 * JIDs (which contain '@' and ':') can be used as filenames safely.
 *
 *   "pre-key-1"                        → "pre-key-1.json"
 *   "session-254712345678:3"           → "session-254712345678-3.json"
 *   "app-state-sync-key-AAAA/BB+C=="   → "app-state-sync-key-AAAA__BB+C==.json"
 *
 * ── CONCURRENCY ───────────────────────────────────────────────────────────────
 *
 * Node.js's `fs.promises` functions are non-blocking, but they are NOT
 * thread-safe for the same file.  If two Signal sessions start simultaneously
 * they might both try to write the same pre-key file at the same time, which
 * can corrupt it.  A per-file Mutex (from the `async-mutex` package) serialises
 * all reads and writes to each file path.
 *
 * ── PRODUCTION RECOMMENDATION ─────────────────────────────────────────────────
 *
 * This implementation is suitable for bots and development.  For production
 * multi-user systems:
 *   • Use a proper SQL database (PostgreSQL, MySQL) or NoSQL store (Redis,
 *     MongoDB) instead of files.
 *   • Implement your own AuthenticationState that reads/writes to that store.
 *   • The interface is the same — just replace the `state` object.
 *
 * @example
 *   const { state, saveCreds } = await useMultiFileAuthState('./auth_folder')
 *   const sock = makeWASocket({ auth: state })
 *   sock.ev.on('creds.update', saveCreds)   // IMPORTANT: always do this
 */

import { Mutex } from 'async-mutex'
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

// ── Per-file Mutex Registry ───────────────────────────────────────────────────
//
// Node.js's fs.promises functions are async but not atomic — two concurrent
// writes to the same file can interleave and corrupt it.  See:
//   https://github.com/WhiskeySockets/Baileys/issues/794
//   https://github.com/nodejs/node/issues/26338
//
// Solution: keep one Mutex per file path.  Any read or write acquires the
// mutex first, serialising concurrent operations on that file.

const fileLocks = new Map<string, Mutex>()

/**
 * Get the Mutex for a specific file path, creating it on first use.
 * The Map ensures we reuse the same Mutex for a given path so that
 * all concurrent callers share the same lock.
 */
const getFileLock = (path: string): Mutex => {
        let mutex = fileLocks.get(path)
        if (!mutex) {
                mutex = new Mutex()
                fileLocks.set(path, mutex)
        }

        return mutex
}

/**
 * useMultiFileAuthState — Persist the WhatsApp session in a folder of JSON files.
 *
 * Creates the folder if it doesn't exist, loads existing credentials, and
 * returns an AuthenticationState that reads/writes files automatically.
 *
 * IMPORTANT: Wire up `saveCreds` to the `creds.update` event or your session
 * will be lost on restart:
 *
 *   sock.ev.on('creds.update', saveCreds)
 *
 * @param folder - Path to the folder where session files will be stored.
 *                 Will be created if it doesn't exist.
 *
 * @returns {
 *   state:     AuthenticationState — pass this to makeWASocket({ auth: state })
 *   saveCreds: () => Promise<void> — call on every 'creds.update' event
 * }
 *
 * @throws If something that is NOT a directory already exists at `folder`.
 */
export const useMultiFileAuthState = async (
        folder: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
        // ── File I/O Helpers ──────────────────────────────────────────────────

        /**
         * Write JSON data to a file, serialising access with a per-file Mutex.
         * Uses BufferJSON.replacer to correctly serialise Buffer values as
         * base64 strings instead of the default { type: 'Buffer', data: [...] }.
         */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const writeData = async (data: any, file: string) => {
                const filePath = join(folder, fixFileName(file)!)
                const mutex = getFileLock(filePath)

                return mutex.acquire().then(async release => {
                        try {
                                await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer))
                        } finally {
                                release()
                        }
                })
        }

        /**
         * Read and parse JSON data from a file.
         *
         * Returns null on any error (file not found, permission denied, or
         * invalid/corrupted JSON).  Returning null is safe — callers treat it as
         * "key not found" and proceed without that piece of state.
         *
         * Note: JSON.parse with BufferJSON.reviver reconstructs Buffer values that
         * were serialised by writeData.
         */
        const readData = async (file: string) => {
                const filePath = join(folder, fixFileName(file)!)
                const mutex = getFileLock(filePath)

                return mutex.acquire().then(async release => {
                        try {
                                const data = await readFile(filePath, { encoding: 'utf-8' })

                                // Guard against truncated or corrupted JSON files.
                                // A write that was interrupted mid-way can leave an empty or
                                // partially-written file — these would throw on JSON.parse.
                                if (!data || data.trim().length === 0) {
                                        return null
                                }

                                return JSON.parse(data, BufferJSON.reviver)
                        } catch (error) {
                                // Swallow all read/parse errors — a missing or corrupt key is
                                // treated the same as "not yet set" by Signal's key store.
                                return null
                        } finally {
                                release()
                        }
                })
        }

        /**
         * Delete a key file (called when a Signal key is consumed / invalidated).
         * Errors are silently swallowed — if the file doesn't exist, that's fine.
         */
        const removeData = async (file: string) => {
                try {
                        const filePath = join(folder, fixFileName(file)!)
                        const mutex = getFileLock(filePath)

                        return mutex.acquire().then(async release => {
                                try {
                                        await unlink(filePath)
                                } catch {
                                        // File may already be gone — ignore
                                } finally {
                                        release()
                                }
                        })
                } catch {
                        // Ignore errors from path building, etc.
                }
        }

        // ── Folder Setup ──────────────────────────────────────────────────────

        const folderInfo = await stat(folder).catch(() => {})
        if (folderInfo) {
                if (!folderInfo.isDirectory()) {
                        // Something already exists at this path but it's not a folder.
                        // This is almost certainly a mistake — tell the user clearly.
                        throw new Error(
                                `Expected a directory at "${folder}" but found a file. ` +
                                `Either delete it or pass a different folder path to useMultiFileAuthState().`
                        )
                }
        } else {
                // Folder doesn't exist yet — create it (and any parent folders)
                await mkdir(folder, { recursive: true })
        }

        // ── File Name Sanitisation ─────────────────────────────────────────────

        /**
         * Make a Signal key ID safe to use as a filename.
         *   '/' → '__'   (slashes in base64 keys would create subdirectories)
         *   ':' → '-'    (colons in JIDs are illegal in Windows filenames)
         */
        const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

        // ── Load Existing Credentials ─────────────────────────────────────────

        // Try to load credentials from disk.  If the file doesn't exist (first run)
        // or is corrupt, generate a fresh set of credentials.
        const creds: AuthenticationCreds = (await readData('creds.json')) || initAuthCreds()

        // ── Return the AuthenticationState ────────────────────────────────────

        return {
                state: {
                        creds,
                        keys: {
                                /**
                                 * Retrieve Signal key values by type and ID.
                                 *
                                 * Called by the Signal repository (libsignal.ts) when it needs
                                 * pre-keys, session keys, sender keys, or app-state sync keys.
                                 *
                                 * @param type - Key category (e.g. 'pre-key', 'session', 'sender-key')
                                 * @param ids  - Array of key IDs to fetch
                                 * @returns Map of id → value (missing keys are simply absent)
                                 */
                                get: async (type, ids) => {
                                        const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
                                        await Promise.all(
                                                ids.map(async id => {
                                                        let value = await readData(`${type}-${id}.json`)

                                                        // app-state-sync-key values are proto messages — decode them
                                                        if (type === 'app-state-sync-key' && value) {
                                                                value = proto.Message.AppStateSyncKeyData.fromObject(value)
                                                        }

                                                        data[id] = value
                                                })
                                        )

                                        return data
                                },

                                /**
                                 * Persist Signal key values by type and ID.
                                 *
                                 * Called whenever the Signal library generates new keys
                                 * (e.g. after a successful ratchet step, pre-key consumption, etc.).
                                 * A null/undefined value means "delete this key".
                                 *
                                 * @param data - Nested map of { type: { id: value | null } }
                                 */
                                set: async data => {
                                        const tasks: Promise<void>[] = []
                                        for (const category in data) {
                                                for (const id in data[category as keyof SignalDataTypeMap]) {
                                                        const value = data[category as keyof SignalDataTypeMap]![id]
                                                        const file = `${category}-${id}.json`
                                                        // null/undefined → delete the file; anything else → write it
                                                        tasks.push(value ? writeData(value, file) : removeData(file))
                                                }
                                        }

                                        // Run all writes in parallel for speed
                                        await Promise.all(tasks)
                                }
                        }
                },

                /**
                 * saveCreds — Write the current credentials object to creds.json.
                 *
                 * Must be called every time the 'creds.update' event fires, or
                 * the session will be missing changes (e.g. new pre-key IDs, me.id)
                 * and will fail to reconnect after restart.
                 *
                 * @example
                 *   sock.ev.on('creds.update', saveCreds)
                 */
                saveCreds: async () => {
                        return writeData(creds, 'creds.json')
                }
        }
}
