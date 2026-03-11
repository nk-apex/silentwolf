/**
 * SilentWolf — connection.js
 *
 * Deep-researched Baileys best practices applied:
 * - fetchLatestBaileysVersion() for up-to-date WA version
 * - makeCacheableSignalKeyStore for faster signal processing
 * - NodeCache for msgRetryCounterCache (prevents infinite retry loops)
 * - sock.ev.process() for efficient batched event handling
 * - UNAUTHORIZED_CODES for accurate loggedOut detection
 * - Pairing code only when creds not yet registered
 * - getMessage callback for retry handling ("message can take a while" fix)
 * - cachedGroupMetadata for performance
 * - Browsers.appropriate for correct OS fingerprint
 */

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    UNAUTHORIZED_CODES
} from '../../lib/index.js';

import NodeCache from '@cacheable/node-cache';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import logger from '../utils/logger.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

export async function connectToWhatsApp(options = {}) {
    const {
        usePairingCode  = false,
        phoneNumber     = '',
        authFolder      = 'auth_info',
        countryCode     = 'US',
        getMessage      = async () => undefined,
        cachedGroupMetadata = async () => undefined,
        onConnected     = null,
        onDisconnected  = null,
    } = options;

    // 1. Load persisted auth state
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    // 2. Always fetch latest WA version — avoids 405/403 from stale versions
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Using WA v${version.join('.')} | Latest: ${isLatest}`);

    // 3. NodeCache for message retry counting — prevents infinite decrypt loops
    const msgRetryCounterCache = new NodeCache({ stdTTL: 3600 });

    // 4. Create the socket with all best-practice settings
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            // makeCacheableSignalKeyStore = faster signal processing, prevents double-processing
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        browser: Browsers.appropriate('Chrome'),  // auto-detects OS for correct fingerprint
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        countryCode,
        getMessage,
        cachedGroupMetadata
    });

    // 5. Batch event processing — official recommended approach
    sock.ev.process(async (events) => {

        // ── Connection state ─────────────────────────────────────
        if (events['connection.update']) {
            const { connection, lastDisconnect, qr } = events['connection.update'];

            if (qr) {
                // Only request pairing code if not already registered
                if (usePairingCode && phoneNumber && !sock.authState.creds.registered) {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        logger.info(`🔑 Pairing code: ${code}`);
                    } catch (err) {
                        logger.error('Failed to get pairing code:', err.message);
                    }
                } else if (!usePairingCode) {
                    qrcode.generate(qr, { small: true });
                    logger.info('📱 Scan QR code with WhatsApp > Linked Devices');
                }
            }

            if (connection === 'connecting') {
                logger.info('Connecting to WhatsApp...');
            } else if (connection === 'open') {
                logger.info(`SilentWolf Connected! 🎉 [${sock.user?.id}]`);
                if (onConnected) onConnected(sock);
            } else if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                logger.warn(`Disconnected — code: ${code}`);
                if (onDisconnected) onDisconnected(code);

                // UNAUTHORIZED_CODES = [401, 403, 419] + loggedOut(401)
                const loggedOut = UNAUTHORIZED_CODES.includes(code)
                    || code === DisconnectReason.loggedOut;

                if (loggedOut) {
                    logger.error('Session ended. Delete auth folder and reconnect.');
                } else {
                    logger.info('Reconnecting in 5s...');
                    await wait(5000);
                    connectToWhatsApp(options);
                }
            }
        }

        // ── Save credentials whenever they update ─────────────────
        if (events['creds.update']) {
            await saveCreds();
        }
    });

    return sock;
}
