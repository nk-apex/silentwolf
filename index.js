const NEON_GREEN = "\x1b[38;2;57;255;20m";
const RESET = "\x1b[0m";

console.log(`${NEON_GREEN}
╔══════════════════════════════════════╗
║   🐺  S I L E N T  W O L F  v1.0   ║
║   WhatsApp Bot Library               ║
║   Built for hunters. Ready to hunt. ║
╚══════════════════════════════════════╝
${RESET}`);

export { connectToWhatsApp }   from './src/socket/connection.js';
export { MessageSender }        from './src/messages/sender.js';
export { CommandRouter }        from './src/commands/router.js';
export { MessageStore }         from './src/store/messageStore.js';
export { loadAuthState }        from './src/auth/authState.js';
export { exportSession, importSession, isSessionValid } from './src/auth/sessionManager.js';
export { startKeepAlive }       from './src/utils/keepAlive.js';
export { default as logger }    from './src/utils/logger.js';

export async function createBot(options = {}) {
    const { connectToWhatsApp } = await import('./src/socket/connection.js');
    const { MessageSender }     = await import('./src/messages/sender.js');
    const { CommandRouter }     = await import('./src/commands/router.js');
    const { MessageStore }      = await import('./src/store/messageStore.js');

    const sock = await connectToWhatsApp(options);
    return {
        sock,
        sender: new MessageSender(sock),
        router: new CommandRouter(options.prefix || '!'),
        store:  new MessageStore()
    };
}
