/**
 * SilentWolf v1.0 — WhatsApp Bot Library
 * Built on Baileys (bundled) | ES Module
 *
 * Usage:
 *   import { createBot } from 'silentwolf';
 *   const { sock, sender, router, store } = await createBot({ prefix: '!' });
 */

const NEON  = "\x1b[38;2;57;255;20m";
const RESET = "\x1b[0m";

console.log(`${NEON}
╔══════════════════════════════════════╗
║   🐺  S I L E N T  W O L F  v1.0   ║
║   WhatsApp Bot Library               ║
║   Built for hunters. Ready to hunt. ║
╚══════════════════════════════════════╝
${RESET}`);

// ── SilentWolf core ───────────────────────────────────────────
export { connectToWhatsApp }                            from './src/socket/connection.js';
export { MessageSender }                                from './src/messages/sender.js';
export { CommandRouter }                                from './src/commands/router.js';
export { MessageStore }                                 from './src/store/messageStore.js';
export { loadAuthState }                                from './src/auth/authState.js';
export { exportSession, importSession, isSessionValid } from './src/auth/sessionManager.js';
export { startKeepAlive }                               from './src/utils/keepAlive.js';
export { default as logger }                            from './src/utils/logger.js';

// ── Baileys utilities — re-exported for consumer use ──────────
export {
    // JID helpers
    isJidGroup,
    isJidBroadcast,
    isJidNewsletter,
    isJidStatusBroadcast,
    isJidBot,
    jidDecode,
    jidNormalizedUser,
    areJidsSameUser,

    // Message helpers
    getContentType,
    extractMessageContent,
    normalizeMessageContent,
    downloadMediaMessage,
    downloadContentFromMessage,
    generateMessageIDV2,
    getAggregateVotesInPollMessage,

    // Connection helpers
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,

    // Config
    Browsers,
    DisconnectReason,
    UNAUTHORIZED_CODES,
    DEFAULT_CACHE_TTLS,

    // Proto
    proto,
} from './lib/index.js';

// ── Factory ───────────────────────────────────────────────────

export async function createBot(options = {}) {
    const { connectToWhatsApp } = await import('./src/socket/connection.js');
    const { MessageSender }     = await import('./src/messages/sender.js');
    const { CommandRouter }     = await import('./src/commands/router.js');
    const { MessageStore }      = await import('./src/store/messageStore.js');

    const store = new MessageStore();

    const sock = await connectToWhatsApp({
        ...options,
        // Wire store.getMessage so Baileys can retry failed messages
        getMessage: store.getMessage.bind(store),
    });

    // Auto-capture all messages into store
    store.bind(sock);

    return {
        sock,
        sender: new MessageSender(sock),
        router: new CommandRouter(options.prefix || '!'),
        store,
    };
}
