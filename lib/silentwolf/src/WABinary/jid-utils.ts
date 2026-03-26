/**
 * WABinary/jid-utils.ts — WhatsApp JID (Jabber ID) Utilities
 *
 * A JID is WhatsApp's unique address for every entity: users, groups,
 * broadcasts, newsletters, and bots.  Every JID has the form:
 *
 *   <user>[_<agent>][:<device>]@<server>
 *
 * Examples:
 *   "254712345678@s.whatsapp.net"       — a regular user (phone-number JID / PN JID)
 *   "254712345678:3@s.whatsapp.net"     — the same user on device #3 (multi-device)
 *   "120363424610857769@g.us"           — a group
 *   "status@broadcast"                  — WhatsApp Status (stories) broadcast
 *   "16505361212@c.us"                  — old-style JID format (legacy, rare)
 *   "99887766554433@lid"                — a Linked Identity JID (WA v7+)
 *   "1234567890@newsletter"             — a WhatsApp Newsletter channel
 *   "13135550002@c.us"                  — Meta AI bot
 *
 * WHAT IS A LID?
 * ──────────────
 * Starting with WA v7, WhatsApp uses "Linked Identity" JIDs (ending in @lid)
 * in group chats to hide participants' phone numbers for privacy.  You'll see
 * LIDs in message.key.participant for group messages.  Use
 * sock.signalRepository.lidMapping.getPNForLID(lid) to resolve them back to
 * real phone numbers (when the mapping is available).
 *
 * WHAT IS A HOSTED JID?
 * ──────────────────────
 * Business API users have JIDs ending in @hosted (PN) or @hosted.lid (LID).
 * These are WhatsApp Business API customers whose messages route through
 * Meta's hosted infrastructure rather than a personal device.
 *
 * This file exports:
 * • Constants: S_WHATSAPP_NET, STORIES_JID, META_AI_JID, etc.
 * • Types: JidServer, FullJid, WAJIDDomains
 * • Functions: jidEncode, jidDecode, jidNormalizedUser, areJidsSameUser,
 *              isJidGroup, isJidBroadcast, isLidUser, isPnUser, …
 */

/** The standard server suffix for regular WhatsApp user JIDs. */
export const S_WHATSAPP_NET = '@s.whatsapp.net'

/** JID of the official WhatsApp Business account. */
export const OFFICIAL_BIZ_JID = '16505361212@c.us'

/** JID used for server-to-client control messages. */
export const SERVER_JID = 'server@c.us'

/** JID of the Public Service Announcement (PSA) sender. */
export const PSA_WID = '0@c.us'

/** Special JID for the Status (stories) broadcast feed. */
export const STORIES_JID = 'status@broadcast'

/** JID of the Meta AI chatbot (matches the botRegexp pattern below). */
export const META_AI_JID = '13135550002@c.us'

/**
 * All valid server suffixes that can appear after the @ in a JID.
 *
 * • 'c.us'           — legacy user format (still used by some system JIDs)
 * • 'g.us'           — group
 * • 'broadcast'      — broadcast list or status@broadcast
 * • 's.whatsapp.net' — standard modern user JID
 * • 'call'           — used for in-call signalling
 * • 'lid'            — Linked Identity (WA v7 privacy feature)
 * • 'newsletter'     — WhatsApp Newsletter channel
 * • 'bot'            — Meta AI bot accounts
 * • 'hosted'         — WhatsApp Business API (phone-number form)
 * • 'hosted.lid'     — WhatsApp Business API (LID form)
 */
export type JidServer =
        | 'c.us'
        | 'g.us'
        | 'broadcast'
        | 's.whatsapp.net'
        | 'call'
        | 'lid'
        | 'newsletter'
        | 'bot'
        | 'hosted'
        | 'hosted.lid'

/**
 * Numeric domain types embedded in binary JIDs (used in the Noise wire format).
 *
 * These values appear as the optional `_<agent>` portion of a JID string when
 * the binary protocol encodes them, or are inferred from the server suffix.
 */
