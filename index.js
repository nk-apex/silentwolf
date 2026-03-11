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
