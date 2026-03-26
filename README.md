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
  A hardened, TypeScript-first fork of <a href="https://github.com/WhiskeySockets/Baileys">@whiskeysockets/baileys</a> v7.0.0-rc.9 — built for WhatsApp Web automation with full support for the modern LID identity system, view-once media interception, and clean monorepo integration.
</p>

---

## Table of Contents

- [Why SilentWolf?](#why-silentwolf)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
  - [QR Code](#qr-code)
  - [Pair Code](#pair-code)
- [Connecting](#connecting)
- [Sending Messages](#sending-messages)
- [Receiving Messages](#receiving-messages)
- [LID JID Resolution](#lid-jid-resolution)
- [View-Once Messages](#view-once-messages)
- [Downloading Media](#downloading-media)
- [Events Reference](#events-reference)
- [Configuration](#configuration)
- [License](#license)

---

## Why SilentWolf?

Baileys v7 introduced breaking changes around identity — WhatsApp now issues **LID (Linked Identity)** JIDs (e.g. `12345@lid`) in place of phone number JIDs in group chats and multi-device sessions. Most bots built on earlier versions break silently, displaying raw LID strings instead of real phone numbers.

SilentWolf ships with:

- Built-in **LID → phone number resolution** via the signal repository mapping table
- First-class **view-once message interception** — detect, inspect metadata, and download before the primary device opens the message
- All three WhatsApp v7 **view-once wrapper formats** handled (`viewOnceMessage`, `viewOnceMessageV2`, `viewOnceMessageV2Extension`)
- Clean **pnpm workspace** integration — drop it into any monorepo as `@workspace/silentwolf`
- Full **TypeScript** types throughout, zero `any` leaks in the public API

---

## Features

| Feature | Details |
|---|---|
| **Messaging** | Send/receive text, images, video, audio, documents, stickers, polls, reactions |
| **Groups** | Create, join, manage participants, update settings |
| **Communities** | Full community and announcement group support |
| **Business** | Catalog, product, and business profile APIs |
| **Newsletters** | Send and receive WhatsApp Channel messages |
| **Calls** | Detect and reject incoming calls |
| **Auth** | QR code and pair-code linking, persistent multi-file session |
| **LID resolution** | Resolve `@lid` JIDs to real `+phone` numbers |
| **View-once** | Intercept, inspect metadata (type / size / dimensions / duration / caption), and download media |
| **Media** | Upload, download, and stream encrypted WhatsApp media |
| **TypeScript** | 100% typed, ships with `.d.ts` declarations |
| **Node.js 20+** | ESM-native, no CommonJS hacks |

---

## Installation

SilentWolf is designed as a **pnpm workspace library**. Add it to your monorepo:

```jsonc
// pnpm-workspace.yaml
packages:
  - 'lib/*'
  - 'apps/*'
```

```jsonc
// your-app/package.json
{
  "dependencies": {
    "@workspace/silentwolf": "workspace:*"
  }
}
```

Then install:

```bash
pnpm install
```

> **Node.js 20 or later is required.**

---

## Quick Start

```typescript
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@workspace/silentwolf'
import { Boom } from '@hapi/boom'

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({ version, auth: state })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') console.log('Connected!')
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) start() // reconnect
    }
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text
      if (text) console.log('Message:', text)
    }
  })
}

start()
```

---

## Authentication

### QR Code

```typescript
import makeWASocket, { useMultiFileAuthState } from '@workspace/silentwolf'
import qrcode from 'qrcode-terminal'

const { state, saveCreds } = await useMultiFileAuthState('./auth')

const sock = makeWASocket({
  auth: state,
  printQRInTerminal: false,
})

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', ({ qr }) => {
  if (qr) qrcode.generate(qr, { small: true })
})
```

### Pair Code

Use this if you prefer to link without scanning a QR code. Pass the phone number (digits only, with country code) and WhatsApp will display a code to enter under **Linked Devices → Link with phone number**.

```typescript
const sock = makeWASocket({ auth: state, printQRInTerminal: false })

// Wait for socket to initialise before requesting
await new Promise(r => setTimeout(r, 3000))

const code = await sock.requestPairingCode('254733961184')
console.log('Pair code:', code) // e.g. ABCD-1234
```

---

## Connecting

```typescript
sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
  if (connection === 'open') {
    console.log('Connected as', sock.user?.id)
  }

  if (connection === 'close') {
    const code = (lastDisconnect?.error as Boom)?.output?.statusCode
    const loggedOut = code === DisconnectReason.loggedOut
    if (!loggedOut) start() // auto-reconnect
  }
})
```

---

## Sending Messages

```typescript
const jid = '254733961184@s.whatsapp.net'

// Plain text
await sock.sendMessage(jid, { text: 'Hello from SilentWolf 🐺' })

// Image
await sock.sendMessage(jid, {
  image: { url: './photo.jpg' },
  caption: 'Check this out',
})

// Video
await sock.sendMessage(jid, {
  video: { url: './clip.mp4' },
  caption: 'Watch this',
})

// Audio / voice note
await sock.sendMessage(jid, {
  audio: { url: './voice.ogg' },
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true,
})

// Document
await sock.sendMessage(jid, {
  document: { url: './report.pdf' },
  mimetype: 'application/pdf',
  fileName: 'report.pdf',
})

// React to a message
await sock.sendMessage(jid, {
  react: { text: '🔥', key: msg.key },
})

// Reply (quote)
await sock.sendMessage(jid, {
  text: 'Nice!',
  quoted: msg,
})
```

---

## Receiving Messages

```typescript
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return

  for (const msg of messages) {
    if (msg.key.fromMe) continue

    const content = msg.message

    // Plain text
    const text = content?.conversation ?? content?.extendedTextMessage?.text

    // Image with caption
    const imageCaption = content?.imageMessage?.caption

    // Voice note
    const isVoice = !!content?.audioMessage?.ptt

    // Sticker
    const isSticker = !!content?.stickerMessage

    console.log({ text, imageCaption, isVoice, isSticker })
  }
})
```

---

## LID JID Resolution

WhatsApp v7 uses **LID** (Linked Identity) JIDs — e.g. `123456789@lid` — in group chats and multi-device contexts instead of the familiar `+phone@s.whatsapp.net` format. SilentWolf exposes the signal repository mapping table to resolve these back to real phone numbers.

```typescript
import { jidDecode } from '@workspace/silentwolf'

async function resolveJid(sock: WASocket, jid: string): Promise<string> {
  const { user, server } = jidDecode(jid) ?? {}

  if (server === 'lid') {
    const pnJid = await sock.signalRepository.lidMapping.getPNForLID(jid)
    if (pnJid) {
      const phone = pnJid.split('@')[0].split(':')[0]
      return `+${phone}`
    }
    return `[LID:${user}]` // mapping not yet populated
  }

  // Regular JID — strip device suffix
  return `+${user?.split(':')[0]}`
}

// Usage
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    const sender = await resolveJid(sock, msg.key.participant ?? msg.key.remoteJid!)
    console.log('From:', sender) // → +254733961184
  }
})
```

> **Note:** The LID mapping is populated during the initial sync. If `getPNForLID` returns `null`, the mapping hasn't arrived yet — retry after a short delay or cache results.

---

## View-Once Messages

View-once messages self-destruct after being opened. SilentWolf detects all three WhatsApp v7 wrapper formats and gives you the full media metadata immediately — before any download, and before the primary device opens the message.

### Detection

```typescript
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return

  for (const msg of messages) {
    const content = msg.message

    // Case A: Already opened on primary device — no content available
    if (!content && msg.key.isViewOnce) {
      console.log('View-once: already opened on primary device, media unavailable')
      continue
    }

    if (!content) continue

    // Case B: Message arrived with content — act immediately
    const wrapper =
      content.viewOnceMessage ??
      content.viewOnceMessageV2 ??
      content.viewOnceMessageV2Extension

    if (wrapper) {
      const inner = wrapper.message
      const media = inner?.imageMessage ?? inner?.videoMessage ?? inner?.audioMessage
      if (media) {
        console.log('View-once received!')
        // Download before it's revoked (see below)
      }
    }
  }
})
```

### Available Metadata (no download required)

All of the following fields are present in the proto message and available instantly on arrival:

| Field | Image | Video | Audio |
|---|---|---|---|
| `mimetype` | ✅ | ✅ | ✅ |
| `fileLength` (bytes) | ✅ | ✅ | ✅ |
| `width` / `height` | ✅ | ✅ | — |
| `seconds` (duration) | — | ✅ | ✅ |
| `caption` | ✅ | ✅ | — |
| `ptt` (voice note) | — | — | ✅ |
| `gifPlayback` | — | ✅ | — |

### Downloading View-Once Media

```typescript
import { downloadContentFromMessage } from '@workspace/silentwolf'
import { writeFile } from 'node:fs/promises'

const inner = wrapper.message!
const imageMsg = inner.imageMessage!

const stream = await downloadContentFromMessage(imageMsg, 'image')

const chunks: Buffer[] = []
for await (const chunk of stream) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
}

await writeFile('./captured.jpg', Buffer.concat(chunks))
console.log('Saved view-once image!')
```

> **Timing matters:** You must download the media in the `messages.upsert` handler, before the user opens the message on their phone. Once opened on the primary device, WhatsApp revokes the content from all linked devices.

---

## Downloading Media

Use `downloadContentFromMessage` for any media type:

```typescript
import { downloadContentFromMessage } from '@workspace/silentwolf'

// Types: 'image' | 'video' | 'audio' | 'document' | 'sticker'
const stream = await downloadContentFromMessage(msg.message!.imageMessage!, 'image')

const chunks: Buffer[] = []
for await (const chunk of stream) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
}
const buffer = Buffer.concat(chunks)
```

---

## Events Reference

```typescript
sock.ev.on('connection.update', handler)    // connection state changes
sock.ev.on('creds.update', saveCreds)       // auth credentials changed — save immediately
sock.ev.on('messages.upsert', handler)      // new / updated messages
sock.ev.on('messages.update', handler)      // delivery/read receipts, reactions
sock.ev.on('messages.delete', handler)      // deleted messages
sock.ev.on('message-receipt.update', handler)
sock.ev.on('chats.upsert', handler)         // new chats
sock.ev.on('chats.update', handler)         // chat metadata changes
sock.ev.on('chats.delete', handler)
sock.ev.on('contacts.upsert', handler)      // new contacts
sock.ev.on('contacts.update', handler)
sock.ev.on('groups.upsert', handler)        // joined a group
sock.ev.on('groups.update', handler)        // group metadata changed
sock.ev.on('group-participants.update', handler) // members added/removed
sock.ev.on('presence.update', handler)      // typing / online status
sock.ev.on('call', handler)                 // incoming calls
sock.ev.on('labels.association', handler)
sock.ev.on('labels.edit', handler)
```

---

## Configuration

```typescript
const sock = makeWASocket({
  version,                        // from fetchLatestBaileysVersion()
  auth: state,                    // from useMultiFileAuthState()
  logger,                         // pino logger instance (set level: 'warn' for quiet mode)
  printQRInTerminal: false,       // set true to auto-print QR (we recommend manual control)
  browser: ['MyApp', 'Chrome', '1.0.0'], // how your bot appears in Linked Devices
  markOnlineOnConnect: true,      // appear online on connection
  syncFullHistory: false,         // whether to pull full message history on link
  generateHighQualityLinkPreview: true,
  getMessage: async key => {      // required for retries — return stored message
    return { conversation: 'hello' }
  },
})
```

---

## License

MIT © SilentWolf Contributors

Built on top of [Baileys](https://github.com/WhiskeySockets/Baileys) by WhiskeySockets — respect the original license.

---

<p align="center">Made with 🐺 by the SilentWolf team</p>
