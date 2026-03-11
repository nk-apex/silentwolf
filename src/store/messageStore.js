import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const MAX_MESSAGES = 1000;

export class MessageStore {
    constructor() { this.store = new Map(); }

    save(jid, message) {
        if (!this.store.has(jid)) this.store.set(jid, new Map());
        const chat = this.store.get(jid);
        const id = message.key?.id;
        if (!id) return;
        chat.set(id, message);
        if (chat.size > MAX_MESSAGES) {
            chat.delete(chat.keys().next().value);
            logger.warn(`♻️ Evicted oldest message from ${jid}`);
        }
    }

    getById(jid, messageId) { return this.store.get(jid)?.get(messageId) || null; }

    getHistory(jid, limit) {
        const msgs = Array.from(this.store.get(jid)?.values() || []);
        return limit ? msgs.slice(-limit) : msgs;
    }

    delete(jid, messageId) { this.store.get(jid)?.delete(messageId); }
    clear(jid) { this.store.delete(jid); }

    persistToDisk(folderPath) {
        try {
            fs.mkdirSync(folderPath, { recursive: true });
            const data = {};
            for (const [jid, chat] of this.store) data[jid] = [...chat.entries()];
            const file = path.join(folderPath, 'message_store.json');
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
            logger.info(`💿 Store saved to ${file}`);
        } catch (err) { logger.error('Failed to persist store:', err.message); }
    }

    loadFromDisk(folderPath) {
        try {
            const file = path.join(folderPath, 'message_store.json');
            if (!fs.existsSync(file)) { logger.warn('📂 No store found, starting fresh.'); return; }
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            for (const [jid, entries] of Object.entries(data)) this.store.set(jid, new Map(entries));
            logger.info(`📂 Store loaded from ${file}`);
        } catch (err) { logger.error('Failed to load store:', err.message); }
    }
}
