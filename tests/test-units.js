/**
 * SilentWolf Unit Tests — Full Suite
 * Run: node tests/test-units.js
 *
 * Tests all modules without needing a WhatsApp connection.
 */

import logger                                           from '../src/utils/logger.js';
import { CommandRouter }                                from '../src/commands/router.js';
import { MessageStore }                                 from '../src/store/messageStore.js';
import { exportSession, importSession, isSessionValid } from '../src/auth/sessionManager.js';
import { MessageSender }                                from '../src/messages/sender.js';
import express                                          from 'express';
import fs                                               from 'fs';
import path                                             from 'path';

const NEON  = '\x1b[38;2;57;255;20m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[96m';
const RESET = '\x1b[0m';

let passed = 0, failed = 0;

function test(name, fn) {
    try   { fn(); console.log(`${NEON}  ✅ PASS${RESET} — ${name}`); passed++; }
    catch (err) { console.log(`${RED}  ❌ FAIL${RESET} — ${name}\n       ${RED}${err.message}${RESET}`); failed++; }
}

async function testAsync(name, fn) {
    try   { await fn(); console.log(`${NEON}  ✅ PASS${RESET} — ${name}`); passed++; }
    catch (err) { console.log(`${RED}  ❌ FAIL${RESET} — ${name}\n       ${RED}${err.message}${RESET}`); failed++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// ─────────────────────────────────────────────────────────────
console.log(`\n${NEON}╔══════════════════════════════════════╗`);
console.log(`║   🐺  SilentWolf Unit Tests          ║`);
console.log(`╚══════════════════════════════════════╝${RESET}\n`);

// ─── Baileys exports ──────────────────────────────────────────
console.log(`${CYAN}▶ Baileys exports (from bundled lib)${RESET}`);

await testAsync('fetchLatestBaileysVersion is a function', async () => {
    const { fetchLatestBaileysVersion } = await import('../lib/index.js');
    assert(typeof fetchLatestBaileysVersion === 'function');
});

await testAsync('makeCacheableSignalKeyStore is a function', async () => {
    const { makeCacheableSignalKeyStore } = await import('../lib/index.js');
    assert(typeof makeCacheableSignalKeyStore === 'function');
});

await testAsync('Browsers.appropriate is a function', async () => {
    const { Browsers } = await import('../lib/index.js');
    assert(typeof Browsers.appropriate === 'function');
    const b = Browsers.appropriate('Chrome');
    assert(Array.isArray(b) && b.length === 3, 'Browser should be [platform, browser, version]');
});

await testAsync('UNAUTHORIZED_CODES contains 401, 403, 419', async () => {
    const { UNAUTHORIZED_CODES } = await import('../lib/index.js');
    assert(UNAUTHORIZED_CODES.includes(401));
    assert(UNAUTHORIZED_CODES.includes(403));
    assert(UNAUTHORIZED_CODES.includes(419));
});

await testAsync('isJidNewsletter, isJidGroup, isJidBroadcast exported', async () => {
    const { isJidNewsletter, isJidGroup, isJidBroadcast } = await import('../lib/index.js');
    assert(typeof isJidNewsletter === 'function');
    assert(typeof isJidGroup      === 'function');
    assert(typeof isJidBroadcast  === 'function');
});

await testAsync('generateMessageIDV2 returns a string', async () => {
    const { generateMessageIDV2 } = await import('../lib/index.js');
    const id = generateMessageIDV2('123@s.whatsapp.net');
    assert(typeof id === 'string' && id.length > 0, `Expected string, got: ${id}`);
});

// ─── Logger ───────────────────────────────────────────────────
console.log(`\n${CYAN}▶ Logger${RESET}`);

test('has info, debug, warn, error methods', () => {
    assert(typeof logger.info  === 'function');
    assert(typeof logger.debug === 'function');
    assert(typeof logger.warn  === 'function');
    assert(typeof logger.error === 'function');
});
test('info does not throw',  () => logger.info('Test info'));
test('warn does not throw',  () => logger.warn('Test warn'));
test('error does not throw', () => logger.error('Test error'));

// ─── CommandRouter ────────────────────────────────────────────
console.log(`\n${CYAN}▶ CommandRouter${RESET}`);

test('default prefix is !', () => {
    assert(new CommandRouter().prefix === '!');
});
test('custom prefix', () => {
    assert(new CommandRouter('/').prefix === '/');
});
test('registers a command', () => {
    const r = new CommandRouter();
    r.register('ping', {}, async () => {});
    assert(r.commands.has('ping'));
});
test('registers aliases', () => {
    const r = new CommandRouter();
    r.register('hello', { aliases: ['hi', 'hey'] }, async () => {});
    assert(r.commands.has('hi') && r.commands.has('hey'));
});
test('registers options (adminOnly, groupOnly, privateOnly, description)', () => {
    const r = new CommandRouter();
    r.register('cmd', { adminOnly: true, groupOnly: true, privateOnly: false, description: 'test' }, async () => {});
    const e = r.commands.get('cmd');
    assert(e.adminOnly && e.groupOnly && !e.privateOnly && e.description === 'test');
});

await testAsync('ignores messages without prefix', async () => {
    const r = new CommandRouter('!');
    let called = false;
    r.register('ping', {}, async () => { called = true; });
    await r.handle({}, { key: { remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'hello' } });
    assert(!called);
});

await testAsync('calls correct handler with args', async () => {
    const r = new CommandRouter('!');
    let capturedArgs = null;
    r.register('ping', {}, async ({ args }) => { capturedArgs = args; });
    const mockSock = { groupMetadata: async () => ({ participants: [] }) };
    await r.handle(mockSock, { key: { remoteJid: '123@s.whatsapp.net' }, message: { conversation: '!ping hello world' } });
    assert(JSON.stringify(capturedArgs) === JSON.stringify(['hello', 'world']));
});

await testAsync('silently ignores unknown commands', async () => {
    const r = new CommandRouter('!');
    await r.handle({}, { key: { remoteJid: '123@s.whatsapp.net' }, message: { conversation: '!unknown' } });
});

await testAsync('filters newsletter JIDs', async () => {
    const { isJidNewsletter } = await import('../lib/index.js');
    // newsletter JIDs end in @newsletter
    const newsletterJid = '1234567890@newsletter';
    assert(isJidNewsletter(newsletterJid), 'Should detect newsletter JID');
});

// ─── MessageStore ─────────────────────────────────────────────
console.log(`\n${CYAN}▶ MessageStore${RESET}`);

test('creates empty store', () => {
    const s = new MessageStore();
    assert(s.store instanceof Map && s.store.size === 0);
});
test('saves and retrieves by id', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: 'msg-001', remoteJid: 'jid1' }, message: { conversation: 'hi' } });
    assert(s.getById('jid1', 'msg-001').message.conversation === 'hi');
});
test('getHistory returns all messages', () => {
    const s = new MessageStore();
    ['a','b','c'].forEach(id => s.save('jid1', { key: { id } }));
    assert(s.getHistory('jid1').length === 3);
});
test('getHistory respects limit', () => {
    const s = new MessageStore();
    for (let i = 0; i < 10; i++) s.save('jid1', { key: { id: `m${i}` } });
    assert(s.getHistory('jid1', 3).length === 3);
});
test('returns null for unknown message', () => {
    assert(new MessageStore().getById('x', 'y') === null);
});
test('deletes a message', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: 'del' } });
    s.delete('jid1', 'del');
    assert(s.getById('jid1', 'del') === null);
});
test('clears all messages for a jid', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: '1' } });
    s.clear('jid1');
    assert(s.getHistory('jid1').length === 0);
});
test('evicts oldest when over 1000 limit', () => {
    const s = new MessageStore();
    for (let i = 0; i <= 1000; i++) s.save('jid1', { key: { id: `m${i}` } });
    assert(s.getById('jid1', 'm0') === null);
    assert(s.getById('jid1', 'm1000') !== null);
});
test('persists and loads from disk', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: 'disk-msg' }, message: { conversation: 'persisted' } });
    s.persistToDisk('./tests/tmp_store');
    const s2 = new MessageStore();
    s2.loadFromDisk('./tests/tmp_store');
    assert(s2.getById('jid1', 'disk-msg').message.conversation === 'persisted');
    fs.rmSync('./tests/tmp_store', { recursive: true, force: true });
});

