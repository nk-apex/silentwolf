const NEON_GREEN = "\x1b[38;2;57;255;20m";
const RESET = "\x1b[0m";

console.log(`${NEON_GREEN}
🐺 Silent Wolf v1.0.0 - WhatsApp Bot Library
Built by Silent Wolf | Ready to hunt 🌙
${RESET}`);

const { connectToWhatsApp } = require('./src/socket/connection');
const { MessageSender } = require('./src/messages/sender');
const { CommandRouter } = require('./src/commands/router');
const { MessageStore } = require('./src/store/messageStore');
const { loadAuthState } = require('./src/auth/authState');
const { exportSession, importSession, isSessionValid } = require('./src/auth/sessionManager');
const { startKeepAlive } = require('./src/utils/keepAlive');
const logger = require('./src/utils/logger');

startKeepAlive();

async function main() {
    const { sock, sender, router, store } = await createBot({
        prefix: '!',
        usePairingCode: true,
        phoneNumber: '2547XXXXXXXX'  // replace with your number, country code, no +
    });

    router.register('ping', { description: 'Test if the bot is alive' }, async ({ message }) => {
        const jid = message.key.remoteJid;
        await sender.sendReply(jid, '🐺 Pong! Silent Wolf is alive and hunting!', message);
    });

    router.register('hi', { description: 'Greet the bot' }, async ({ message, sender: senderJid }) => {
        const jid = message.key.remoteJid;
        await sender.sendReply(jid, `👋 Hey there! I'm Silent Wolf 🐺 — type *!ping* to test me.`, message);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            store.save(msg.key.remoteJid, msg);
            await router.handle(sock, msg);
        }
    });

    logger.info('✅ Bot is ready! Enter the pairing code in WhatsApp and send !ping to test.');
}

async function createBot(options = {}) {
    const sock = await connectToWhatsApp(options);

    return {
        sock,
        sender: new MessageSender(sock),
        router: new CommandRouter(options.prefix || '!'),
        store: new MessageStore()
    };
}

module.exports = {
    createBot,
    connectToWhatsApp,
    MessageSender,
    CommandRouter,
    MessageStore,
    loadAuthState,
    exportSession,
    importSession,
    isSessionValid,
    startKeepAlive,
    logger
};

main();
