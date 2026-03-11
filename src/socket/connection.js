import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '../../lib/index.js';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import logger from '../utils/logger.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

export async function connectToWhatsApp(options = {}) {
    const { usePairingCode = false, phoneNumber = '', authFolder = 'auth_info' } = options;

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
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
            const code = lastDisconnect?.error?.output?.statusCode;
            logger.warn(`Disconnected — code: ${code}`);
            if (code === DisconnectReason.loggedOut) {
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
