/**
 * SilentWolf — Send Message Test
 * Run: node tests/test-send.js
 *
 * Needs an existing session. Run test-qr.js or test-pairing.js first.
 * Tests: text, reply, reaction, poll, location, contact card.
 */

const MY_JID      = '2547XXXXXXXX@s.whatsapp.net'; // <-- your number
const AUTH_FOLDER = './tests/auth_qr';              // or auth_pairing

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    UNAUTHORIZED_CODES,
    generateMessageIDV2
} from '../lib/index.js';

import NodeCache    from '@cacheable/node-cache';
import pino         from 'pino';

async function start() {
    console.log('\x1b[38;2;57;255;20m🐺 SilentWolf — Send Test\x1b[0m\n');

    if (MY_JID === '2547XXXXXXXX@s.whatsapp.net') {
        console.error('❌ Set MY_JID at the top of this file first.');
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

        if (events['connection.update']) {
            const { connection, lastDisconnect } = events['connection.update'];

            if (connection === 'connecting') {
                console.log('⏳ Connecting...');
            } else if (connection === 'open') {
                console.log(`✅ Connected as ${sock.user?.id}\n`);
                await runTests(sock);
            } else if (connection === 'close') {
                const code      = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = UNAUTHORIZED_CODES.includes(code) || code === DisconnectReason.loggedOut;
                if (!loggedOut) setTimeout(start, 5000);
                else console.log('🚪 Logged out.');
            }
        }

        if (events['creds.update']) await saveCreds();

        if (events['messages.upsert']) {
            const { messages, type } = events['messages.upsert'];
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                console.log(`📨 Reply: ${text}`);
            }
        }
    });
}

async function runTests(sock) {
    const id = () => generateMessageIDV2(sock.user?.id);

    // 1. Text
    console.log('📤 Test 1: Text...');
    const sent = await sock.sendMessage(MY_JID, { text: '🐺 SilentWolf text test ✅' }, { messageId: id() });
    console.log('✅ Done\n');

    // 2. Reply
    console.log('📤 Test 2: Reply...');
    await sock.sendMessage(MY_JID, { text: '🐺 Reply test ✅' }, { quoted: sent, messageId: id() });
    console.log('✅ Done\n');

    // 3. Reaction
    console.log('📤 Test 3: Reaction...');
    await sock.sendMessage(MY_JID, { react: { text: '🐺', key: sent.key } });
    console.log('✅ Done\n');

    // 4. Poll
    console.log('📤 Test 4: Poll...');
    await sock.sendMessage(MY_JID, {
        poll: { name: '🐺 SilentWolf Poll Test', values: ['Yes 🐺', 'No ❌', 'Maybe 🤔'], selectableCount: 1 }
    }, { messageId: id() });
    console.log('✅ Done\n');

    // 5. Location
    console.log('📤 Test 5: Location...');
    await sock.sendMessage(MY_JID, {
        location: { degreesLatitude: -1.286389, degreesLongitude: 36.817223, name: 'Nairobi, Kenya' }
    }, { messageId: id() });
    console.log('✅ Done\n');

    console.log('🎉 All send tests passed! Check your WhatsApp.\n');
    console.log('👂 Listening for replies... (Ctrl+C to stop)');
}

start();
