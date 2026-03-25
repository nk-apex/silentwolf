import { Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidDecode,
  downloadContentFromMessage,
  proto,
} from '@workspace/silentwolf'
import qrcode from 'qrcode-terminal'
import P from 'pino'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const AUTH_FOLDER = './silentwolf_auth'
const VIEWONCE_FOLDER = './silentwolf_viewonce'

const logger = P({ level: 'warn' })

/**
 * Parse a phone number from CLI arg or env var.
 * Usage:  pnpm test-silentwolf 15551234567
 *    or:  PHONE_NUMBER=15551234567 pnpm test-silentwolf
 */
const PHONE_NUMBER = (process.argv[2] ?? process.env.PHONE_NUMBER ?? '').replace(/\D/g, '')

type WASock = ReturnType<typeof makeWASocket>

// ── JID resolution ─────────────────────────────────────────────────────────

/**
 * Resolve any WhatsApp JID to a human-readable phone number or label.
 * Handles LID JIDs (v7 format) by looking up the LID→PN mapping table.
 */
async function resolveJid(sock: WASock, jid: string | null | undefined): Promise<string> {
  if (!jid) return 'unknown'
  const decoded = jidDecode(jid)
  if (!decoded) return jid

  const { user, server } = decoded

  if (server === 'g.us') return `[Group ${user}]`
  if (server === 'newsletter') return `[Channel ${user}]`
  if (server === 'broadcast') return '[Broadcast]'

  // LID JID — resolve to real phone number via signal repository mapping
  if (server === 'lid') {
    try {
      const pnJid = await sock.signalRepository.lidMapping.getPNForLID(jid)
      if (pnJid) {
        const phone = pnJid.split('@')[0].split(':')[0].replace(/\D/g, '')
        if (phone.length >= 7) return `+${phone}`
      }
    } catch {
      // mapping not yet populated
    }
    return `[LID:${user}]`
  }

  // Regular s.whatsapp.net — strip device suffix
  const phone = user.split(':')[0].replace(/\D/g, '')
  return phone.length >= 7 ? `+${phone}` : `+${user}`
}

// ── View-once handling ─────────────────────────────────────────────────────

type MediaInfo = {
  mediaType: 'image' | 'video' | 'audio'
  ext: string
  msg: proto.Message.IImageMessage | proto.Message.IVideoMessage | proto.Message.IAudioMessage
}

/**
 * Unwrap a view-once message from its container and return the inner media
 * along with the media type. Returns null if the message is not view-once
 * or if the content is already unavailable (already opened on-device).
 *
 * WhatsApp v7 has three wrapper types:
 *   viewOnceMessage           — original format
 *   viewOnceMessageV2         — updated format
 *   viewOnceMessageV2Extension — used for audio voice notes
 */
function extractViewOnceMedia(msgContent: proto.IMessage): MediaInfo | null {
  const inner =
    msgContent.viewOnceMessage?.message ??
    msgContent.viewOnceMessageV2?.message ??
    msgContent.viewOnceMessageV2Extension?.message

  if (!inner) return null

  if (inner.imageMessage) {
    return { mediaType: 'image', ext: 'jpg', msg: inner.imageMessage }
  }
  if (inner.videoMessage) {
    // viewOnce videos can be short clips or GIF-like
    const ext = inner.videoMessage.gifPlayback ? 'mp4' : 'mp4'
    return { mediaType: 'video', ext, msg: inner.videoMessage }
  }
  if (inner.audioMessage) {
    const ext = inner.audioMessage.mimetype?.includes('ogg') ? 'ogg' : 'mp3'
    return { mediaType: 'audio', ext, msg: inner.audioMessage }
  }

  return null
}

/**
 * Download a view-once media message and save it to VIEWONCE_FOLDER.
 * Returns the saved file path, or null on failure.
 */
async function downloadViewOnce(info: MediaInfo, label: string): Promise<string | null> {
  try {
    await fs.mkdir(VIEWONCE_FOLDER, { recursive: true })

    const stream = await downloadContentFromMessage(
      info.msg as Parameters<typeof downloadContentFromMessage>[0],
      info.mediaType
    )

    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const buffer = Buffer.concat(chunks)

    const timestamp = Date.now()
    // Sanitise the label for use in a filename
    const safeSender = label.replace(/[^a-zA-Z0-9+]/g, '_')
    const filename = `${timestamp}_${safeSender}.${info.ext}`
    const filePath = join(VIEWONCE_FOLDER, filename)

    await fs.writeFile(filePath, buffer)
    return filePath
  } catch (err) {
    console.error('  ⚠️  Failed to download view-once media:', (err as Error).message)
    return null
  }
}

