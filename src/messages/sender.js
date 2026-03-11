/**
 * SilentWolf — sender.js
 *
 * Full-featured message sender built on Baileys.
 * Uses generateMessageIDV2 for proper unique message IDs.
 */

import { generateMessageIDV2 } from '../../lib/index.js';
import logger from '../utils/logger.js';

export class MessageSender {
    constructor(sock) {
        this.sock = sock;
    }

    // ── Core ─────────────────────────────────────────────────────

    async sendText(jid, text, options = {}) {
        try {
            return await this.sock.sendMessage(jid, { text }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendText failed [${jid}]:`, err.message); }
    }

    async sendReply(jid, text, quotedMessage, options = {}) {
        try {
            return await this.sock.sendMessage(jid, { text }, {
                quoted: quotedMessage,
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendReply failed [${jid}]:`, err.message); }
    }

    // ── Media ────────────────────────────────────────────────────

    async sendImage(jid, image, caption = '', options = {}) {
        try {
            return await this.sock.sendMessage(jid, { image, caption }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendImage failed [${jid}]:`, err.message); }
    }

    async sendVideo(jid, video, caption = '', options = {}) {
        try {
            return await this.sock.sendMessage(jid, { video, caption }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendVideo failed [${jid}]:`, err.message); }
    }

    async sendAudio(jid, audio, ptt = false, options = {}) {
        // ptt = true sends as voice note
        try {
            return await this.sock.sendMessage(jid, { audio, ptt, mimetype: 'audio/mp4' }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendAudio failed [${jid}]:`, err.message); }
    }

    async sendDocument(jid, document, fileName, mimetype, options = {}) {
        try {
            return await this.sock.sendMessage(jid, { document, fileName, mimetype }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendDocument failed [${jid}]:`, err.message); }
    }

    async sendSticker(jid, sticker, options = {}) {
        try {
            return await this.sock.sendMessage(jid, { sticker }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendSticker failed [${jid}]:`, err.message); }
    }

    // ── Interactive ──────────────────────────────────────────────

    async sendReaction(jid, messageKey, emoji) {
        try {
            return await this.sock.sendMessage(jid, {
                react: { text: emoji, key: messageKey }
            });
        } catch (err) { logger.error(`sendReaction failed [${jid}]:`, err.message); }
    }

    async sendPoll(jid, name, values, selectableCount = 1, options = {}) {
        // values = array of strings e.g. ['Yes', 'No', 'Maybe']
        try {
            return await this.sock.sendMessage(jid, {
                poll: { name, values, selectableCount }
            }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendPoll failed [${jid}]:`, err.message); }
    }

    async sendLocation(jid, latitude, longitude, name = '', address = '', options = {}) {
        try {
            return await this.sock.sendMessage(jid, {
                location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address }
            }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendLocation failed [${jid}]:`, err.message); }
    }

    async sendContact(jid, displayName, contactNumber, options = {}) {
        // contactNumber must be in full format e.g. +254712345678
        const vcard =
            `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\n` +
            `TEL;type=CELL;type=VOICE;waid=${contactNumber.replace(/\D/g, '')}:${contactNumber}\nEND:VCARD`;
        try {
            return await this.sock.sendMessage(jid, {
                contacts: { displayName, contacts: [{ vcard }] }
            }, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`sendContact failed [${jid}]:`, err.message); }
    }

    async forward(jid, message, options = {}) {
        // Forward a received message to another jid
        try {
            const content = { forward: message };
            return await this.sock.sendMessage(jid, content, {
                messageId: generateMessageIDV2(this.sock.user?.id),
                ...options
            });
        } catch (err) { logger.error(`forward failed [${jid}]:`, err.message); }
    }

    // ── Presence ──────────────────────────────────────────────────

    async sendTyping(jid) {
        try { await this.sock.sendPresenceUpdate('composing', jid); }
        catch (err) { logger.error(`sendTyping failed:`, err.message); }
    }

    async sendRecording(jid) {
        try { await this.sock.sendPresenceUpdate('recording', jid); }
        catch (err) { logger.error(`sendRecording failed:`, err.message); }
    }

    async stopTyping(jid) {
        try { await this.sock.sendPresenceUpdate('paused', jid); }
        catch (err) { logger.error(`stopTyping failed:`, err.message); }
    }

    // ── Read receipts ─────────────────────────────────────────────

    async markAsRead(keys) {
        // keys = array of WAMessageKey objects
        try { await this.sock.readMessages(keys); }
        catch (err) { logger.error(`markAsRead failed:`, err.message); }
    }
}
