const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { loadAuthState } = require('../auth/authState');
const logger = require('../utils/logger');

const RECONNECT_DELAY_MS = 5000;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToWhatsApp(options = {}) {
    const { usePairingCode = false, phoneNumber = '' } = options;

    const { state, saveCreds } = await loadAuthState();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            if (usePairingCode && phoneNumber) {
                // QR firing = WA servers are ready, now request the pairing code
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    logger.info(`🔑 Your pairing code: ${code}`);
                } catch (err) {
                    logger.error('Failed to get pairing code:', err.message);
                }
            } else {
                logger.info('📱 Scan this QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });
            }
        }

        if (connection === 'connecting') {
            logger.info('Connecting...');
        } else if (connection === 'open') {
            logger.info('SilentWolf Connected! 🎉');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = DisconnectReason[statusCode] || statusCode || 'unknown';
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            logger.warn(`Disconnected — reason: ${reason}`);

            if (loggedOut) {
                logger.error('Logged out. Please restart and re-authenticate.');
            } else {
                logger.info(`Waiting ${RECONNECT_DELAY_MS / 1000}s before reconnecting...`);
                await wait(RECONNECT_DELAY_MS);
                connectToWhatsApp(options);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

module.exports = { connectToWhatsApp };
