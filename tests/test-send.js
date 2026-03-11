/**
 * TEST 3: Send Message Test
 * Run: node tests/test-send.js
 *
 * Requires an existing session. Run test-qr.js or test-pairing.js first.
 * Set MY_JID below (your number + @s.whatsapp.net).
 */

import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '../lib/index.js';
import pino from 'pino';

const MY_JID      = '2547XXXXXXXX@s.whatsapp.net'; // <-- replace with your number
const AUTH_FOLDER = './tests/auth_qr';              // change to auth_pairing if needed

async function start() {
    console.log('\x1b[38;2;57;255;20m🐺 SilentWolf — Send Message Test\x1b[0m\n');

    if (MY_JID === '2547XXXXXXXX@s.whatsapp.net') {
        console.error('❌ Set your MY_JID at the top of this file first.');
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'connecting') {
            console.log('⏳ Connecting...');
        } else if (connection === 'open') {
            console.log('✅ Connected! Running send tests...\n');
            await runTests(sock);
        } else if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Disconnected — code: ${code}`);
            if (code !== DisconnectReason.loggedOut) setTimeout(start, 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            console.log(`📨 Reply received: ${text}`);
        }
    });
}

async function runTests(sock) {
    console.log('📤 Test 1: Sending text...');
    const sent = await sock.sendMessage(MY_JID, { text: '🐺 SilentWolf send test ✅' });
    console.log('✅ Text sent!\n');

    console.log('📤 Test 2: Sending reply...');
    await sock.sendMessage(MY_JID, { text: '🐺 Reply test ✅' }, { quoted: sent });
    console.log('✅ Reply sent!\n');

    console.log('📤 Test 3: Sending reaction...');
    await sock.sendMessage(MY_JID, { react: { text: '🐺', key: sent.key } });
    console.log('✅ Reaction sent!\n');

    console.log('🎉 All tests passed! Check your WhatsApp.\n');
    console.log('👂 Listening for replies... (Ctrl+C to stop)');
}

start();
