const pino = require('pino');
const qrcode = require('qrcode-terminal');
const logger = require('../utils/logger');

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToWhatsApp(options = {}) {
    const { usePairingCode = false, phoneNumber = '', authFolder = 'auth_info' } = options;

    // Dynamic import bridges CommonJS → ESM (Baileys lib)
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = await import('../../lib/index.js');

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        markOnlineOnConnect: false
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
                logger.info('📱 Scan the QR code above with WhatsApp!');
            }
        }

        if (connection === 'connecting') {
            logger.info('Connecting...');
        } else if (connection === 'open') {
            logger.info('SilentWolf Connected! 🎉');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            logger.warn(`Disconnected — code: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                logger.error('Logged out. Delete auth folder and restart.');
            } else {
                logger.info('Reconnecting in 5s...');
                await wait(5000);
                connectToWhatsApp(options);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

module.exports = { connectToWhatsApp };
