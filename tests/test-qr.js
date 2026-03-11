/**
 * TEST 1: QR Code Connection
 * Run: node tests/test-qr.js
 *
 * Scan the QR in WhatsApp > Linked Devices > Link a Device.
 * Once connected, send !ping to yourself to verify.
 */

import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '../lib/index.js';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const AUTH_FOLDER = './tests/auth_qr';

async function start() {
    console.log('\x1b[38;2;57;255;20m🐺 SilentWolf — QR Test\x1b[0m\n');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n📱 Scan this QR code with WhatsApp:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'connecting') {
            console.log('⏳ Connecting...');
        } else if (connection === 'open') {
            console.log('✅ Connected! Send !ping to test.');
        } else if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Disconnected — code: ${code}`);
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting in 5s...');
                setTimeout(start, 5000);
            } else {
                console.log('🚪 Logged out. Delete tests/auth_qr and restart.');
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const jid  = msg.key.remoteJid;
            console.log(`📨 ${jid}: ${text}`);
            if (text === '!ping') {
                await sock.sendMessage(jid, { text: '🐺 Pong! SilentWolf is working!' }, { quoted: msg });
                console.log('✅ Replied with Pong!');
            }
        }
    });
}

start();
