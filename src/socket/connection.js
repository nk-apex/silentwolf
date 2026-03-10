const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { loadAuthState } = require('../auth/authState');
const logger = require('../utils/logger');

async function connectToWhatsApp() {
    const { state, saveCreds } = await loadAuthState();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We will handle it manually with qrcode-terminal
        logger: pino({ level: 'silent' }) // Suppress default baileys logger
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'connecting') {
            logger.info('Connecting...');
        } else if (connection === 'open') {
            logger.info('SilentWolf Connected!');
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.warn('Disconnected - reconnecting...', shouldReconnect ? 'Yes' : 'No');
            
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

module.exports = { connectToWhatsApp };
