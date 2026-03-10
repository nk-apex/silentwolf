const logger = require('../utils/logger');

class CommandRouter {
    constructor(prefix = '!') {
        this.prefix = prefix;
        this.commands = new Map();
    }

    register(commandName, options = {}, handler) {
        const entry = {
            handler,
            description: options.description || '',
            aliases: options.aliases || [],
            adminOnly: options.adminOnly || false,
            groupOnly: options.groupOnly || false
        };

        this.commands.set(commandName.toLowerCase(), entry);

        for (const alias of entry.aliases) {
            this.commands.set(alias.toLowerCase(), entry);
        }
    }

    async handle(sock, message) {
        const body = message.message?.conversation
            || message.message?.extendedTextMessage?.text
            || '';

        if (!body.startsWith(this.prefix)) return;

        const [rawCommand, ...args] = body.slice(this.prefix.length).trim().split(/\s+/);
        const commandName = rawCommand.toLowerCase();
        const entry = this.commands.get(commandName);

        if (!entry) return;

        const jid = message.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const sender = isGroup
            ? message.key.participant || message.participant
            : message.key.remoteJid;

        let isAdmin = false;
        if (isGroup) {
            try {
                const groupMeta = await sock.groupMetadata(jid);
                isAdmin = groupMeta.participants.some(
                    p => p.jid === sender && (p.admin === 'admin' || p.admin === 'superadmin')
                );
            } catch {
                isAdmin = false;
            }
        }

        if (entry.groupOnly && !isGroup) {
            await sock.sendMessage(jid, { text: '⛔ This command can only be used in groups.' }, { quoted: message });
            return;
        }

        if (entry.adminOnly && !isAdmin) {
            await sock.sendMessage(jid, { text: '⛔ This command is admin only.' }, { quoted: message });
            return;
        }

        logger.info(`⚡ Command ${commandName} triggered by ${sender}`);

        try {
            await entry.handler({ sock, message, args, sender, isGroup, isAdmin });
        } catch (err) {
            logger.error(`Error executing command ${commandName}:`, err.message);
        }
    }
}

module.exports = { CommandRouter };