export enum WAJIDDomains {
        WHATSAPP = 0,    // standard WhatsApp user / group
        LID = 1,         // Linked Identity
        HOSTED = 128,    // Business API (phone-number)
        HOSTED_LID = 129 // Business API (LID)
}

/** A JID decoded to its user and optional device parts (server excluded). */
export type JidWithDevice = {
        user: string
        device?: number
}

/** A fully decoded JID including user, device, server, and numeric domain type. */
export type FullJid = JidWithDevice & {
        server: JidServer
        domainType?: number
}

/**
 * Derive the JidServer string from a numeric domain type.
 *
 * WhatsApp's binary protocol encodes the domain type as a number.  This
 * function converts it back to the human-readable server suffix used in
 * string JIDs.
 *
 * @param initialServer - The server string already present in the JID (fallback)
 * @param domainType    - The numeric WAJIDDomains value (if any)
 */
export const getServerFromDomainType = (initialServer: string, domainType?: WAJIDDomains): JidServer => {
        switch (domainType) {
                case WAJIDDomains.LID:
                        return 'lid'
                case WAJIDDomains.HOSTED:
                        return 'hosted'
                case WAJIDDomains.HOSTED_LID:
                        return 'hosted.lid'
                case WAJIDDomains.WHATSAPP:
                default:
                        // No override — use whatever server string was already present
                        return initialServer as JidServer
        }
}

/**
 * Build a JID string from its parts.
 *
 * @param user   - The user/group identifier (phone number, group ID, etc.)
 * @param server - The server suffix (e.g. 's.whatsapp.net', 'g.us', 'lid')
 * @param device - Optional device index for multi-device sessions (e.g. 3)
 * @param agent  - Optional agent/domain type number (rare, used in binary protocol)
 *
 * @example
 *   jidEncode('254712345678', 's.whatsapp.net')      // "254712345678@s.whatsapp.net"
 *   jidEncode('254712345678', 's.whatsapp.net', 3)   // "254712345678:3@s.whatsapp.net"
 *   jidEncode('120363424610857769', 'g.us')          // "120363424610857769@g.us"
 */
export const jidEncode = (user: string | number | null, server: JidServer, device?: number, agent?: number) => {
        return `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`
}

/**
 * Parse a JID string into its component parts.
 *
 * Returns undefined if the input is not a valid JID (no '@' separator).
 *
 * @example
 *   jidDecode('254712345678:3@s.whatsapp.net')
 *   // { user: '254712345678', device: 3, server: 's.whatsapp.net', domainType: 0 }
 *
 *   jidDecode('99887766@lid')
 *   // { user: '99887766', device: undefined, server: 'lid', domainType: 1 }
 *
 *   jidDecode('120363424@g.us')
 *   // { user: '120363424', device: undefined, server: 'g.us', domainType: 0 }
 */
export const jidDecode = (jid: string | undefined): FullJid | undefined => {
        const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1
        if (sepIdx < 0) {
                // Not a valid JID — missing the '@' separator
                return undefined
        }

        const server = jid!.slice(sepIdx + 1)          // everything after '@'
        const userCombined = jid!.slice(0, sepIdx)      // everything before '@'

        // Split on ':' to separate the user portion from the device number
        const [userAgent, device] = userCombined.split(':')
        // Split on '_' to separate the user from the agent/domain-type number
        const [user, agent] = userAgent!.split('_')

        // Determine domain type from the server string or the agent field
        let domainType = WAJIDDomains.WHATSAPP
        if (server === 'lid') {
                domainType = WAJIDDomains.LID
        } else if (server === 'hosted') {
                domainType = WAJIDDomains.HOSTED
        } else if (server === 'hosted.lid') {
                domainType = WAJIDDomains.HOSTED_LID
        } else if (agent) {
                // Binary-protocol JIDs encode domain type as the agent number
                domainType = parseInt(agent)
        }

        return {
                server: server as JidServer,
                user: user!,
                domainType,
                device: device ? +device : undefined
        }
}

