const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MAX_MESSAGES = 1000;

class MessageStore {
    constructor() {
        this.store = new Map();
    }

    save(jid, message) {
        if (!this.store.has(jid)) {
            this.store.set(jid, new Map());
        }

        const chat = this.store.get(jid);
        const messageId = message.key?.id;

        if (!messageId) return;

        chat.set(messageId, message);
        logger.debug(`💾 Saved message ${messageId} for ${jid}`);

        if (chat.size > MAX_MESSAGES) {
            const oldestKey = chat.keys().next().value;
            chat.delete(oldestKey);
            logger.warn(`♻️ Evicted oldest message from ${jid} (limit: ${MAX_MESSAGES})`);
        }
    }

    getById(jid, messageId) {
        return this.store.get(jid)?.get(messageId) || null;
    }

    getHistory(jid, limit) {
        const chat = this.store.get(jid);
        if (!chat) return [];

        const messages = Array.from(chat.values());
        return limit ? messages.slice(-limit) : messages;
    }

    delete(jid, messageId) {
        const chat = this.store.get(jid);
        if (!chat) return;
        chat.delete(messageId);
    }

    clear(jid) {
        this.store.delete(jid);
    }

    persistToDisk(folderPath) {
        try {
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
            }

            const serializable = {};
            for (const [jid, chat] of this.store.entries()) {
                serializable[jid] = Array.from(chat.entries());
            }

            const filePath = path.join(folderPath, 'message_store.json');
            fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf-8');
            logger.info(`💿 Message store persisted to ${filePath}`);
        } catch (err) {
            logger.error('Failed to persist message store:', err.message);
        }
    }

    loadFromDisk(folderPath) {
        try {
            const filePath = path.join(folderPath, 'message_store.json');

            if (!fs.existsSync(filePath)) {
                logger.warn(`📂 No message store found at ${filePath}, starting fresh.`);
                return;
            }

            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);

            for (const [jid, entries] of Object.entries(parsed)) {
                this.store.set(jid, new Map(entries));
            }

            logger.info(`📂 Message store loaded from ${filePath}`);
        } catch (err) {
            logger.error('Failed to load message store:', err.message);
        }
    }
}

module.exports = { MessageStore };
