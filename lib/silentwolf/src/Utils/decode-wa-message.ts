/**
 * Utils/decode-wa-message.ts — Message Decoding and Decryption Pipeline
 *
 * This file handles converting a raw WhatsApp binary stanza (BinaryNode) into
 * a fully-decoded WAMessage proto with its content decrypted.
 *
 * ── THE PIPELINE ─────────────────────────────────────────────────────────────
 *
 *   1. decodeMessageNode()  — Parse the stanza's attributes to determine:
 *        • Who sent the message (author)
 *        • Which chat it belongs to (chatId)
 *        • Whether it's from us (fromMe)
 *        • Message type: chat / group / broadcast / newsletter
 *
 *   2. decryptMessageNode() — Wraps decodeMessageNode and adds a lazy decrypt() method:
 *        • Finds <enc> or <plaintext> child nodes in the stanza
 *        • Determines the encryption type: skmsg (group) / pkmsg / msg (1:1) / plaintext
 *        • Calls the appropriate Signal repository decrypt function
 *        • Strips random padding, decodes the Protobuf message
 *        • Handles SenderKeyDistributionMessage (group key updates)
 *        • On error: marks the message as CIPHERTEXT stub type
 *
 * ── ENCRYPTION TYPES ─────────────────────────────────────────────────────────
 *
 *   pkmsg  — Pre-Key Message: first message to a recipient (uses a pre-key,
 *             establishes a new Signal session)
 *   msg    — Normal Signal message (uses the current Double Ratchet state)
 *   skmsg  — Sender Key Message: group messages (encrypted with a shared group key)
 *   plaintext — Newsletter messages or server-injected messages (not E2E encrypted)
 *
 * ── LID / PN ADDRESSING ──────────────────────────────────────────────────────
 *
 *   WhatsApp v7 supports two addressing modes:
 *   • "pn" mode:  stanza.from/participant is a PN JID; senderAlt is the LID
 *   • "lid" mode: stanza.from/participant is a LID JID; senderAlt is the PN
 *
 *   When decrypting a pkmsg/msg in PN mode, we look up the sender's LID via
 *   getDecryptionJid() — Signal sessions are keyed to the LID in WA v7.
 *   When we discover a new LID from the envelope, storeMappingFromEnvelope()
 *   persists it and migrates the Signal session automatically.
 *
 * ── VIEW-ONCE ────────────────────────────────────────────────────────────────
 *
 *   View-once messages (photos/videos that disappear after viewing) arrive with
 *   an <unavailable type="view_once"> child node when already opened on another
 *   device, or with a viewOnceMessage/V2/V2Extension wrapper in the proto.
 *   See messages-recv.ts for the full view-once interception logic.
 */

import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { WAMessage, WAMessageKey } from '../Types'
import type { SignalRepositoryWithLIDStore } from '../Types/Signal'
import {
        areJidsSameUser,
        type BinaryNode,
        isHostedLidUser,
        isHostedPnUser,
        isJidBroadcast,
        isJidGroup,
        isJidMetaAI,
        isJidNewsletter,
        isJidStatusBroadcast,
        isLidUser,
        isPnUser
} from '../WABinary'
import { unpadRandomMax16 } from './generics'
import type { ILogger } from './logger'

// ── LID Resolution ────────────────────────────────────────────────────────────

/**
 * Determine the JID to use as the Signal session key for decryption.
 *
 * In WhatsApp v7, Signal sessions are keyed to the sender's LID (not PN).
 * If the sender's JID is a PN JID, this function tries to look up their LID
 * from the local LID mapping store.  If no mapping exists yet, it falls back
 * to the PN JID so decryption can still be attempted.
 *
 * @param sender     - The sender's JID (may be PN or LID)
 * @param repository - The Signal repository (contains the LID mapping store)
 * @returns The LID JID to use for decryption, or the original sender if unknown
 */
export const getDecryptionJid = async (sender: string, repository: SignalRepositoryWithLIDStore): Promise<string> => {
        if (isLidUser(sender) || isHostedLidUser(sender)) {
                // Already a LID — use as-is
                return sender
        }

        // PN JID: try to resolve to LID for session lookup
        const mapped = await repository.lidMapping.getLIDForPN(sender)
        return mapped || sender  // fall back to PN if LID not yet known
}

