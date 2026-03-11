/**
 * SilentWolf — QR Code Connection Test
 * Run: node tests/test-qr.js
 *
 * Scan QR in WhatsApp > Linked Devices > Link a Device.
 * Then send any of these to yourself:
 *   !ping       → Pong reply
 *   !info       → your JID info
 *   !uptime     → bot uptime
 */

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
import qrcode       from 'qrcode-terminal';

const AUTH_FOLDER = './tests/auth_qr';
const PREFIX      = '!';

async function start() {
    console.log('\x1b[38;2;57;255;20m🐺 SilentWolf — QR Test\x1b[0m\n');

    const { state, saveCreds }        = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest }       = await fetchLatestBaileysVersion();
    const msgRetryCounterCache        = new NodeCache({ stdTTL: 3600 });

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

            if (qr) {
                console.log('\n📱 Scan QR with WhatsApp > Linked Devices:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'connecting') {
                console.log('⏳ Connecting...');
            } else if (connection === 'open') {
                console.log(`\n✅ Connected as ${sock.user?.id}`);
                console.log('Send !ping to yourself to test\n');
            } else if (connection === 'close') {
                const code     = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = UNAUTHORIZED_CODES.includes(code) || code === DisconnectReason.loggedOut;
                console.log(`❌ Disconnected — code: ${code}`);
                if (loggedOut) {
                    console.log('🚪 Session ended. Delete tests/auth_qr and restart.');
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
                if (msg.key.fromMe)                return;
                const jid = msg.key.remoteJid;
                if (isJidNewsletter(jid))          continue;
                if (isJidStatusBroadcast(jid))     continue;

                const text = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || '';

                if (!text.startsWith(PREFIX)) continue;
                const [cmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
                const msgId = generateMessageIDV2(sock.user?.id);

                if (cmd === 'ping') {
                    await sock.sendMessage(jid, { text: '🐺 Pong! SilentWolf is working!' }, { quoted: msg, messageId: msgId });
                    console.log(`✅ !ping replied to ${jid}`);
                }

                if (cmd === 'info') {
                    await sock.sendMessage(jid, {
                        text: `🐺 *SilentWolf Info*\n` +
                              `JID: ${sock.user?.id}\n` +
                              `WA Version: ${version.join('.')}\n` +
                              `Latest: ${isLatest}`
                    }, { quoted: msg, messageId: msgId });
                }

                if (cmd === 'uptime') {
                    const s = Math.floor(process.uptime());
                    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
                    await sock.sendMessage(jid, {
                        text: `🐺 Uptime: ${h}h ${m}m ${sec}s`
                    }, { quoted: msg, messageId: msgId });
                }
            }
        }
    });
}

start();
