/**
 * Defaults/index.ts — Library-wide Constants and Default Configuration
 *
 * This file has two purposes:
 *
 *   1. CONSTANTS — Fixed values that define the binary protocol, media paths,
 *      timeouts, and WhatsApp's wire format.  These are derived from reverse-
 *      engineering WhatsApp Web and should not change unless WhatsApp updates
 *      its protocol.
 *
 *   2. DEFAULT_CONNECTION_CONFIG — The default values for every SocketConfig
 *      field.  Users override only the fields they care about; the rest come
 *      from here.  makeWASocket (Socket/index.ts) merges user config on top of
 *      these defaults.
 *
 * IF YOU'RE WONDERING HOW TO CHANGE A DEFAULT:
 * ─────────────────────────────────────────────
 * Don't edit this file.  Instead, pass the option when calling makeWASocket:
 *
 *   makeWASocket({
 *     auth: state,
 *     syncFullHistory: false,           // don't download full history
 *     markOnlineOnConnect: false,       // stay invisible
 *     keepAliveIntervalMs: 15_000,      // ping every 15 s
 *   })
 */

import { proto } from '../../WAProto/index.js'
import { makeLibSignalRepository } from '../Signal/libsignal'
import type { AuthenticationState, SocketConfig, WAVersion } from '../Types'
import { Browsers } from '../Utils/browser-utils'
import logger from '../Utils/logger'

// ── Protocol Version ──────────────────────────────────────────────────────────

/**
 * The WhatsApp Web protocol version reported to the server during handshake.
 *
 * Format: [major, minor, patch]
 * WhatsApp periodically bumps the minor/patch values; using an outdated version
 * may result in the server rejecting the connection with a 403 or 419.
 */
const version = [2, 3000, 1027934701]

// ── Auth / Connection Constants ───────────────────────────────────────────────

/**
 * HTTP status codes that mean "you are not authorised — scan QR / re-link".
 *
 *   401 — Unpaired (session not recognised)
 *   403 — Forbidden (account banned or session revoked)
 *   419 — Device count exceeded (too many linked devices)
 */
export const UNAUTHORIZED_CODES = [401, 403, 419]

/** The Origin header sent with every WebSocket upgrade request. */
export const DEFAULT_ORIGIN = 'https://web.whatsapp.com'

// ── Call URL Prefixes ─────────────────────────────────────────────────────────

/** URL prefix for WhatsApp video calls (used in call notifications). */
export const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/'
/** URL prefix for WhatsApp voice calls (used in call notifications). */
export const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/'

// ── Internal Callback / Tag Prefixes ─────────────────────────────────────────

/**
 * Prefix for callback-based message tags.
 * The socket uses these to route incoming frames to waiting Promise resolvers.
 */
export const DEF_CALLBACK_PREFIX = 'CB:'
export const DEF_TAG_PREFIX = 'TAG:'

/** Tag used for keep-alive (Pong) responses from the server. */
export const PHONE_CONNECTION_CB = 'CB:Pong'

// ── Account Signature Prefixes ────────────────────────────────────────────────

/**
 * These byte prefixes are prepended to identity keys before signing.
 * The specific prefix indicates what kind of account/device is being verified.
 *
 *   [6, 0] — Standard WA account signature
 *   [6, 1] — Standard WA device signature
 *   [6, 5] — Hosted (Business API) account signature
 *   [6, 6] — Hosted (Business API) device signature
 */
export const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
export const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6])

// ── Disappearing Messages ─────────────────────────────────────────────────────

/**
 * Default ephemeral message timer: 7 days (in seconds).
 * This is the duration after which disappearing messages auto-delete.
 * Can be changed per-chat with sock.chatModify().
 */
export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60

// ── Noise Protocol Constants ──────────────────────────────────────────────────

/**
 * The Noise protocol pattern used for the WebSocket transport.
 *
 * "Noise_XX_25519_AESGCM_SHA256" means:
 *   • XX       — both parties exchange static public keys (mutual auth)
 *   • 25519    — X25519 (Curve25519) for Diffie-Hellman key exchange
 *   • AESGCM   — AES-256-GCM for symmetric encryption after handshake
 *   • SHA256   — SHA-256 for hashing during handshake
 *
 * The \0\0\0\0 padding brings the string to exactly 32 bytes (required by
 * the Noise spec for the initial handshake hash).
 */
export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'

/**
 * Dictionary version number.  WhatsApp uses a pre-shared dictionary to
 * compress common XML-like binary node tag names and attribute names.
 * Version 3 is current.
 */
export const DICT_VERSION = 3

/**
 * Version byte prepended to Curve25519 public keys in some contexts.
 * [5] = DH key type in the Signal/X3DH key bundle format.
 */
export const KEY_BUNDLE_TYPE = Buffer.from([5])

