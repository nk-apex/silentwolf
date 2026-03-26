/**
 * Utils/crypto.ts — Cryptographic Primitives
 *
 * All cryptographic operations used by silentwolf are centralised here.
 * WhatsApp's security model relies on several layers:
 *
 *   1. TRANSPORT LAYER — Noise_XX_25519_AESGCM_SHA256
 *      The WebSocket connection is encrypted using the Noise protocol with
 *      X25519 key exchange, AES-256-GCM for encryption, and SHA-256 for
 *      hashing.  See noise-handler.ts for how these primitives are used.
 *
 *   2. MESSAGE LAYER — Signal Protocol (Double Ratchet)
 *      Each message is end-to-end encrypted using the Signal protocol.
 *      libsignal handles the Double Ratchet session; this file provides the
 *      lower-level key agreement (Curve25519), signing, and AES helpers that
 *      Signal builds on top of.
 *
 *   3. PAIRING — PBKDF2 + HKDF
 *      When linking a new device via pairing code, derivePairingCodeKey turns
 *      the 8-character code into a 256-bit key using PBKDF2 with 131,072
 *      iterations (slow by design, to resist brute-force).
 *
 * ALGORITHM SUMMARY
 * ─────────────────
 *   Curve25519   — Elliptic-curve Diffie-Hellman key exchange (via libsignal)
 *   AES-256-GCM  — Authenticated encryption (used in the Noise transport layer)
 *   AES-256-CBC  — Block cipher (used for key bundles and some legacy paths)
 *   AES-256-CTR  — Stream cipher (used in some media key derivation paths)
 *   HMAC-SHA-256 — Message authentication
 *   SHA-256      — General-purpose hash
 *   MD5          — Used only for generating Content-MD5 headers (upload validation)
 *   HKDF         — Key derivation (from a shared secret → multiple derived keys)
 *   PBKDF2       — Password-based key derivation (for pairing codes)
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import * as curve from 'libsignal/src/curve'
import { KEY_BUNDLE_TYPE } from '../Defaults'
import type { KeyPair } from '../Types'

// Use the Web Crypto API's subtle interface which is available in both Node.js
// (v19+) and browser environments.  This ensures HKDF and PBKDF2 use the same
// implementation across runtimes.
const { subtle } = globalThis.crypto

// ── Curve25519 helpers ────────────────────────────────────────────────────────

/**
 * Prepend a version byte (0x05) to a Curve25519 public key if it isn't there
 * already.  Some libsignal functions require this prefix to identify the key
 * type; others return it already included.
 *
 * @param pubKey - A 32-byte or 33-byte Curve25519 public key
 * @returns A 33-byte buffer with the version byte prefix
 */
export const generateSignalPubKey = (pubKey: Uint8Array | Buffer) =>
        pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey])

/**
 * Curve25519 key-pair operations.
 *
 * Wraps libsignal's native bindings with a cleaner TypeScript interface.
 * All keys are plain Buffers — 32 bytes for private keys, 32 bytes for public
 * keys (the version byte is added/removed automatically).
 */
export const Curve = {
        /**
         * Generate a fresh Curve25519 key pair (private + public).
         *
         * The private key is a random 32-byte scalar.  The public key is the
         * corresponding point on the Curve25519 elliptic curve.
         */
        generateKeyPair: (): KeyPair => {
                const { pubKey, privKey } = curve.generateKeyPair()
                return {
                        private: Buffer.from(privKey),
                        // Strip the 0x05 version byte that libsignal adds to pub keys
                        public: Buffer.from(pubKey.slice(1))
                }
        },

        /**
         * Compute a Diffie-Hellman shared secret from one party's private key
         * and the other party's public key.
         *
         * Both parties independently compute the same 32-byte shared secret,
         * which is then used to derive encryption keys via HKDF.
         *
         * @param privateKey - Your private key (32 bytes)
         * @param publicKey  - The other party's public key (32 or 33 bytes)
         * @returns 32-byte shared secret
         */
        sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
                const shared = curve.calculateAgreement(generateSignalPubKey(publicKey), privateKey)
                return Buffer.from(shared)
        },

        /**
         * Sign a message with a Curve25519 private key (XEdDSA signature scheme).
         *
         * Used to sign pre-keys and identity keys so recipients can verify them.
         *
         * @param privateKey - 32-byte signing key
         * @param buf        - Data to sign (any length)
         * @returns 64-byte signature
         */
        sign: (privateKey: Uint8Array, buf: Uint8Array) => curve.calculateSignature(privateKey, buf),

        /**
         * Verify an XEdDSA signature.
         *
         * @param pubKey    - 32-byte public key of the signer
         * @param message   - The original data that was signed
         * @param signature - 64-byte signature to verify
         * @returns true if the signature is valid; false otherwise
         */
        verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
                try {
                        curve.verifySignature(generateSignalPubKey(pubKey), message, signature)
                        return true
                } catch (error) {
                        return false
                }
        }
}

