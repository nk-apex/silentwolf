/**
 * SilentWolf Unit Tests
 * Run: node tests/test-units.js
 *
 * Tests all library modules without needing a WhatsApp connection.
 */

import logger from '../src/utils/logger.js';
import { CommandRouter } from '../src/commands/router.js';
import { MessageStore } from '../src/store/messageStore.js';
import { exportSession, importSession, isSessionValid } from '../src/auth/sessionManager.js';
import { MessageSender } from '../src/messages/sender.js';
import { startKeepAlive } from '../src/utils/keepAlive.js';
import express from 'express';
import fs from 'fs';
import path from 'path';

const NEON  = '\x1b[38;2;57;255;20m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[96m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`${NEON}  ✅ PASS${RESET} — ${name}`);
        passed++;
    } catch (err) {
        console.log(`${RED}  ❌ FAIL${RESET} — ${name}`);
        console.log(`       ${RED}${err.message}${RESET}`);
        failed++;
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`${NEON}  ✅ PASS${RESET} — ${name}`);
        passed++;
    } catch (err) {
        console.log(`${RED}  ❌ FAIL${RESET} — ${name}`);
        console.log(`       ${RED}${err.message}${RESET}`);
        failed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

// ─────────────────────────────────────────────
console.log(`\n${NEON}╔══════════════════════════════════════╗`);
console.log(`║   🐺  SilentWolf Unit Tests          ║`);
console.log(`╚══════════════════════════════════════╝${RESET}\n`);

// ─── Logger ───────────────────────────────────
console.log(`${CYAN}▶ Logger${RESET}`);

test('logger has info, debug, warn, error methods', () => {
    assert(typeof logger.info  === 'function', 'logger.info missing');
    assert(typeof logger.debug === 'function', 'logger.debug missing');
    assert(typeof logger.warn  === 'function', 'logger.warn missing');
    assert(typeof logger.error === 'function', 'logger.error missing');
});

test('logger.info does not throw', () => {
    logger.info('Test info message');
});

test('logger.warn does not throw', () => {
    logger.warn('Test warn message');
});

test('logger.error does not throw', () => {
    logger.error('Test error message');
});

// ─── CommandRouter ─────────────────────────────
console.log(`\n${CYAN}▶ CommandRouter${RESET}`);

test('creates router with default prefix !', () => {
    const r = new CommandRouter();
    assert(r.prefix === '!', 'Default prefix should be !');
});

test('creates router with custom prefix', () => {
    const r = new CommandRouter('/');
    assert(r.prefix === '/', 'Custom prefix should be /');
});

test('registers a command', () => {
    const r = new CommandRouter();
    r.register('ping', {}, async () => {});
    assert(r.commands.has('ping'), 'Command ping not registered');
});

test('registers command aliases', () => {
    const r = new CommandRouter();
    r.register('hello', { aliases: ['hi', 'hey'] }, async () => {});
    assert(r.commands.has('hello'), 'Main command missing');
    assert(r.commands.has('hi'),    'Alias hi missing');
    assert(r.commands.has('hey'),   'Alias hey missing');
});

test('registers command with options', () => {
    const r = new CommandRouter();
    r.register('admin', { adminOnly: true, groupOnly: true, description: 'Admin cmd' }, async () => {});
    const entry = r.commands.get('admin');
    assert(entry.adminOnly === true,          'adminOnly not set');
    assert(entry.groupOnly === true,          'groupOnly not set');
    assert(entry.description === 'Admin cmd', 'description not set');
});

await testAsync('handle ignores messages without prefix', async () => {
    const r = new CommandRouter('!');
    let called = false;
    r.register('ping', {}, async () => { called = true; });

    const mockMsg = {
        key: { remoteJid: '123@s.whatsapp.net', fromMe: false },
        message: { conversation: 'hello world' }
    };
    await r.handle({}, mockMsg);
    assert(!called, 'Handler should NOT be called for non-prefixed messages');
});

await testAsync('handle calls correct command handler', async () => {
    const r = new CommandRouter('!');
    let called = false;
    let receivedArgs = null;

    r.register('ping', {}, async ({ args }) => {
        called = true;
        receivedArgs = args;
    });

    const mockMsg = {
        key: { remoteJid: '123@s.whatsapp.net', fromMe: false },
        message: { conversation: '!ping hello world' }
    };
    const mockSock = { groupMetadata: async () => ({ participants: [] }) };
    await r.handle(mockSock, mockMsg);

    assert(called, 'Handler was not called');
    assert(JSON.stringify(receivedArgs) === JSON.stringify(['hello', 'world']), 'Args mismatch');
});

await testAsync('handle ignores unknown commands silently', async () => {
    const r = new CommandRouter('!');
    const mockMsg = {
        key: { remoteJid: '123@s.whatsapp.net' },
        message: { conversation: '!unknowncmd' }
    };
    await r.handle({}, mockMsg); // should not throw
});

// ─── MessageStore ──────────────────────────────
console.log(`\n${CYAN}▶ MessageStore${RESET}`);

test('creates empty store', () => {
    const s = new MessageStore();
    assert(s.store instanceof Map, 'store should be a Map');
    assert(s.store.size === 0, 'store should start empty');
});

test('saves and retrieves a message by id', () => {
    const s = new MessageStore();
    const msg = { key: { id: 'msg-001', remoteJid: 'jid1' }, message: { conversation: 'hi' } };
    s.save('jid1', msg);
    const retrieved = s.getById('jid1', 'msg-001');
    assert(retrieved !== null, 'Message should be retrievable');
    assert(retrieved.message.conversation === 'hi', 'Message content mismatch');
});

test('getHistory returns all saved messages', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: 'a' } });
    s.save('jid1', { key: { id: 'b' } });
    s.save('jid1', { key: { id: 'c' } });
    const history = s.getHistory('jid1');
    assert(history.length === 3, `Expected 3 messages, got ${history.length}`);
});

