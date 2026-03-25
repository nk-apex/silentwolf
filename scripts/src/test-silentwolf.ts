import { Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidDecode,
} from '@workspace/silentwolf'
import qrcode from 'qrcode-terminal'
import P from 'pino'

const AUTH_FOLDER = './silentwolf_auth'

const logger = P({ level: 'warn' })

/**
 * Parse a phone number from CLI arg or env var.
 * Usage:  pnpm test-silentwolf 15551234567
 *    or:  PHONE_NUMBER=15551234567 pnpm test-silentwolf
 * Leave empty to use QR code mode instead.
 */
const PHONE_NUMBER = (process.argv[2] ?? process.env.PHONE_NUMBER ?? '').replace(/\D/g, '')

/**
 * Convert a WhatsApp JID to a human-readable number/label.
 * e.g. "15551234567:3@s.whatsapp.net" → "+15551234567"
 *      "15551234567@g.us"             → "[Group 15551234567]"
 */
function jidToLabel(jid: string | null | undefined): string {
  if (!jid) return 'unknown'
  const decoded = jidDecode(jid)
  if (!decoded) return jid
  if (decoded.server === 'g.us') return `[Group ${decoded.user}]`
  if (decoded.server === 'broadcast') return '[Broadcast]'
  return `+${decoded.user}`
}

async function startConnection() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)

  const { version, isLatest } = await fetchLatestBaileysVersion()

  const mode = PHONE_NUMBER ? `pair-code (${PHONE_NUMBER})` : 'QR code'
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

  // ── Pair-code mode ────────────────────────────────────────────────────────
  if (PHONE_NUMBER && !state.creds.registered) {
    // Small delay to let the socket handshake complete before requesting code
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER)
      // Format as XXXX-XXXX for readability
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

  // ── QR-code mode ─────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !PHONE_NUMBER) {
      console.log('\n📱  Scan this QR code with your WhatsApp (Linked Devices → Link a Device):\n')
      qrcode.generate(qr, { small: true })
      console.log('\nWaiting for scan...')
    }

    if (connection === 'open') {
      const user = sock.user
      const phone = user?.id ? jidToLabel(user.id) : 'unknown'
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

  // ── Incoming messages ─────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue

      const from = jidToLabel(msg.key.remoteJid)
      const participant = msg.key.participant ? ` (from ${jidToLabel(msg.key.participant)})` : ''

      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.imageMessage?.caption ??
        msg.message?.videoMessage?.caption ??
        msg.message?.documentMessage?.fileName ??
        '[non-text message]'

      console.log(`\n📨  ${from}${participant}: ${text}`)
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