/**
 * Create a signed pre-key for use in the Signal Protocol key bundle.
 *
 * A signed pre-key is a fresh Curve25519 key pair whose public key has been
 * signed with the long-term identity key.  Recipients use this to verify the
 * pre-key belongs to this identity before using it for key agreement.
 *
 * @param identityKeyPair - The long-term identity key pair
 * @param keyId           - An incrementing ID that identifies this pre-key
 * @returns { keyPair, signature, keyId }
 */
export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
        const preKey = Curve.generateKeyPair()
        // Add the version prefix before signing — recipients expect it
        const pubKey = generateSignalPubKey(preKey.public)

        const signature = Curve.sign(identityKeyPair.private, pubKey)

        return { keyPair: preKey, signature, keyId }
}

// ── AES-GCM (Noise transport layer) ──────────────────────────────────────────

/** GCM authentication tag size in bytes (128-bit tag = 16 bytes). */
const GCM_TAG_LENGTH = 128 >> 3

/**
 * Encrypt data with AES-256-GCM (authenticated encryption).
 *
 * AES-GCM provides both confidentiality AND integrity — the auth tag ensures
 * the ciphertext hasn't been tampered with.  This is used in the Noise
 * transport layer for every frame after the handshake.
 *
 * @param plaintext      - Data to encrypt
 * @param key            - 32-byte AES key
 * @param iv             - 12-byte initialisation vector (nonce); NEVER reuse with the same key
 * @param additionalData - Extra data that is authenticated but NOT encrypted
 *                         (the Noise "hash" value — proves context integrity)
 * @returns ciphertext ++ auth_tag (auth tag is appended at the end)
 */
export function aesEncryptGCM(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(additionalData)
        return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/**
 * Decrypt data with AES-256-GCM.
 *
 * The 16-byte auth tag is expected to be appended at the end of ciphertext.
 * If the tag doesn't match, decryption throws — this is the tamper-detection
 * mechanism.
 *
 * @param ciphertext     - Encrypted bytes with auth tag at the end
 * @param key            - 32-byte AES key (must match the encryption key)
 * @param iv             - 12-byte IV (must match the one used during encryption)
 * @param additionalData - Same additional data used during encryption
 * @returns Decrypted plaintext
 */
export function aesDecryptGCM(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        // Split ciphertext from the appended auth tag
        const enc = ciphertext.slice(0, ciphertext.length - GCM_TAG_LENGTH)
        const tag = ciphertext.slice(ciphertext.length - GCM_TAG_LENGTH)
        decipher.setAAD(additionalData)
        decipher.setAuthTag(tag)  // will throw during final() if tag mismatches

        return Buffer.concat([decipher.update(enc), decipher.final()])
}

// ── AES-256-CTR ───────────────────────────────────────────────────────────────

/**
 * Encrypt with AES-256-CTR (counter mode — no padding, stream cipher behaviour).
 * Used in some media key derivation paths.
 */
export function aesEncryptCTR(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
        const cipher = createCipheriv('aes-256-ctr', key, iv)
        return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * Decrypt with AES-256-CTR.
 * CTR mode is symmetric — encryption and decryption use the same operation.
 */
export function aesDecryptCTR(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
        const decipher = createDecipheriv('aes-256-ctr', key, iv)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

// ── AES-256-CBC ───────────────────────────────────────────────────────────────

/**
 * Decrypt with AES-256-CBC where the IV is the FIRST 16 bytes of the buffer.
 *
 * The convention for CBC-encrypted blobs is: [IV (16 bytes)][ciphertext].
 * This function reads the IV from the buffer prefix and decrypts the rest.
 *
 * @param buffer - IV-prefixed ciphertext (IV is first 16 bytes)
 * @param key    - 32-byte AES key
 */
export function aesDecrypt(buffer: Buffer, key: Buffer) {
        return aesDecryptWithIV(buffer.slice(16, buffer.length), key, buffer.slice(0, 16))
}

/**
 * Decrypt with AES-256-CBC using a separately-provided IV.
 *
 * @param buffer - Ciphertext only (no prepended IV)
 * @param key    - 32-byte AES key
 * @param IV     - 16-byte initialisation vector
 */
export function aesDecryptWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
        const aes = createDecipheriv('aes-256-cbc', key, IV)
        return Buffer.concat([aes.update(buffer), aes.final()])
}

/**
 * Encrypt with AES-256-CBC.  A random 16-byte IV is generated and prepended
 * to the ciphertext so the recipient can recover it.
 *
 * @param buffer - Plaintext to encrypt
 * @param key    - 32-byte AES key
 * @returns [IV (16 bytes)][ciphertext]
 */
export function aesEncrypt(buffer: Buffer | Uint8Array, key: Buffer) {
        const IV = randomBytes(16)
        const aes = createCipheriv('aes-256-cbc', key, IV)
        return Buffer.concat([IV, aes.update(buffer), aes.final()])
}

/**
 * Encrypt with AES-256-CBC using a caller-supplied IV (no prepended IV).
 *
 * @param buffer - Plaintext to encrypt
 * @param key    - 32-byte AES key
 * @param IV     - 16-byte initialisation vector
 */
export function aesEncrypWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
        const aes = createCipheriv('aes-256-cbc', key, IV)
        return Buffer.concat([aes.update(buffer), aes.final()])
}

// ── HMAC / Hash ───────────────────────────────────────────────────────────────

/**
 * Compute an HMAC using SHA-256 (default) or SHA-512.
 *
 * HMAC is used for message authentication — verifying that a value was
 * produced by someone who knows the shared key.
 *
 * @param buffer  - Data to authenticate
 * @param key     - The HMAC key
 * @param variant - Hash function to use (default: 'sha256')
 * @returns HMAC digest (32 bytes for sha256, 64 bytes for sha512)
 */
export function hmacSign(
        buffer: Buffer | Uint8Array,
        key: Buffer | Uint8Array,
        variant: 'sha256' | 'sha512' = 'sha256'
) {
        return createHmac(variant, key).update(buffer).digest()
}

/** Compute a SHA-256 hash. */
export function sha256(buffer: Buffer) {
        return createHash('sha256').update(buffer).digest()
}

/** Compute an MD5 hash.  Only used for Content-MD5 upload headers. */
export function md5(buffer: Buffer) {
        return createHash('md5').update(buffer).digest()
}

// ── HKDF (Key Derivation) ─────────────────────────────────────────────────────

/**
 * HKDF (HMAC-based Key Derivation Function) — RFC 5869.
 *
 * Stretches a shared secret into one or more derived keys of arbitrary length.
 * Used throughout the Noise handshake to derive separate enc/dec keys from the
 * ECDH shared secrets.
 *
 * Example use: after computing a Curve25519 shared secret, run it through HKDF
 * to get 64 bytes, then split those into a 32-byte write key and a 32-byte read key.
 *
 * @param buffer         - Input key material (e.g. a Curve25519 shared secret)
 * @param expandedLength - Number of output bytes desired
 * @param info.salt      - Optional random salt (adds entropy; uses zeros if omitted)
 * @param info.info      - Optional context string (binds keys to a specific purpose)
 * @returns A Buffer of `expandedLength` bytes of derived key material
 */
export async function hkdf(
        buffer: Uint8Array | Buffer,
        expandedLength: number,
        info: { salt?: Buffer; info?: string }
): Promise<Buffer> {
        // Normalise to a plain Uint8Array whose .buffer is a regular ArrayBuffer.
        // Cloning via new Uint8Array() guarantees this — sliced Buffers may point
        // into a pooled ArrayBuffer which doesn't satisfy the WebCrypto type checker.
        const inputKeyMaterial = new Uint8Array(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))

        const salt = info.salt ? new Uint8Array(info.salt) : new Uint8Array(0)
        const infoBytes = info.info ? new TextEncoder().encode(info.info) : new Uint8Array(0)

        // Step 1: import the raw key material so WebCrypto can work with it
        const importedKey = await subtle.importKey('raw', inputKeyMaterial as BufferSource, { name: 'HKDF' }, false, [
                'deriveBits'
        ])

        // Step 2: derive the requested number of bits
        const derivedBits = await subtle.deriveBits(
                {
                        name: 'HKDF',
                        hash: 'SHA-256',
                        salt: salt,
                        info: infoBytes
                },
                importedKey,
                expandedLength * 8  // WebCrypto works in bits, not bytes
        )

        return Buffer.from(derivedBits)
}

