import logger from '../utils/logger.js';

export class MessageSender {
    constructor(sock) { this.sock = sock; }

    async sendText(jid, text) {
        try { await this.sock.sendMessage(jid, { text }); }
        catch (err) { logger.error(`Failed to send text to ${jid}:`, err.message); }
    }

    async sendReply(jid, text, quotedMessage) {
        try { await this.sock.sendMessage(jid, { text }, { quoted: quotedMessage }); }
        catch (err) { logger.error(`Failed to send reply to ${jid}:`, err.message); }
    }

    async sendImage(jid, imageBuffer, caption = '') {
        try { await this.sock.sendMessage(jid, { image: imageBuffer, caption }); }
        catch (err) { logger.error(`Failed to send image to ${jid}:`, err.message); }
    }

    async sendVideo(jid, videoBuffer, caption = '') {
        try { await this.sock.sendMessage(jid, { video: videoBuffer, caption }); }
        catch (err) { logger.error(`Failed to send video to ${jid}:`, err.message); }
    }

    async sendDocument(jid, buffer, filename, mimetype) {
        try { await this.sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype }); }
        catch (err) { logger.error(`Failed to send document to ${jid}:`, err.message); }
    }

    async sendReaction(jid, messageKey, emoji) {
        try { await this.sock.sendMessage(jid, { react: { text: emoji, key: messageKey } }); }
        catch (err) { logger.error(`Failed to send reaction to ${jid}:`, err.message); }
    }
}