await testAsync('getMessage returns message content by key', async () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: 'gm-1', remoteJid: 'jid1' }, message: { conversation: 'hello' } });
    const result = await s.getMessage({ remoteJid: 'jid1', id: 'gm-1' });
    assert(result?.conversation === 'hello', 'getMessage should return message content');
});

await testAsync('getMessage returns undefined for unknown key', async () => {
    const s = new MessageStore();
    const result = await s.getMessage({ remoteJid: 'unknown', id: 'unknown' });
    assert(result === undefined);
});

await testAsync('bind() auto-saves messages from sock.ev.process', async () => {
    const s = new MessageStore();
    const handlers = {};
    const mockSock = {
        ev: {
            process: (fn) => { handlers.process = fn; }
        }
    };
    s.bind(mockSock);

    // Simulate a messages.upsert event
    await handlers.process({
        'messages.upsert': {
            messages: [{ key: { id: 'bound-1', remoteJid: 'jid99' }, message: { conversation: 'auto-saved' } }],
            type: 'notify'
        }
    });

    assert(s.getById('jid99', 'bound-1').message.conversation === 'auto-saved', 'bind() should auto-save messages');
});

// ─── MessageSender ────────────────────────────────────────────
console.log(`\n${CYAN}▶ MessageSender${RESET}`);