/**
 * Extract and persist the LID ↔ PN mapping from an incoming message envelope.
 *
 * WhatsApp includes both the sender's PN and LID in the stanza attributes
 * (as senderAlt / participant_lid / participant_pn etc.).  We use this to keep
 * the local mapping store warm without needing USync API calls.
 *
 * Also calls repository.migrateSession() to update any existing Signal session
 * that was established under the PN JID to use the LID JID instead.
 *
 * @param stanza        - The incoming BinaryNode
 * @param sender        - The sender's primary JID (PN in "pn" addressing mode)
 * @param repository    - Signal repository for session migration
 * @param decryptionJid - The JID currently used for decryption
 * @param logger        - Logger for debug/warn output
 */
const storeMappingFromEnvelope = async (
        stanza: BinaryNode,
        sender: string,
        repository: SignalRepositoryWithLIDStore,
        decryptionJid: string,
        logger: ILogger
): Promise<void> => {
        const { senderAlt } = extractAddressingContext(stanza)

        // Only proceed when:
        //   - senderAlt is a LID JID (the LID we learned from the envelope)
        //   - sender is a PN JID (the primary address in this message)
        //   - we haven't already resolved to a LID for this sender
        if (senderAlt && isLidUser(senderAlt) && isPnUser(sender) && decryptionJid === sender) {
                try {
                        await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
                        // Migrate any existing Signal session from PN key → LID key
                        await repository.migrateSession(sender, senderAlt)
                        logger.debug({ sender, senderAlt }, 'LID mapping learnt from envelope and session migrated')
                } catch (error) {
                        logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping from envelope')
                }
        }
}

// ── Error Constants ───────────────────────────────────────────────────────────

/** Error text set on messages where no decryptable content was found in the stanza. */
export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'

/** Error text set on messages where Signal session keys are missing or already used. */
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'

/**
 * Retry configuration for transient decryption failures.
 *
 * Signal "No session record" errors happen when a message arrives before the
 * session is established.  These are safe to retry after a short delay.
 */
export const DECRYPTION_RETRY_CONFIG = {
        maxRetries: 3,
        baseDelayMs: 100,
        sessionRecordErrors: ['No session record', 'SessionError: No session record']
}

/**
 * NACK (Negative ACKnowledgement) reason codes.
 *
 * When a message cannot be processed, we send a NACK to the server with one
 * of these error codes so WhatsApp can decide whether to retransmit.
 *
 *   487 — ParsingError:          The stanza could not be parsed as valid XML
 *   488 — UnrecognizedStanza:    The stanza tag is not understood
 *   491 — InvalidProtobuf:       The decrypted bytes are not valid protobuf
 *   495 — MissingMessageSecret:  No Signal session / missing pre-key
 *   496 — SignalErrorOldCounter: The Signal ratchet counter went backwards
 *   500 — UnhandledError:        Any other unexpected error
 *   550 — UnsupportedAdminRevoke: Can't revoke admin messages (policy violation)
 *   551 — UnsupportedLIDGroup:   Can't handle this LID group message type
 *   552 — DBOperationFailed:     Key store write failed
 */
export const NACK_REASONS = {
        ParsingError: 487,
        UnrecognizedStanza: 488,
        UnrecognizedStanzaClass: 489,
        UnrecognizedStanzaType: 490,
        InvalidProtobuf: 491,
        InvalidHostedCompanionStanza: 493,
        MissingMessageSecret: 495,
        SignalErrorOldCounter: 496,
        MessageDeletedOnPeer: 499,
        UnhandledError: 500,
        UnsupportedAdminRevoke: 550,
        UnsupportedLIDGroup: 551,
        DBOperationFailed: 552
}

// ── Message Type Classification ───────────────────────────────────────────────

/**
 * Internal classification of an incoming message's origin.
 * Used to determine how to construct the WAMessageKey (chatId, author, fromMe).
 *
 *   chat          — 1:1 message between two users
 *   peer_broadcast — message in a broadcast list that WE created
 *   other_broadcast — message in someone else's broadcast list
 *   group         — group chat message
 *   direct_peer_status — a status/story update from a contact, sent directly to us
 *   other_status  — a status/story update from someone else
 *   newsletter    — a WhatsApp Newsletter post
 */
type MessageType =
        | 'chat'
        | 'peer_broadcast'
        | 'other_broadcast'
        | 'group'
        | 'direct_peer_status'
        | 'other_status'
        | 'newsletter'

// ── Addressing Context Extraction ─────────────────────────────────────────────

