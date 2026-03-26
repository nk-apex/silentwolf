/**
 * Socket/index.ts — makeWASocket: The Top-Level Socket Factory
 *
 * This is the single function users call to get a connected WhatsApp socket.
 * It merges the user's partial config with the library's defaults, then hands
 * control to the middleware chain starting at makeCommunitiesSocket.
 *
 * WHY IS THERE A CHAIN OF makeXxxSocket FUNCTIONS?
 * ─────────────────────────────────────────────────
 * Rather than having one enormous file with every WhatsApp feature, the code is
 * split into focused layers, each building on the last:
 *
 *   makeWASocket  (this file — just merges config)
 *     └─ makeCommunitiesSocket  (Socket/communities.ts)
 *        └─ makeGroupsSocket     (Socket/groups.ts)
 *           └─ makeBusinessSocket (Socket/business.ts)
 *              └─ makeNewsletterSocket (Socket/newsletter.ts)
 *                 └─ makeChatsSocket   (Socket/chats.ts)
 *                    └─ makeMessagesRecvSocket  (Socket/messages-recv.ts)
 *                       └─ makeMessagesSendSocket (Socket/messages-send.ts)
 *                          └─ makeSocket  (Socket/socket.ts) ← raw WebSocket
 *
 * Each makeXxxSocket function calls the next one in the chain, receives its
 * return value, adds its own methods/event handlers, and returns the combined
 * object.  JavaScript's spread operator ({...lowerLayer, newMethod}) makes this
 * work cleanly.  The final object has ALL methods from ALL layers.
 *
 * CONFIG DEFAULTS
 * ───────────────
 * DEFAULT_CONNECTION_CONFIG (from Defaults/index.ts) contains the defaults for
 * every option.  The user's config is spread on top, overriding only the fields
 * they care about.  One special case: `shouldSyncHistoryMessage` defaults to a
 * function that reads `syncFullHistory` — so setting `syncFullHistory: false`
 * automatically disables history sync without the user having to wire it up.
 */

import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { makeCommunitiesSocket } from './communities'

/**
 * makeWASocket — Create and connect a WhatsApp Web socket.
 *
 * @param config - Partial socket configuration.  Must include `auth` (the
 *   AuthenticationState from useMultiFileAuthState or your own store).
 *   Every other field has a sensible default (see Defaults/index.ts).
 *
 * @returns A WASocket object with all methods:
 *   • sendMessage()           — send text, media, reactions, polls, etc.
 *   • sendPresenceUpdate()    — appear online/typing/recording
 *   • groupCreate()           — create a new group
 *   • groupFetchAllParticipating() — list all your groups
 *   • communityCreate()       — create a WhatsApp Community
 *   • newsletterCreate()      — create a Newsletter channel
 *   • ev                      — the BaileysEventEmitter (listen with ev.on)
 *   • ws                      — the underlying WebSocket (rarely needed)
 *   • user                    — your logged-in JID (available after connect)
 *   • signalRepository        — Signal keys + LID mapping
 *   … and many more (see Types/Socket.ts for the full list)
 *
 * @example
 *   import makeWASocket, { useMultiFileAuthState } from '@workspace/silentwolf'
 *
 *   const { state, saveCreds } = await useMultiFileAuthState('./auth')
 *   const sock = makeWASocket({ auth: state })
 *
 *   sock.ev.on('connection.update', ({ connection, qr }) => {
 *     if (qr) console.log('Scan this QR code:', qr)
 *     if (connection === 'open') console.log('Connected!')
 *   })
 *
 *   sock.ev.on('messages.upsert', ({ messages }) => {
 *     const msg = messages[0]
 *     const text = msg?.message?.conversation ?? ''
 *     console.log('Message from', msg.key.remoteJid, ':', text)
 *   })
 *
 *   sock.ev.on('creds.update', saveCreds)
 */
const makeWASocket = (config: UserFacingSocketConfig) => {
        // Merge user config on top of library defaults.
        // Object spread means every key in config overrides the matching default,
        // while any key not in config keeps its default value.
        const newConfig = {
                ...DEFAULT_CONNECTION_CONFIG,
                ...config
        }

        // Special case: if the user did NOT explicitly pass shouldSyncHistoryMessage,
        // derive it from the simpler `syncFullHistory` boolean flag.
        // This way the user only has to set `syncFullHistory: false` to opt out of
        // downloading the full message history on first pairing.
        if (config.shouldSyncHistoryMessage === undefined) {
                newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory
        }

        // Hand off to the top of the middleware chain.
        // By the time this returns, the WebSocket is connecting and events will start flowing.
        return makeCommunitiesSocket(newConfig)
}

export default makeWASocket
