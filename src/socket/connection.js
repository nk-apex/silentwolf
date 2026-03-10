const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { loadAuthState } = require('../auth/authState');
const logger = require('../utils/logger');

async function connectToWhatsApp(options = {}) {
    const { usePairingCode = false, phoneNumber = '' } = options;

    const { state, saveCreds } = await loadAuthState();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    if (usePairingCode && phoneNumber) {
        const code = await sock.requestPairingCode(phoneNumber);
        logger.info(`Your pairing code: ${code}`);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (!usePairingCode && qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'connecting') {
            logger.info('Connecting...');
        } else if (connection === 'open') {
            logger.info('SilentWolf Connected!');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            if (loggedOut) {
                logger.error('Logged out. Please restart and re-authenticate.');
            } else {
                logger.warn('Disconnected - reconnecting...');
                connectToWhatsApp(options);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

module.exports = { connectToWhatsApp };
