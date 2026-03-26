/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║                  SilentWolf — Public API                 ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * This is the single entry point for the library.  Everything a consumer
 * (bot developer) needs is re-exported from here — the socket factory,
 * authentication helpers, media downloaders, Protobuf types, and all
 * TypeScript type definitions.
 *
 * ── HOW THE LIBRARY IS STRUCTURED (middleware chain) ────────
 *
 *   makeWASocket          ← you call this one function
 *     └─ makeCommunitiesSocket   (communities.ts)
 *        └─ makeGroupsSocket      (groups.ts)
 *           └─ makeBusinessSocket  (business.ts)
 *              └─ makeNewsletterSocket (newsletter.ts)
 *                 └─ makeChatsSocket   (chats.ts)
 *                    └─ makeMessagesRecvSocket  (messages-recv.ts)
 *                       └─ makeMessagesSendSocket (messages-send.ts)
 *                          └─ makeSocket  ← raw WebSocket + Noise_XX handshake
 *
 *   Each layer adds its own methods to the socket object.  The final result
 *   merges ALL layers into one object — so sock.sendMessage, sock.groupCreate,
 *   sock.communityCreate, etc. all live on the same object.
 *
 * ── KEY CONCEPTS ─────────────────────────────────────────────
 *
 *   JID   — WhatsApp address, e.g. "254712345678@s.whatsapp.net" (user)
 *             or "120363424610857769@g.us" (group)
 *
 *   LID   — Linked Identity JID introduced in WA v7.  WhatsApp now uses
 *             these opaque IDs (e.g. "99887766@lid") in group chats instead
 *             of phone numbers.  Use signalRepository.lidMapping.getPNForLID()
 *             to resolve a LID back to a real phone number.
 *
 *   proto — Compiled Protobuf definitions for every WhatsApp message type
 *             (text, image, video, audio, reaction, poll, etc.)
 *
 *   BinaryNode — The XML-like tree structure WhatsApp uses on the wire.
 *                 Most users never need to touch this directly.
 *
 * ── QUICK START ──────────────────────────────────────────────
 *
 *   import makeWASocket, { useMultiFileAuthState, DisconnectReason }
 *     from '@workspace/silentwolf'
 *
 *   const { state, saveCreds } = await useMultiFileAuthState('./auth')
 *   const sock = makeWASocket({ auth: state })
 *   sock.ev.on('creds.update', saveCreds)          // save session on every change
 *   sock.ev.on('messages.upsert', ({ messages }) => {
 *     const text = messages[0]?.message?.conversation
 *     console.log('Received:', text)
 *   })
 */

import makeWASocket from './Socket/index'

// ── Protobuf types ────────────────────────────────────────────────────────────
// Full compiled types for every WhatsApp protobuf message (IMessage, IImageMessage,
// proto.WebMessageInfo, etc.).  Use these for type-safe access to message fields.
export * from '../WAProto/index.js'

// ── Utilities ─────────────────────────────────────────────────────────────────
// All helper functions: message builders, media upload/download, crypto,
// JID utilities, auth state, event helpers, link previews, and more.
export * from './Utils/index'

// ── TypeScript types ──────────────────────────────────────────────────────────
// Every type definition the user needs: WAMessage, SocketConfig, GroupMetadata,
// BaileysEventEmitter, AuthenticationState, etc.
export * from './Types/index'

// ── Default constants ─────────────────────────────────────────────────────────
// Default configuration values, MediaType enum, pre-key counts, timeouts, etc.
export * from './Defaults/index'

// ── Binary protocol utilities ─────────────────────────────────────────────────
// JID encoding/decoding (jidDecode, jidEncode, isJidGroup, isLidUser, etc.)
// and low-level binary node manipulation (getBinaryNodeChild, etc.)
export * from './WABinary/index'

// ── WAM (WhatsApp Mobile) metrics encoding ────────────────────────────────────
// Binary Info encoding used for telemetry — most users don't need this directly.
export * from './WAM/index'

// ── USync (Universal Sync) contact/device resolution ─────────────────────────
// USyncQuery and USyncUser classes for looking up contact presence, LID mappings,
// and device lists via WhatsApp's USync API.
export * from './WAUSync/index'

// ── SilentWolf LID utilities ──────────────────────────────────────────────────
// warmLIDCache — pre-warm the LID mapping LRU cache for a list of LID JIDs.
// Call this after fetching group metadata to avoid async lookups on the first
// message from each participant.
//
//   import makeWASocket, { warmLIDCache } from '@workspace/silentwolf'
//
//   const meta = await sock.groupMetadata(groupJid)
//   const lids = meta.participants.map(p => p.lid).filter(Boolean)
//   await warmLIDCache(sock.signalRepository.lidMapping, lids)
export { warmLIDCache } from './Signal/lid-mapping'

/**
 * WASocket — the type of a fully connected WhatsApp socket.
 *
 * This is inferred automatically from makeWASocket's return type so it always
 * stays in sync.  Use it to type your socket variable:
 *
 *   let sock: WASocket
 *   sock = makeWASocket({ auth: state })
 */
export type WASocket = ReturnType<typeof makeWASocket>

/** Named export for when you prefer not to use the default import. */
export { makeWASocket }

/**
 * makeWASocket — connects to WhatsApp Web and returns a socket object.
 *
 * This is the ONLY function you need to call to start a connection.
 * All options have sensible defaults; at minimum you must pass `auth`.
 *
 * @param config.auth         - Auth state from useMultiFileAuthState() (required)
 * @param config.browser      - How this device appears in Linked Devices list
 * @param config.logger       - Pino logger (set level:'warn' for quiet mode)
 * @param config.syncFullHistory - Pull full message history on first link (default: true)
 * @param config.markOnlineOnConnect - Appear online when connected (default: true)
 * @param config.getMessage   - Callback to retrieve a stored message by key (needed for retries)
 *
 * @returns WASocket with sendMessage, groupCreate, communityCreate, ev.on, etc.
 *
 * @example
 *   const sock = makeWASocket({
 *     auth: state,
 *     logger: pino({ level: 'warn' }),
 *     browser: Browsers.ubuntu('My Bot'),
 *   })
 */
export default makeWASocket
