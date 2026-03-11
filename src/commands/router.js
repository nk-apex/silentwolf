/**
 * SilentWolf — router.js
 *
 * Command router with:
 * - Newsletter + broadcast JID filtering
 * - Admin and group-only guards
 * - Alias support
 * - Full context passed to handlers
 */

import { isJidNewsletter, isJidStatusBroadcast, isJidBroadcast } from '../../lib/index.js';
import logger from '../utils/logger.js';

export class CommandRouter {
    constructor(prefix = '!') {
        this.prefix   = prefix;
        this.commands = new Map();
    }

    register(commandName, options = {}, handler) {
        const entry = {
            handler,
            description: options.description || '',
            aliases:     options.aliases     || [],
            adminOnly:   options.adminOnly   || false,
            groupOnly:   options.groupOnly   || false,
            privateOnly: options.privateOnly || false,
        };

        this.commands.set(commandName.toLowerCase(), entry);
        for (const alias of entry.aliases) {
            this.commands.set(alias.toLowerCase(), entry);
        }
    }

    async handle(sock, message) {
        const jid = message.key?.remoteJid;
        if (!jid) return;

        // Filter out newsletters, broadcasts, and status updates
        if (isJidNewsletter(jid))      return;
        if (isJidStatusBroadcast(jid)) return;
        if (isJidBroadcast(jid))       return;

        const body = message.message?.conversation
            || message.message?.extendedTextMessage?.text
            || message.message?.imageMessage?.caption
            || message.message?.videoMessage?.caption
            || '';

        if (!body.startsWith(this.prefix)) return;

        const [rawCmd, ...args] = body.slice(this.prefix.length).trim().split(/\s+/);
        const commandName = rawCmd.toLowerCase();
        const entry = this.commands.get(commandName);
        if (!entry) return;

        const isGroup   = jid.endsWith('@g.us');
        const sender    = isGroup
            ? (message.key.participant || message.participant)
            : jid;

        // Group/private guards
        if (entry.groupOnly && !isGroup) {
            await sock.sendMessage(jid, { text: '⛔ This command can only be used in groups.' }, { quoted: message });
            return;
        }
        if (entry.privateOnly && isGroup) {
            await sock.sendMessage(jid, { text: '⛔ This command can only be used in private chats.' }, { quoted: message });
            return;
        }

        // Admin check
        let isAdmin = false;
        if (isGroup) {
            try {
                const meta = await sock.groupMetadata(jid);
                isAdmin = meta.participants.some(
                    p => p.jid === sender && ['admin', 'superadmin'].includes(p.admin)
                );
            } catch { isAdmin = false; }
        }

        if (entry.adminOnly && !isAdmin) {
            await sock.sendMessage(jid, { text: '⛔ This command is for admins only.' }, { quoted: message });
            return;
        }

        logger.info(`⚡ !${commandName} by ${sender}`);

        try {
            await entry.handler({ sock, message, args, sender, jid, isGroup, isAdmin });
        } catch (err) {
            logger.error(`Command !${commandName} threw:`, err.message);
        }
    }
}
