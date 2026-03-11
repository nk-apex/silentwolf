/**
 * SilentWolf — Pairing Code Connection Test
 * Run: node tests/test-pairing.js
 *
 * Set PHONE_NUMBER below, then:
 * WhatsApp > Linked Devices > Link with phone number > enter the code.
 */

const PHONE_NUMBER = '2547XXXXXXXX'; // <-- replace with your number (no + or spaces)
const AUTH_FOLDER  = './tests/auth_pairing';
const PREFIX       = '!';

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    UNAUTHORIZED_CODES,
    generateMessageIDV2,
    isJidNewsletter,
    isJidStatusBroadcast
} from '../lib/index.js';

import NodeCache    from '@cacheable/node-cache';
import pino         from 'pino';

async function start() {
    console.log('\x1b[38;2;57;255;20m🐺 SilentWolf — Pairing Code Test\x1b[0m\n');

    if (PHONE_NUMBER === '2547XXXXXXXX') {
        console.error('❌ Set PHONE_NUMBER at the top of this file first.');
        process.exit(1);
    }

    const { state, saveCreds }  = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    const msgRetryCounterCache  = new NodeCache({ stdTTL: 3600 });

    console.log(`📡 WA v${version.join('.')} | Latest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        browser: Browsers.appropriate('Chrome'),
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });

    sock.ev.process(async (events) => {

        // ── Connection ────────────────────────────────────────
        if (events['connection.update']) {
            const { connection, lastDisconnect, qr } = events['connection.update'];

            if (qr && !sock.authState.creds.registered) {
                // Only request pairing code when not yet registered
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    console.log(`\n🔑 Pairing code: \x1b[38;2;57;255;20m${code}\x1b[0m`);
                    console.log('👆 Enter in WhatsApp > Linked Devices > Link with phone number\n');
                } catch (err) {
                    console.error('❌ Pairing code error:', err.message);
                }
            }

            if (connection === 'connecting') {
                console.log('⏳ Connecting...');
            } else if (connection === 'open') {
                console.log(`\n✅ Connected as ${sock.user?.id}`);
                console.log('Send !ping to yourself to test\n');
            } else if (connection === 'close') {
                const code      = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = UNAUTHORIZED_CODES.includes(code) || code === DisconnectReason.loggedOut;
                console.log(`❌ Disconnected — code: ${code}`);
                if (loggedOut) {
                    console.log('🚪 Session ended. Delete tests/auth_pairing and restart.');
                } else {
                    console.log('🔄 Reconnecting in 5s...');
                    setTimeout(start, 5000);
                }
            }
        }

        // ── Save creds ────────────────────────────────────────
        if (events['creds.update']) {
            await saveCreds();
        }

        // ── Handle messages ───────────────────────────────────
        if (events['messages.upsert']) {
            const { messages, type } = events['messages.upsert'];
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (msg.key.fromMe)            continue;
                const jid = msg.key.remoteJid;
                if (isJidNewsletter(jid))      continue;
                if (isJidStatusBroadcast(jid)) continue;

                const text = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || '';

                if (!text.startsWith(PREFIX)) continue;
                const [cmd] = text.slice(PREFIX.length).trim().split(/\s+/);
                const msgId = generateMessageIDV2(sock.user?.id);

                if (cmd === 'ping') {
                    await sock.sendMessage(jid, { text: '🐺 Pong! Pairing code test working!' }, { quoted: msg, messageId: msgId });
                    console.log(`✅ !ping replied to ${jid}`);
                }

                if (cmd === 'info') {
                    await sock.sendMessage(jid, {
                        text: `🐺 *SilentWolf Info*\nJID: ${sock.user?.id}\nWA v${version.join('.')}`
                    }, { quoted: msg, messageId: msgId });
                }
            }
        }
    });
}

start();
