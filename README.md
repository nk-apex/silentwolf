<p align="center">
  <img src="https://i.ibb.co/tTRTc86S/wolf.jpg" alt="SilentWolf" width="300"/>
</p>

<h1 align="center">🐺 SilentWolf</h1>

<p align="center">
  <img src="https://img.shields.io/badge/npm-v1.0.0-green?style=flat-square" alt="npm version"/>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License MIT"/>
  <img src="https://img.shields.io/badge/node.js-20%2B-brightgreen?style=flat-square" alt="Node.js 20+"/>
</p>

<p align="center">
  SilentWolf - A powerful WhatsApp bot library built on Baileys. Fast, clean, and built for hunters.
</p>

---

## Installation

```bash
npm install silentwolf
```

---

## Quick Start

```js
const { createBot } = require('silentwolf');

async function main() {
  const { sock, sender, router, store } = await createBot({ prefix: '!' });

  router.register('ping', { description: 'Ping the bot' }, async ({ message }) => {
    await sender.sendReply(message.key.remoteJid, '🐺 Pong!', message);
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      store.save(msg.key.remoteJid, msg);
      router.handle(sock, msg);
    }
  });
}

main();
```

---

## API Reference

### `createBot(options)`

| Option       | Type    | Default | Description                        |
|--------------|---------|---------|------------------------------------|
| `prefix`     | string  | `"!"`   | Command prefix                     |
| `usePairingCode` | boolean | `false` | Use pairing code instead of QR |
| `phoneNumber` | string | `""`    | Phone number for pairing code      |

Returns `{ sock, sender, router, store }`.

---

### `MessageSender`

| Method | Description |
|--------|-------------|
| `sendText(jid, text)` | Send a plain text message |
| `sendReply(jid, text, quotedMessage)` | Reply to a specific message |
| `sendImage(jid, imageBuffer, caption)` | Send an image with optional caption |
| `sendVideo(jid, videoBuffer, caption)` | Send a video with optional caption |
| `sendDocument(jid, buffer, filename, mimetype)` | Send a file/document |
| `sendReaction(jid, messageKey, emoji)` | React to a message with an emoji |

---

### `CommandRouter`

| Method | Description |
|--------|-------------|
| `register(name, options, handler)` | Register a command with optional aliases, adminOnly, groupOnly |
| `handle(sock, message)` | Process an incoming message and route to the right command |

**Handler receives:** `{ sock, message, args, sender, isGroup, isAdmin }`

---

### `MessageStore`

| Method | Description |
|--------|-------------|
| `save(jid, message)` | Save a message (auto-evicts oldest after 1000) |
| `getById(jid, messageId)` | Get a message by ID |
| `getHistory(jid, limit)` | Get recent messages for a chat |
| `delete(jid, messageId)` | Delete a specific message |
| `clear(jid)` | Clear all messages for a chat |
| `persistToDisk(folderPath)` | Save store to a JSON file |
| `loadFromDisk(folderPath)` | Load store from a JSON file on startup |

---

### Session Management

| Function | Description |
|----------|-------------|
| `exportSession(authFolder)` | Export credentials as a `SILENTWOLF_...` string |
| `importSession(sessionId, authFolder)` | Restore credentials from a session ID string |
| `isSessionValid(authFolder)` | Check if valid credentials exist |

#### Example

```js
const { exportSession, importSession, isSessionValid } = require('silentwolf');

// Export current session
const sessionId = await exportSession('auth_info');
console.log(sessionId); // SILENTWOLF_eyJ...

// Import session on a new machine
await importSession('SILENTWOLF_eyJ...', 'auth_info');

// Check before connecting
const valid = await isSessionValid('auth_info');
if (!valid) {
  console.log('Please scan QR or provide a session ID.');
}
```

---

## License

MIT

---

<p align="center">🐺 Built by Silent Wolf</p>
