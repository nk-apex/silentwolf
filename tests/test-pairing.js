/**
 * TEST 2: Pairing Code Connection
 * Run: node tests/test-pairing.js
 *
 * Set your phone number below (country code, no +, no spaces).
 * Go to WhatsApp > Linked Devices > Link with phone number > enter the code shown.
 */

const PHONE_NUMBER = '2547XXXXXXXX'; // <-- replace with your number
const AUTH_FOLDER = './tests/auth_pairing';

import('../lib/index.js').then(async ({ default: makeWASocket, DisconnectReason, useMultiFileAuthState }) => {
    const pino = (await import('pino')).default;

    if (PHONE_NUMBER === '2547XXXXXXXX') {
        console.error('❌ Please set your PHONE_NUMBER at the top of this file first.');
        process.exit(1);
    }

    async function start() {
        console.log('\x1b[38;2;57;255;20m🐺 SilentWolf — Pairing Code Test\x1b[0m\n');

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    console.log(`\n🔑 Your pairing code: \x1b[38;2;57;255;20m${code}\x1b[0m`);
                    console.log('👆 Enter in WhatsApp > Linked Devices > Link with phone number\n');
                } catch (err) {
                    console.error('❌ Failed to get pairing code:', err.message);
                }
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
                    console.log('🚪 Logged out. Delete tests/auth_pairing and restart.');
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                const jid = msg.key.remoteJid;
                console.log(`📨 Message from ${jid}: ${text}`);

                if (text === '!ping') {
                    await sock.sendMessage(jid, { text: '🐺 Pong! Pairing code test is working!' }, { quoted: msg });
                    console.log('✅ Replied with Pong!');
                }
            }
        });
    }

    start();
});