// ── Main connection ────────────────────────────────────────────────────────

async function startConnection() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version, isLatest } = await fetchLatestBaileysVersion()

  const mode = PHONE_NUMBER ? `pair-code (+${PHONE_NUMBER})` : 'QR code'
  console.log(`\n🐺 silentwolf — WA v${version.join('.')}${isLatest ? ' (latest)' : ' (update available)'}  |  mode: ${mode}`)
  console.log('─────────────────────────────────────────────────────────')

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['silentwolf', 'Chrome', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Pair-code mode ─────────────────────────────────────────────────────
  if (PHONE_NUMBER && !state.creds.registered) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER)
      const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
      console.log('\n🔑  Pair code requested successfully!')
      console.log(`\n    ┌─────────────┐`)
      console.log(`    │  ${formatted}  │`)
      console.log(`    └─────────────┘`)
      console.log('\n    Enter this code in WhatsApp → Linked Devices → Link with phone number')
      console.log('    Waiting for confirmation...\n')
    } catch (err) {
      console.error('\n❌  Failed to request pair code:', (err as Error).message)
      console.error('    Make sure the phone number is correct (digits only, with country code).')
      process.exit(1)
    }
  }

  // ── Connection state ───────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !PHONE_NUMBER) {
      console.log('\n📱  Scan this QR code with your WhatsApp (Linked Devices → Link a Device):\n')
      qrcode.generate(qr, { small: true })
      console.log('\nWaiting for scan...')
    }

    if (connection === 'open') {
      const user = sock.user
      const phone = user?.id ? await resolveJid(sock, user.id) : 'unknown'
      console.log('\n✅  Connected successfully!')
      console.log(`    Phone : ${phone}`)
      console.log(`    Name  : ${user?.name ?? '(no name)'}`)
      console.log('\nsilentwolf is working correctly. Listening for messages... (Ctrl+C to stop)\n')
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0] ?? `code ${statusCode}`

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`\n⛔  Logged out (${reason}). Delete the "${AUTH_FOLDER}" folder and re-run to re-link.\n`)
        process.exit(0)
      }

      console.log(`\n⚠️  Connection closed (${reason}). Reconnecting in 3s...`)
      setTimeout(startConnection, 3000)
    }
  })

  // ── Messages ───────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue

      const chatJid = msg.key.remoteJid ?? ''
      const isGroup = chatJid.endsWith('@g.us')
      const senderJid = isGroup ? (msg.key.participant ?? chatJid) : chatJid

      const chat = await resolveJid(sock, chatJid)
      const sender = await resolveJid(sock, senderJid)
      const prefix = isGroup ? `${chat} | ${sender}` : sender

      const msgContent = msg.message

      if (!msgContent) {
        // msg.key.isViewOnce is set when the view-once has already been opened
        // on the primary device and WhatsApp sent an "unavailable" placeholder
        if (msg.key.isViewOnce) {
          console.log(`\n👁️  ${prefix}: [view-once — already opened on device, media unavailable]`)
        }
        continue
      }

      // ── View-once detection ──────────────────────────────────────────────
      const viewOnceMedia = extractViewOnceMedia(msgContent)

      if (viewOnceMedia) {
        const typeLabel = viewOnceMedia.mediaType === 'image' ? '🖼️  photo'
          : viewOnceMedia.mediaType === 'video' ? '🎥  video'
          : '🎤  voice'

        console.log(`\n👁️  ${prefix}: [view-once ${typeLabel}] — downloading...`)

        const saved = await downloadViewOnce(viewOnceMedia, sender)
        if (saved) {
          console.log(`    ✅ Saved → ${saved}`)
        }
        continue
      }

      // ── Regular messages ─────────────────────────────────────────────────
      const text =
        msgContent.conversation ??
        msgContent.extendedTextMessage?.text ??
        msgContent.imageMessage?.caption ??
        msgContent.videoMessage?.caption ??
        msgContent.documentMessage?.fileName ??
        (msgContent.audioMessage ? '[voice note]' :
        msgContent.stickerMessage ? '[sticker]' :
        '[non-text message]')

      console.log(`\n📨  ${prefix}: ${text}`)
    }
  })
}

if (PHONE_NUMBER) {
  console.log(`\nStarting silentwolf in pair-code mode for +${PHONE_NUMBER}...`)
} else {
  console.log('\nStarting silentwolf in QR-code mode...')
  console.log('Tip: pass a phone number as an argument to use pair-code mode instead.')
  console.log('     pnpm --filter @workspace/scripts run test-silentwolf 15551234567\n')
}

startConnection().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