/**
 * The 4-byte header prepended to every WebSocket frame:
 *   [87, 65] = "WA" (ASCII, identifies the protocol)
 *   [6]      = protocol major version
 *   [3]      = DICT_VERSION (dictionary version)
 *
 * This header is sent exactly once at the start of the connection (intro frame)
 * and used during the Noise handshake.
 */
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION])

/** Regex for detecting URLs in message text (used for link preview generation). */
export const URL_REGEX = /https:\/\/(?![^:@\/\s]+:[^:@\/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g

// ── Certificate Verification ──────────────────────────────────────────────────

/**
 * Details used to verify WhatsApp's server-side TLS certificate during the
 * Noise handshake.  WhatsApp sends a certificate chain; we check the issuer
 * serial matches SERIAL 0.
 *
 * TODO: Implement full certificate chain validation using WhatsApp's root CA.
 */
export const WA_CERT_DETAILS = {
        SERIAL: 0
}

// ── History Sync ──────────────────────────────────────────────────────────────

/**
 * Which HistorySync types silentwolf processes when WhatsApp sends message history.
 *
 * On first linking, WhatsApp pushes the device's message history as a series
 * of HistorySync messages.  Only these types are meaningful to process:
 *
 *   INITIAL_BOOTSTRAP — The first batch of chats/messages delivered on link
 *   PUSH_NAME         — Contact push names (display names)
 *   RECENT            — Recent messages that arrived while disconnected
 *   FULL              — Full history dump (when syncFullHistory: true)
 *   ON_DEMAND         — History requested explicitly by the client
 *   NON_BLOCKING_DATA — Background sync (doesn't block the UI)
 *   INITIAL_STATUS_V3 — Status/story history
 */
export const PROCESSABLE_HISTORY_TYPES = [
        proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
        proto.HistorySync.HistorySyncType.PUSH_NAME,
        proto.HistorySync.HistorySyncType.RECENT,
        proto.HistorySync.HistorySyncType.FULL,
        proto.HistorySync.HistorySyncType.ON_DEMAND,
        proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
        proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3
]

// ── Default Socket Configuration ──────────────────────────────────────────────

/**
 * DEFAULT_CONNECTION_CONFIG — Sensible defaults for every SocketConfig field.
 *
 * Users should NOT edit this object.  Instead, pass overrides to makeWASocket:
 *   makeWASocket({ auth: state, syncFullHistory: false })
 *
 * Fields explained:
 *   version                  — WA protocol version reported to server
 *   browser                  — How this client appears in Linked Devices
 *   waWebSocketUrl           — The WebSocket endpoint for WhatsApp Web
 *   connectTimeoutMs         — How long to wait before giving up on connect (20 s)
 *   keepAliveIntervalMs      — How often to ping the server (30 s)
 *   logger                   — Pino logger (set level:'warn' for less noise)
 *   emitOwnEvents            — Emit events for your own sent messages
 *   defaultQueryTimeoutMs    — Timeout for query/response cycles (60 s)
 *   customUploadHosts        — Override media upload endpoints
 *   retryRequestDelayMs      — Delay between delivery-retry requests (250 ms)
 *   maxMsgRetryCount         — How many times to retry decrypting a message (5)
 *   fireInitQueries          — Send initial presence/app-state queries on connect
 *   auth                     — Required: your AuthenticationState
 *   markOnlineOnConnect      — Send "online" presence when connected
 *   syncFullHistory          — Download full message history on first link
 *   patchMessageBeforeSending — Hook to modify messages before they're sent
 *   shouldSyncHistoryMessage  — Filter which history messages to import
 *   shouldIgnoreJid          — Filter which JIDs to skip event emission for
 *   linkPreviewImageThumbnailWidth — Width of link preview thumbnails (192 px)
 *   transactionOpts          — Signal key-store transaction retry settings
 *   generateHighQualityLinkPreview — Use full-res link preview images
 *   enableAutoSessionRecreation    — Automatically recreate broken Signal sessions
 *   enableRecentMessageCache       — Cache recent messages for delivery retries
 *   options                  — Extra fetch() options (proxy, headers, etc.)
 *   appStateMacVerification  — Verify app-state patches and snapshots (slow)
 *   countryCode              — Your country code for phone number formatting
 *   getMessage               — Fetch a stored message by key (needed for retries)
 *   cachedGroupMetadata      — Provide cached group metadata to skip server fetch
 *   makeSignalRepository     — Factory for the Signal crypto repository
 */
export const DEFAULT_CONNECTION_CONFIG: SocketConfig = {
        version: version as WAVersion,
        browser: Browsers.macOS('Chrome'),
        waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
        connectTimeoutMs: 20_000,          // 20 seconds
        keepAliveIntervalMs: 30_000,       // 30 seconds
        logger: logger.child({ class: 'baileys' }),
        emitOwnEvents: true,
        defaultQueryTimeoutMs: 60_000,     // 60 seconds
        customUploadHosts: [],
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        fireInitQueries: true,
        auth: undefined as unknown as AuthenticationState,  // MUST be provided by user
        markOnlineOnConnect: true,
        syncFullHistory: true,
        patchMessageBeforeSending: msg => msg,             // identity (no-op) by default
        shouldSyncHistoryMessage: () => true,
        shouldIgnoreJid: () => false,
        linkPreviewImageThumbnailWidth: 192,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
        generateHighQualityLinkPreview: false,
        enableAutoSessionRecreation: true,
        enableRecentMessageCache: true,
        options: {},
        appStateMacVerification: {
                patch: false,
                snapshot: false
        },
        countryCode: 'US',
        getMessage: async () => undefined,
        cachedGroupMetadata: async () => undefined,
        makeSignalRepository: makeLibSignalRepository
}

// ── Media Upload / Download ───────────────────────────────────────────────────

/**
 * URL path segments for each media type on WhatsApp's upload/download servers.
 *
 * When uploading media, the client picks the right path for the media type.
 * When downloading, the URL is embedded in the message — but this map is used
 * to validate and construct upload URLs.
 */
export const MEDIA_PATH_MAP: { [T in MediaType]?: string } = {
        image: '/mms/image',
        video: '/mms/video',
        document: '/mms/document',
        audio: '/mms/audio',
        sticker: '/mms/image',
        'thumbnail-link': '/mms/image',
        'product-catalog-image': '/product/image',
        'md-app-state': '',
        'md-msg-hist': '/mms/md-app-state',
        'biz-cover-photo': '/pps/biz-cover-photo'
}

/**
 * HKDF info strings for each media type.
 *
 * Media keys are derived from a root media key using HKDF.  The `info` string
 * is the domain-separation label that makes keys for different media types
 * cryptographically independent even if the root key is the same.
 *
 * WhatsApp uses these exact strings in its HKDF calls — changing them would
 * break decryption of received media.
 */
export const MEDIA_HKDF_KEY_MAPPING = {
        audio: 'Audio',
        document: 'Document',
        gif: 'Video',
        image: 'Image',
        ppic: '',
        product: 'Image',
        ptt: 'Audio',        // Push-to-talk (voice note)
        sticker: 'Image',
        video: 'Video',
        'thumbnail-document': 'Document Thumbnail',
        'thumbnail-image': 'Image Thumbnail',
        'thumbnail-video': 'Video Thumbnail',
        'thumbnail-link': 'Link Thumbnail',
        'md-msg-hist': 'History',
        'md-app-state': 'App State',
        'product-catalog-image': '',
        'payment-bg-image': 'Payment Background',
        ptv: 'Video',        // Personal-to-view (view-once video)
        'biz-cover-photo': 'Image'
}

/** Union of all valid media type strings (keys of MEDIA_HKDF_KEY_MAPPING). */
export type MediaType = keyof typeof MEDIA_HKDF_KEY_MAPPING

/** Array of all media types that have a known upload path. */
export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP) as MediaType[]

// ── Signal Pre-Key Thresholds ─────────────────────────────────────────────────

/**
 * The minimum number of one-time pre-keys that should be available on the
 * server at all times.  If the server reports fewer than this, the client
 * generates and uploads a fresh batch.
 */
export const MIN_PREKEY_COUNT = 5

/**
 * How many pre-keys to generate and upload in the initial batch.
 * 812 keys covers roughly 2 years of normal usage at ~1 new session/day.
 */
export const INITIAL_PREKEY_COUNT = 812

// ── Upload / Download Timeouts ────────────────────────────────────────────────

/** Maximum time to wait for a media upload to complete (30 seconds). */
export const UPLOAD_TIMEOUT = 30000

/** Minimum pause between consecutive uploads to avoid rate-limiting (5 seconds). */
export const MIN_UPLOAD_INTERVAL = 5000

// ── In-Memory Cache TTLs ──────────────────────────────────────────────────────

/**
 * Time-to-live (in seconds) for various in-memory caches.
 *
 *   SIGNAL_STORE  — Signal key cache (short: keys change frequently)
 *   MSG_RETRY     — Per-message retry counter (1 hour: long enough to cover a retry cycle)
 *   CALL_OFFER    — Incoming call offer cache (5 min: calls don't last longer than this)
 *   USER_DEVICES  — Device-list cache (5 min: devices rarely change)
 */
export const DEFAULT_CACHE_TTLS = {
        SIGNAL_STORE: 5 * 60,   // 5 minutes
        MSG_RETRY: 60 * 60,     // 1 hour
        CALL_OFFER: 5 * 60,     // 5 minutes
        USER_DEVICES: 5 * 60    // 5 minutes
}