test('getHistory respects limit', () => {
    const s = new MessageStore();
    for (let i = 0; i < 10; i++) s.save('jid1', { key: { id: `msg-${i}` } });
    const last3 = s.getHistory('jid1', 3);
    assert(last3.length === 3, `Expected 3, got ${last3.length}`);
});

test('returns null for unknown message', () => {
    const s = new MessageStore();
    const result = s.getById('unknown-jid', 'no-such-id');
    assert(result === null, 'Should return null for missing message');
});

test('deletes a message', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: 'del-me' } });
    s.delete('jid1', 'del-me');
    assert(s.getById('jid1', 'del-me') === null, 'Message should be deleted');
});

test('clears all messages for a jid', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: '1' } });
    s.save('jid1', { key: { id: '2' } });
    s.clear('jid1');
    assert(s.getHistory('jid1').length === 0, 'Store should be empty after clear');
});

test('persists and loads from disk', () => {
    const s = new MessageStore();
    s.save('jid1', { key: { id: 'disk-msg' }, message: { conversation: 'persisted' } });
    s.persistToDisk('./tests/tmp_store');

    const s2 = new MessageStore();
    s2.loadFromDisk('./tests/tmp_store');
    const msg = s2.getById('jid1', 'disk-msg');
    assert(msg !== null, 'Message should be loaded from disk');
    assert(msg.message.conversation === 'persisted', 'Content mismatch after disk load');

    fs.rmSync('./tests/tmp_store', { recursive: true, force: true });
});

test('evicts oldest message when over MAX_MESSAGES limit', () => {
    const s = new MessageStore();
    for (let i = 0; i < 1001; i++) s.save('jid1', { key: { id: `m${i}` } });
    assert(s.getById('jid1', 'm0') === null, 'Oldest message should be evicted');
    assert(s.getById('jid1', 'm1000') !== null, 'Newest message should remain');
});

// ─── MessageSender ─────────────────────────────
console.log(`\n${CYAN}▶ MessageSender${RESET}`);

test('instantiates with a socket', () => {
    const mockSock = { sendMessage: async () => {} };
    const sender = new MessageSender(mockSock);
    assert(sender.sock === mockSock, 'sock not assigned');
});