/**
 * Extract dual-JID addressing context from a stanza.
 *
 * WhatsApp v7 messages include both PN and LID JIDs in stanza attributes.
 * The "addressing mode" tells us which JID is the primary (in `from`/`participant`)
 * and which is the alternate (in senderAlt/recipientAlt).
 *
 * In "lid" mode:
 *   • from/participant = LID JID (e.g. "99887766@lid")
 *   • senderAlt        = PN JID  (e.g. "254712345678@s.whatsapp.net")
 *
 * In "pn" mode:
 *   • from/participant = PN JID
 *   • senderAlt        = LID JID
 *
 * @param stanza - The incoming BinaryNode
 * @returns { addressingMode, senderAlt, recipientAlt }
 */
export const extractAddressingContext = (stanza: BinaryNode) => {
        let senderAlt: string | undefined
        let recipientAlt: string | undefined

        const sender = stanza.attrs.participant || stanza.attrs.from
        // If no explicit addressing_mode, infer it from the primary JID's server suffix
        const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')

        if (addressingMode === 'lid') {
                // Primary is LID → alt is PN
                senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
                recipientAlt = stanza.attrs.recipient_pn
        } else {
                // Primary is PN → alt is LID
                senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
                recipientAlt = stanza.attrs.recipient_lid
        }

        return {
                addressingMode,
                senderAlt,
                recipientAlt
        }
}

// ── decodeMessageNode ─────────────────────────────────────────────────────────

/**
 * Parse the addressing attributes of an incoming message stanza into a WAMessage.
 *
 * This does NOT decrypt the message body — it only constructs the WAMessageKey
 * and the shell of the WAMessage (timestamps, push name, broadcast flag, etc.).
 * The actual content decryption happens in decryptMessageNode().
 *
 * ROUTING LOGIC:
 *   • from = phone/LID JID → 1:1 chat
 *   • from = @g.us          → group
 *   • from = @broadcast     → broadcast list or status feed
 *   • from = @newsletter    → Newsletter channel
 *
 * FROMME LOGIC:
 *   A message is "from me" if:
 *   • In a 1:1 chat: from == my JID (or my LID) with a recipient field set
 *   • In a group:    participant == my JID or my LID
 *   • In a broadcast/status: participant == my JID
 *
 * @param stanza - The raw BinaryNode from the WebSocket
 * @param meId   - Our own PN JID (e.g. "254712345678@s.whatsapp.net")
 * @param meLid  - Our own LID JID (e.g. "99887766@lid")
 * @returns { fullMessage, author, sender }
 *   • fullMessage — Partially-filled WAMessage (no .message content yet)
 *   • author      — The JID of who wrote the message
 *   • sender      — The JID of the Signal session to use (group JID for groups)
 */
export function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string) {
        let msgType: MessageType
        let chatId: string
        let author: string
        let fromMe = false

        const msgId = stanza.attrs.id
        const from = stanza.attrs.from
        const participant: string | undefined = stanza.attrs.participant
        const recipient: string | undefined = stanza.attrs.recipient

        const addressingContext = extractAddressingContext(stanza)

        // Convenience helpers for "is this JID me?"
        const isMe = (jid: string) => areJidsSameUser(jid, meId)
        const isMeLid = (jid: string) => areJidsSameUser(jid, meLid)

        if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from)) {
                // ── 1:1 Chat ──
                // When the message is from us to someone else, the `recipient` field
                // is set to the other party's JID (and `from` is our own JID).
                if (recipient && !isJidMetaAI(recipient)) {
                        if (!isMe(from!) && !isMeLid(from!)) {
                                // Sanity check: only our own JID should appear in `from` when recipient is set
                                throw new Boom('recipient present but message is not from me', { data: stanza })
                        }

                        fromMe = true
                        chatId = recipient  // the chat is with the recipient
                } else {
                        chatId = from!  // the chat is with the sender
                }

                msgType = 'chat'
                author = from!

        } else if (isJidGroup(from)) {
                // ── Group Chat ──
                // Group messages always have a `participant` field identifying who sent it.
                if (!participant) {
                        throw new Boom('Group message missing participant field')
                }

                if (isMe(participant) || isMeLid(participant)) {
                        fromMe = true
                }

                msgType = 'group'
                author = participant
                chatId = from!

        } else if (isJidBroadcast(from)) {
                // ── Broadcast / Status ──
                // broadcast lists and status@broadcast both use @broadcast server.
                if (!participant) {
                        throw new Boom('Broadcast message missing participant field')
                }

                const isParticipantMe = isMe(participant)
                if (isJidStatusBroadcast(from!)) {
                        // Status update: "direct" if from us, "other" if from a contact
                        msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
                } else {
                        // Broadcast list: "peer" if we own the list, "other" otherwise
                        msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
                }

                fromMe = isParticipantMe
                chatId = from!
                author = participant

        } else if (isJidNewsletter(from)) {
                // ── Newsletter Channel ──
                msgType = 'newsletter'
                chatId = from!
                author = from!

                if (isMe(from!) || isMeLid(from!)) {
                        fromMe = true
                }
        } else {
                throw new Boom(`Unknown message origin JID: "${from}"`, { data: stanza })
        }

        const pushname = stanza?.attrs?.notify  // contact's display name (push name)

        // ── Construct the WAMessageKey ──
        // The key uniquely identifies a message and is used for receipts, reactions, etc.
        const key: WAMessageKey = {
                remoteJid: chatId,
                // For 1:1 chats: include the alternate JID (LID or PN) if known
                remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
                fromMe,
                id: msgId,
                participant,
                // For groups: include the participant's alternate JID (the other addressing mode)
                participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
                addressingMode: addressingContext.addressingMode,
                // Newsletter posts have a server-assigned ID in addition to the client ID
                ...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
        }

        // ── Construct the shell WAMessage ──
        const fullMessage: WAMessage = {
                key,
                category: stanza.attrs.category,
                messageTimestamp: +stanza.attrs.t!,  // Unix timestamp in seconds
                pushName: pushname,
                broadcast: isJidBroadcast(from)
        }

        if (key.fromMe) {
                // Our own sent messages get SERVER_ACK immediately (server has it)
                fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
        }

        return {
                fullMessage,
                author,
                // For groups the Signal session is keyed to the group JID;
                // for 1:1 it's keyed to the author JID
                sender: msgType === 'chat' ? author : chatId
        }
}

