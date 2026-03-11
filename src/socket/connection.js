const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { loadAuthState } = require('../auth/authState');
const logger = require('../utils/logger');

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToWhatsApp(options = {}) {
    const { usePairingCode = false, phoneNumber = '' } = options;

    const { state, saveCreds } = await loadAuthState();

    const sock = makeWASocket({
        auth: state,
        browser: ['SilentWolf', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            if (usePairingCode && phoneNumber) {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    logger.info(`🔑 Your pairing code: ${code}`);
                } catch (err) {
                    logger.error('Failed to get pairing code:', err.message);
                }
            } else {
                qrcode.generate(qr, { small: true });
                logger.info('Scan the QR code above with WhatsApp!');
            }
        }

        if (connection === 'connecting') {
            logger.info('Connecting...');
        } else if (connection === 'open') {
            logger.info('SilentWolf Connected! 🎉');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            logger.warn(`Disconnected — code: ${statusCode}`);

            if (loggedOut) {
                logger.error('Logged out. Please restart and re-authenticate.');
            } else {
                const delay = statusCode === 405 ? 10000 : 3000;
                logger.info(`Reconnecting in ${delay / 1000}s...`);
                await wait(delay);
                connectToWhatsApp(options);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

module.exports = { connectToWhatsApp };