// ── PBKDF2 (Pairing Code Key Derivation) ─────────────────────────────────────

/**
 * Derive a 256-bit AES key from an 8-character WhatsApp pairing code.
 *
 * WhatsApp uses PBKDF2-HMAC-SHA256 with 131,072 iterations (2 << 16) to turn
 * the short pairing code into a strong encryption key.  The high iteration
 * count is intentional — it makes offline brute-force attacks on captured
 * handshakes impractical.
 *
 * This key is used to decrypt the server's encrypted key material during the
 * phone-number pairing flow (as an alternative to QR-code linking).
 *
 * @param pairingCode - The 8-character pairing code shown on screen (e.g. "ABCD-1234")
 * @param salt        - Random salt from the server's challenge message
 * @returns 32-byte derived key
 */
export async function derivePairingCodeKey(pairingCode: string, salt: Buffer): Promise<Buffer> {
        const encoder = new TextEncoder()
        const pairingCodeBuffer = encoder.encode(pairingCode)
        const saltBuffer = new Uint8Array(salt instanceof Uint8Array ? salt : new Uint8Array(salt))

        // Import the pairing code string as raw key material for PBKDF2
        const keyMaterial = await subtle.importKey('raw', pairingCodeBuffer as BufferSource, { name: 'PBKDF2' }, false, [
                'deriveBits'
        ])

        // 2 << 16 = 131,072 iterations (slow by design — brute-force resistance)
        const derivedBits = await subtle.deriveBits(
                {
                        name: 'PBKDF2',
                        salt: saltBuffer as BufferSource,
                        iterations: 2 << 16,
                        hash: 'SHA-256'
                },
                keyMaterial,
                32 * 8  // 32 bytes = 256 bits
        )

        return Buffer.from(derivedBits)
}