await testAsync('sendText calls sock.sendMessage', async () => {
    let called = false;
    let capturedArgs = null;
    const mockSock = {
        sendMessage: async (jid, payload) => {
            called = true;
            capturedArgs = { jid, payload };
        }
    };
    const sender = new MessageSender(mockSock);
    await sender.sendText('test@s.whatsapp.net', 'Hello Wolf!');
    assert(called, 'sendMessage was not called');
    assert(capturedArgs.payload.text === 'Hello Wolf!', 'Text content mismatch');
});

await testAsync('sendReaction calls sock.sendMessage with react payload', async () => {
    let payload = null;
    const mockSock = { sendMessage: async (_jid, p) => { payload = p; } };
    const sender = new MessageSender(mockSock);
    await sender.sendReaction('jid', { id: 'msg-1' }, '🐺');
    assert(payload?.react?.text === '🐺', 'Reaction emoji mismatch');
});

await testAsync('sender handles sendMessage error gracefully', async () => {
    const mockSock = { sendMessage: async () => { throw new Error('Network error'); } };
    const sender = new MessageSender(mockSock);
    await sender.sendText('jid', 'test'); // should not throw
});

// ─── SessionManager ────────────────────────────
console.log(`\n${CYAN}▶ SessionManager${RESET}`);

await testAsync('isSessionValid returns false when no creds found', async () => {
    const valid = await isSessionValid('./tests/no_such_folder_xyz');
    assert(valid === false, 'Should return false for missing session');
});

await testAsync('exportSession throws when no creds file exists', async () => {
    let threw = false;
    try { await exportSession('./tests/no_such_folder_xyz'); }
    catch { threw = true; }
    assert(threw, 'Should throw for missing creds');
});

await testAsync('importSession throws for invalid session ID', async () => {
    let threw = false;
    try { await importSession('INVALID_ID', './tests/tmp_session'); }
    catch { threw = true; }
    fs.rmSync('./tests/tmp_session', { recursive: true, force: true });
    assert(threw, 'Should throw for invalid session ID');
});

await testAsync('export and import session round-trips correctly', async () => {
    const tmpAuth = './tests/tmp_auth_export';
    fs.mkdirSync(tmpAuth, { recursive: true });

    const fakeCreds = JSON.stringify({ registered: true, me: { id: '254@s.whatsapp.net' } });
    fs.writeFileSync(path.join(tmpAuth, 'creds.json'), fakeCreds, 'utf-8');

    const sessionId = await exportSession(tmpAuth);
    assert(sessionId.startsWith('SILENTWOLF_'), 'Session ID should start with SILENTWOLF_');

    const importDir = './tests/tmp_auth_import';
    await importSession(sessionId, importDir);

    const valid = await isSessionValid(importDir);
    assert(valid === true, 'Imported session should be valid');

    fs.rmSync(tmpAuth,    { recursive: true, force: true });
    fs.rmSync(importDir,  { recursive: true, force: true });
});

// ─── keepAlive ─────────────────────────────────
console.log(`\n${CYAN}▶ keepAlive${RESET}`);

await testAsync('startKeepAlive starts HTTP server and responds on /', async () => {
    const server = await new Promise((resolve) => {
        const app = express();
        app.get('/', (_req, res) => res.send('🐺 SilentWolf is alive and hunting!'));
        const s = app.listen(4999, () => resolve(s));
    });

    const res = await fetch('http://localhost:4999/');
    const text = await res.text();
    server.close();
    assert(text.includes('SilentWolf'), 'Keep-alive response missing SilentWolf');
});

// ─── Summary ───────────────────────────────────
const total = passed + failed;
console.log(`\n${NEON}════════════════════════════════════════${RESET}`);
console.log(`  Results: ${NEON}${passed} passed${RESET} / ${failed > 0 ? RED : ''}${failed} failed${RESET} / ${total} total`);
console.log(`${NEON}════════════════════════════════════════${RESET}\n`);

if (failed > 0) process.exit(1);