// ── decryptMessageNode ────────────────────────────────────────────────────────

/**
 * Create a decryptable message wrapper around an incoming stanza.
 *
 * This function does the cheap work synchronously (routing, key building) and
 * returns a `decrypt()` method for the expensive async work (Signal crypto).
 * The caller (messages-recv.ts) calls decrypt() inside a transaction to ensure
 * atomicity of key consumption.
 *
 * WHAT DECRYPT() DOES:
 *   1. Scan stanza.content for <enc> or <plaintext> children
 *   2. For each <enc> node:
 *        a. Determine the enc type (pkmsg / msg / skmsg)
 *        b. Resolve the decryption JID (PN → LID if needed)
 *        c. Persist the LID mapping if we learn a new one from the envelope
 *        d. Call Signal repository to decrypt the ciphertext
 *        e. Unpad and decode the resulting Protobuf bytes
 *        f. Handle embedded SenderKeyDistributionMessage (group key update)
 *   3. Also handles <verified_name> (business verification badge)
 *      and <unavailable type="view_once"> (view-once already-seen marker)
 *   4. On error: mark the message as CIPHERTEXT stub (triggers a retry request)
 *
 * @param stanza     - The raw BinaryNode from the WebSocket
 * @param meId       - Our PN JID
 * @param meLid      - Our LID JID
 * @param repository - Signal crypto repository + LID mapping store
 * @param logger     - Logger for error reporting
 *
 * @returns { fullMessage, category, author, decrypt }
 *   Call `await decrypt()` to populate fullMessage.message with the decrypted proto.
 */
