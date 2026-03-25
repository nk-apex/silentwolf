import { Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@workspace/silentwolf'
import qrcode from 'qrcode-terminal'
import P from 'pino'

const AUTH_FOLDER = './silentwolf_auth'

const logger = P({ level: 'warn' })

async function startConnection() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)

  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`\n🐺 silentwolf — using WA v${version.join('.')}${isLatest ? ' (latest)' : ' (update available)'}`)
  console.log('─────────────────────────────────────────────')

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['silentwolf', 'Chrome', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\n📱 Scan this QR code with your WhatsApp (Linked Devices → Link a Device):\n')
      qrcode.generate(qr, { small: true })
      console.log('\nWaiting for scan...')
    }

    if (connection === 'open') {
      const user = sock.user
      const phone = user?.id?.split(':')[0] ?? 'unknown'
      console.log('\n✅  Connected successfully!')
      console.log(`    Phone : +${phone}`)
      console.log(`    Name  : ${user?.name ?? '(no name)'}`)
      console.log('\nsilentwolf is working correctly. Press Ctrl+C to stop.\n')
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

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        const from = msg.key.remoteJid ?? 'unknown'
        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          '[non-text message]'
        console.log(`\n📨 Message from ${from}: ${text}`)
      }
    }
  })
}

console.log('\nStarting silentwolf test connection...')
startConnection().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
