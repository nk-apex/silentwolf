/**
 * SilentWolf — messageStore.js
 *
 * In-memory message store with:
 * - bind(sock) to auto-capture all messages via sock.ev.process()
 * - getMessage(key) callback compatible with Baileys' retry system
 * - Disk persistence
 * - LRU eviction at MAX_MESSAGES per chat
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const MAX_MESSAGES = 1000;

export class MessageStore {
    constructor() {
        this.store    = new Map(); // jid => Map(messageId => message)
        this.contacts = {};
        this.chats    = {};
    }

    // ── Bind to socket — auto-saves all incoming messages ────────

    bind(sock) {
        sock.ev.process(async (events) => {

            if (events['messages.upsert']) {
                const { messages } = events['messages.upsert'];
                for (const msg of messages) {
                    if (msg.key?.remoteJid) this.save(msg.key.remoteJid, msg);
                }
            }

            if (events['messages.update']) {
                for (const update of events['messages.update']) {
                    const { key, update: upd } = update;
                    const existing = this.getById(key.remoteJid, key.id);
                    if (existing) {
                        this.save(key.remoteJid, { ...existing, ...upd });
                    }
                }
            }

            if (events['contacts.upsert']) {
                for (const contact of events['contacts.upsert']) {
                    this.contacts[contact.id] = contact;
                }
            }

            if (events['chats.upsert']) {
                for (const chat of events['chats.upsert']) {
                    this.chats[chat.id] = chat;
                }
            }
        });

        logger.info('📦 MessageStore bound to socket');
        return this;
    }

    // ── getMessage — used as Baileys retry callback ───────────────
    // Pass as: connectToWhatsApp({ getMessage: store.getMessage.bind(store) })

    async getMessage(key) {
        const msg = this.getById(key.remoteJid, key.id);
        return msg?.message || undefined;
    }

    // ── Core store operations ─────────────────────────────────────

    save(jid, message) {
        if (!this.store.has(jid)) this.store.set(jid, new Map());
        const chat = this.store.get(jid);
        const id   = message.key?.id;
        if (!id) return;

        chat.set(id, message);

        if (chat.size > MAX_MESSAGES) {
            chat.delete(chat.keys().next().value);
            logger.warn(`♻️ Evicted oldest message from ${jid}`);
        }
    }

    getById(jid, messageId) {
        return this.store.get(jid)?.get(messageId) || null;
    }

    getHistory(jid, limit) {
        const msgs = Array.from(this.store.get(jid)?.values() || []);
        return limit ? msgs.slice(-limit) : msgs;
    }

    delete(jid, messageId) { this.store.get(jid)?.delete(messageId); }
    clear(jid)             { this.store.delete(jid); }

    // ── Disk persistence ──────────────────────────────────────────

    persistToDisk(folderPath) {
        try {
            fs.mkdirSync(folderPath, { recursive: true });
            const data = {};
            for (const [jid, chat] of this.store) data[jid] = [...chat.entries()];
            const file = path.join(folderPath, 'message_store.json');
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
            logger.info(`💿 Store saved → ${file}`);
        } catch (err) { logger.error('persistToDisk failed:', err.message); }
    }

    loadFromDisk(folderPath) {
        try {
            const file = path.join(folderPath, 'message_store.json');
            if (!fs.existsSync(file)) { logger.warn('📂 No store found, starting fresh.'); return; }
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            for (const [jid, entries] of Object.entries(data)) {
                this.store.set(jid, new Map(entries));
            }
            logger.info(`📂 Store loaded ← ${file}`);
        } catch (err) { logger.error('loadFromDisk failed:', err.message); }
    }
}
