import logger from '../utils/logger.js';

export class CommandRouter {
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
        for (const alias of entry.aliases) this.commands.set(alias.toLowerCase(), entry);
    }

    async handle(sock, message) {
        const body = message.message?.conversation
            || message.message?.extendedTextMessage?.text
            || '';

        if (!body.startsWith(this.prefix)) return;

        const [rawCmd, ...args] = body.slice(this.prefix.length).trim().split(/\s+/);
        const entry = this.commands.get(rawCmd.toLowerCase());
        if (!entry) return;

        const jid = message.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const sender = isGroup ? (message.key.participant || message.participant) : jid;

        let isAdmin = false;
        if (isGroup) {
            try {
                const meta = await sock.groupMetadata(jid);
                isAdmin = meta.participants.some(p => p.jid === sender && ['admin', 'superadmin'].includes(p.admin));
            } catch { isAdmin = false; }
        }

        if (entry.groupOnly && !isGroup) {
            return sock.sendMessage(jid, { text: '⛔ This command can only be used in groups.' }, { quoted: message });
        }
        if (entry.adminOnly && !isAdmin) {
            return sock.sendMessage(jid, { text: '⛔ This command is admin only.' }, { quoted: message });
        }

        logger.info(`⚡ Command ${rawCmd.toLowerCase()} triggered by ${sender}`);
        try {
            await entry.handler({ sock, message, args, sender, isGroup, isAdmin });
        } catch (err) {
            logger.error(`Error in command ${rawCmd}:`, err.message);
        }
    }
}