/** Returns true if two JIDs refer to the same user (ignoring device number). */
export const areJidsSameUser = (jid1: string | undefined, jid2: string | undefined) =>
        jidDecode(jid1)?.user === jidDecode(jid2)?.user

/** Returns true if the JID is a Meta AI bot (@bot domain or matching number pattern). */
export const isJidMetaAI = (jid: string | undefined) => jid?.endsWith('@bot')

/** Returns true if this is a standard user JID (phone-number, @s.whatsapp.net). */
export const isPnUser = (jid: string | undefined) => jid?.endsWith('@s.whatsapp.net')

/** Returns true if this is a Linked Identity JID (@lid, used in WA v7 group messages). */
export const isLidUser = (jid: string | undefined) => jid?.endsWith('@lid')

/** Returns true if this is a broadcast list JID (@broadcast). */
export const isJidBroadcast = (jid: string | undefined) => jid?.endsWith('@broadcast')

/** Returns true if this is a group JID (@g.us). */
export const isJidGroup = (jid: string | undefined) => jid?.endsWith('@g.us')

/** Returns true if this is exactly "status@broadcast" (the Stories feed). */
export const isJidStatusBroadcast = (jid: string) => jid === 'status@broadcast'

/** Returns true if this is a Newsletter channel JID (@newsletter). */
export const isJidNewsletter = (jid: string | undefined) => jid?.endsWith('@newsletter')

/** Returns true if this is a WhatsApp Business API user JID (@hosted). */
export const isHostedPnUser = (jid: string | undefined) => jid?.endsWith('@hosted')

/** Returns true if this is a WhatsApp Business API LID JID (@hosted.lid). */
export const isHostedLidUser = (jid: string | undefined) => jid?.endsWith('@hosted.lid')

/**
 * Matches Meta AI bot phone numbers.
 * Pattern: 1313555xxxx (Meta AI) or 131655500xx (other AI bots).
 */
const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/

/**
 * Returns true if the JID is an AI bot account.
 * Checks both the @c.us server suffix and the phone-number pattern.
 */
export const isJidBot = (jid: string | undefined) => jid && botRegexp.test(jid.split('@')[0]!) && jid.endsWith('@c.us')

/**
 * Normalize a JID to its canonical user form (strips device number, converts
 * old @c.us format to @s.whatsapp.net).
 *
 * This is useful when you want to compare or store a JID without caring which
 * specific device it came from.
 *
 * @example
 *   jidNormalizedUser('254712345678:3@s.whatsapp.net')  // "254712345678@s.whatsapp.net"
 *   jidNormalizedUser('254712345678@c.us')               // "254712345678@s.whatsapp.net"
 *   jidNormalizedUser('120363424@g.us')                  // "120363424@g.us"  (unchanged)
 */
export const jidNormalizedUser = (jid: string | undefined) => {
        const result = jidDecode(jid)
        if (!result) {
                return ''
        }

        const { user, server } = result
        // Convert legacy @c.us format → modern @s.whatsapp.net; leave everything else as-is
        return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : (server as JidServer))
}

/**
 * Copy the device number from one JID and apply it to another JID.
 *
 * Used internally to transfer the sender's device index to an alt JID
 * (e.g. copy device from a PN JID to its corresponding LID JID).
 *
 * @example
 *   transferDevice('254712345678:3@s.whatsapp.net', '99887766@lid')
 *   // "99887766:3@lid"
 */
export const transferDevice = (fromJid: string, toJid: string) => {
        const fromDecoded = jidDecode(fromJid)
        const deviceId = fromDecoded?.device || 0   // default to device 0 if not multi-device
        const { server, user } = jidDecode(toJid)!
        return jidEncode(user, server, deviceId)
}