export const decryptMessageNode = (
        stanza: BinaryNode,
        meId: string,
        meLid: string,
        repository: SignalRepositoryWithLIDStore,
        logger: ILogger
) => {
        const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)

        return {
                fullMessage,
                category: stanza.attrs.category,
                author,

                /**
                 * Decrypt the message body from the stanza's <enc> or <plaintext> children.
                 *
                 * Mutates fullMessage.message in place.  If decryption fails, sets
                 * fullMessage.messageStubType = CIPHERTEXT so the caller can request a retry.
                 */
                async decrypt() {
                        let decryptables = 0  // count of <enc>/<plaintext> nodes found

                        if (Array.isArray(stanza.content)) {
                                for (const { tag, attrs, content } of stanza.content) {

                                        // Handle business verification badge
                                        if (tag === 'verified_name' && content instanceof Uint8Array) {
                                                const cert = proto.VerifiedNameCertificate.decode(content)
                                                const details = proto.VerifiedNameCertificate.Details.decode(cert.details!)
                                                fullMessage.verifiedBizName = details.verifiedName
                                        }

                                        // Handle view-once already-seen marker.
                                        // When the message was already opened on another device, WA replaces
                                        // the content with <unavailable type="view_once">.
                                        if (tag === 'unavailable' && attrs.type === 'view_once') {
                                                fullMessage.key.isViewOnce = true
                                        }

                                        // Record the retry count (how many times this message has been retried)
                                        if (attrs.count && tag === 'enc') {
                                                fullMessage.retryCount = Number(attrs.count)
                                        }

                                        // Only process <enc> and <plaintext> tags for decryption
                                        if (tag !== 'enc' && tag !== 'plaintext') {
                                                continue
                                        }

                                        if (!(content instanceof Uint8Array)) {
                                                continue  // malformed stanza — skip this child
                                        }

                                        decryptables += 1

                                        let msgBuffer: Uint8Array

                                        // Determine which JID the Signal session is keyed to
                                        const decryptionJid = await getDecryptionJid(author, repository)

                                        if (tag !== 'plaintext') {
                                                // For encrypted messages: try to learn the LID from the envelope
                                                // and migrate the Signal session from PN → LID if needed
                                                await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger)
                                        }

                                        try {
                                                // Determine the encryption type from the tag and attrs
                                                const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type

                                                switch (e2eType) {
                                                        case 'skmsg':
                                                                // Sender Key Message — group encryption.
                                                                // The group JID is the session identifier; authorJid identifies the group member.
                                                                msgBuffer = await repository.decryptGroupMessage({
                                                                        group: sender,
                                                                        authorJid: author,
                                                                        msg: content
                                                                })
                                                                break

                                                        case 'pkmsg':
                                                        case 'msg':
                                                                // Pre-Key Message (first contact) or normal Signal ratchet message.
                                                                // The decryptionJid is the LID (or PN if LID unknown).
                                                                msgBuffer = await repository.decryptMessage({
                                                                        jid: decryptionJid,
                                                                        type: e2eType,
                                                                        ciphertext: content
                                                                })
                                                                break

                                                        case 'plaintext':
                                                                // Newsletter messages and some server messages are not E2E encrypted.
                                                                msgBuffer = content
                                                                break

                                                        default:
                                                                throw new Error(`Unknown E2E encryption type: "${e2eType}"`)
                                                }

                                                // Strip the random 0-15 byte padding added before encryption
                                                // (padding is skipped for plaintext messages)
                                                let msg: proto.IMessage = proto.Message.decode(
                                                        e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer
                                                )

                                                // Unwrap deviceSentMessage (sent from our own device to ourselves)
                                                msg = msg.deviceSentMessage?.message || msg

                                                // Process SenderKeyDistributionMessage — this carries a new group session key.
                                                // It's usually bundled with the first message after a key rotation.
                                                if (msg.senderKeyDistributionMessage) {
                                                        try {
                                                                await repository.processSenderKeyDistributionMessage({
                                                                        authorJid: author,
                                                                        item: msg.senderKeyDistributionMessage
                                                                })
                                                        } catch (err) {
                                                                logger.error(
                                                                        { key: fullMessage.key, err },
                                                                        'Failed to process SenderKeyDistribution — group messages may fail'
                                                                )
                                                        }
                                                }

                                                // Merge the decrypted message into the running fullMessage.message
                                                // (multiple <enc> nodes can contribute to one message in retry flows)
                                                if (fullMessage.message) {
                                                        Object.assign(fullMessage.message, msg)
                                                } else {
                                                        fullMessage.message = msg
                                                }

                                        } catch (err: any) {
                                                // Log the full context so debugging is easier
                                                logger.error(
                                                        {
                                                                msgId: fullMessage.key.id,
                                                                remoteJid: fullMessage.key.remoteJid,
                                                                encType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                                                                sender,
                                                                author,
                                                                isSessionRecordError: isSessionRecordError(err),
                                                                error: err?.message || err
                                                        },
                                                        'Failed to decrypt message — marking as CIPHERTEXT stub (a retry request will be sent)'
                                                )

                                                // Mark the message as undecryptable so the caller can request a retry
                                                fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
                                                fullMessage.messageStubParameters = [err.message.toString()]
                                        }
                                }
                        }

                        // If no <enc> or <plaintext> children were found AND the message is
                        // not a view-once already-seen marker, mark it as a missing-body stub.
                        if (!decryptables && !fullMessage.key?.isViewOnce) {
                                fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
                                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
                        }
                }
        }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check if a decryption error is a "No session record" error.
 *
 * These errors happen when a message arrives before the Signal session is
 * established (e.g. the session was deleted or never created).  They are
 * transient and can be resolved by requesting a retry from the sender.
 *
 * @param error - The caught error object (any type)
 * @returns true if the error message matches a known "no session" pattern
 */
function isSessionRecordError(error: any): boolean {
        const errorMessage = error?.message || error?.toString() || ''
        return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(pattern => errorMessage.includes(pattern))
}