test('instantiates with sock', () => {
    const s = new MessageSender({ sendMessage: async () => {} });
    assert(typeof s.sock === 'object');
});

await testAsync('sendText calls sendMessage', async () => {
    let args = null;
    const s = new MessageSender({ sendMessage: async (j, p) => { args = { j, p }; }, user: { id: 'me@s.whatsapp.net' } });
    await s.sendText('jid', 'Hello Wolf');
    assert(args.p.text === 'Hello Wolf');
});

await testAsync('sendReply passes quoted option', async () => {
    let opts = null;
    const s = new MessageSender({ sendMessage: async (j, p, o) => { opts = o; }, user: { id: 'me@s.whatsapp.net' } });
    const quoted = { key: { id: 'q1' } };
    await s.sendReply('jid', 'Reply', quoted);
    assert(opts?.quoted === quoted, 'quoted message should be passed');
});

await testAsync('sendPoll sends poll payload', async () => {
    let payload = null;
    const s = new MessageSender({ sendMessage: async (j, p) => { payload = p; }, user: { id: 'me@s.whatsapp.net' } });
    await s.sendPoll('jid', 'Best wolf?', ['Grey', 'Black', 'White'], 1);
    assert(payload.poll.name === 'Best wolf?');
    assert(payload.poll.values.length === 3);
    assert(payload.poll.selectableCount === 1);
});

await testAsync('sendLocation sends location payload', async () => {
    let payload = null;
    const s = new MessageSender({ sendMessage: async (j, p) => { payload = p; }, user: { id: 'me@s.whatsapp.net' } });
    await s.sendLocation('jid', -1.286389, 36.817223, 'Nairobi');
    assert(payload.location.degreesLatitude === -1.286389);
    assert(payload.location.name === 'Nairobi');
});

await testAsync('sendReaction sends react payload', async () => {
    let payload = null;
    const s = new MessageSender({ sendMessage: async (j, p) => { payload = p; }, user: { id: 'me@s.whatsapp.net' } });
    await s.sendReaction('jid', { id: 'msg-1' }, '🐺');
    assert(payload.react.text === '🐺');
});

await testAsync('handles sendMessage error gracefully', async () => {
    const s = new MessageSender({ sendMessage: async () => { throw new Error('Network error'); }, user: { id: 'me@s.whatsapp.net' } });
    await s.sendText('jid', 'test'); // should not throw
});

// ─── SessionManager ───────────────────────────────────────────
console.log(`\n${CYAN}▶ SessionManager${RESET}`);

await testAsync('isSessionValid false when no folder', async () => {
    assert(await isSessionValid('./tests/no_folder_xyz') === false);
});
await testAsync('exportSession throws on missing creds', async () => {
    let threw = false;
    try { await exportSession('./tests/no_folder_xyz'); } catch { threw = true; }
    assert(threw);
});
await testAsync('importSession throws for invalid ID', async () => {
    let threw = false;
    try { await importSession('BAD_ID', './tests/tmp_sess'); } catch { threw = true; }
    fs.rmSync('./tests/tmp_sess', { recursive: true, force: true });
    assert(threw);
});
await testAsync('export → import round-trip', async () => {
    const dir  = './tests/tmp_auth_rt';
    const dir2 = './tests/tmp_auth_rt2';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '254@s.whatsapp.net' } }));
    const id = await exportSession(dir);
    assert(id.startsWith('SILENTWOLF_'));
    await importSession(id, dir2);
    assert(await isSessionValid(dir2) === true);
    fs.rmSync(dir,  { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// ─── keepAlive ────────────────────────────────────────────────
console.log(`\n${CYAN}▶ keepAlive${RESET}`);

await testAsync('HTTP server responds on / with SilentWolf text', async () => {
    const server = await new Promise(resolve => {
        const app = express();
        app.get('/', (_req, res) => res.send('🐺 SilentWolf is alive and hunting!'));
        const s = app.listen(4999, () => resolve(s));
    });
    const text = await fetch('http://localhost:4999/').then(r => r.text());
    server.close();
    assert(text.includes('SilentWolf'));
});

// ─── Summary ──────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${NEON}════════════════════════════════════════${RESET}`);
console.log(`  Results: ${NEON}${passed} passed${RESET} / ${failed > 0 ? RED : ''}${failed} failed${RESET} / ${total} total`);
console.log(`${NEON}════════════════════════════════════════${RESET}\n`);
if (failed > 0) process.exit(1);
