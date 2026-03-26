/**
 * Utils/noise-handler.ts — Noise Protocol Transport Handler
 *
 * This file implements the Noise_XX_25519_AESGCM_SHA256 handshake and the
 * subsequent encrypted framing used for ALL communication with WhatsApp's
 * WebSocket server.
 *
 * ── WHAT IS THE NOISE PROTOCOL? ─────────────────────────────────────────────
 *
 * The Noise Protocol Framework (noiseprotocol.org) is a modern alternative to
 * TLS for application-level encrypted channels.  WhatsApp uses it on top of
 * WebSockets (which are already TLS-protected) for an additional layer of
 * end-to-end encryption between the client and the WA server.
 *
 * The specific pattern "Noise_XX" means both parties exchange static public
 * keys during the handshake (mutual authentication):
 *
 *   Client → Server:  ephemeral_pub_key  (client's fresh EC key for this session)
 *   Client ← Server:  ephemeral_pub_key + static_pub_key (server's long-term key)
 *   Client → Server:  static_pub_key (client's noise key pair)
 *
 * After these 3 steps the handshake is "finished" and both sides derive the
 * same symmetric keys for the rest of the session.
 *
 * ── KEY DERIVATION ───────────────────────────────────────────────────────────
 *
 * After each DH operation the result is mixed into the current `salt` and
 * `encKey`/`decKey` via HKDF.  The counter (writeCounter / readCounter) is
 * used as the 12-byte AES-GCM IV, incrementing with every message.
 *
 * ── FRAMING ─────────────────────────────────────────────────────────────────
 *
 * WhatsApp uses its own framing on top of WebSocket frames:
 *
 *   [3-byte length][payload]
 *
 * Multiple Noise frames can be combined inside a single WS frame, and a
 * single Noise frame can span multiple WS frames.  decodeFrame() buffers
 * incoming bytes and extracts complete frames, then decrypts each one.
 *
 * The very first frame sent by the client is the "intro" frame which includes
 * a 4-byte WA header ("WA" + version + dict version) and, optionally, routing
 * information for Business API users.  After the intro, the header is omitted.
 */

import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { NOISE_MODE, WA_CERT_DETAILS } from '../Defaults'
import type { KeyPair } from '../Types'
import type { BinaryNode } from '../WABinary'
import { decodeBinaryNode } from '../WABinary'
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from './crypto'
import type { ILogger } from './logger'

/**
 * Build a 12-byte AES-GCM IV (nonce) from a counter value.
 *
 * The IV is a 12-byte buffer with the counter stored as a 4-byte big-endian
 * integer in bytes 8-11 (the last 4 bytes).  Bytes 0-7 are zero.
 *
 * AES-GCM IVs must NEVER be reused with the same key — using an incrementing
 * counter guarantees uniqueness as long as the counter doesn't wrap (it would
 * take ~4 billion messages to wrap, which is more than enough).
 *
 * @param counter - The current send/receive counter (incremented after each frame)
 * @returns 12-byte Uint8Array
 */
const generateIV = (counter: number) => {
        const iv = new ArrayBuffer(12)
        new DataView(iv).setUint32(8, counter)   // store counter in the last 4 bytes

        return new Uint8Array(iv)
}

/**
 * makeNoiseHandler — Create a Noise protocol state machine for one WebSocket session.
 *
 * This function is called once per WebSocket connection in makeSocket().
 * It returns an object with methods for each phase of the Noise handshake and
 * for ongoing encrypted frame encode/decode.
 *
 * @param keyPair     - The client's static noise key pair (from auth.creds.noiseKey)
 * @param NOISE_HEADER - 4-byte WA header bytes ([87, 65, 6, DICT_VERSION])
 * @param logger      - Pino logger for trace output
 * @param routingInfo - Optional routing metadata for WhatsApp Business API accounts
 *
 * @returns Noise state machine with: encrypt, decrypt, processHandshake,
 *   encodeFrame, decodeFrame, authenticate, mixIntoKey, finishInit
 */
export const makeNoiseHandler = ({
        keyPair: { private: privateKey, public: publicKey },
        NOISE_HEADER,
        logger,
        routingInfo
}: {
        keyPair: KeyPair
        NOISE_HEADER: Uint8Array
        logger: ILogger
        routingInfo?: Buffer | undefined
}) => {
        // Use a child logger tagged 'ns' (Noise) so log messages are easy to filter
        logger = logger.child({ class: 'ns' })

        // ── Noise State Variables ──────────────────────────────────────────────
        // These implement the Noise handshake state as per the spec.
        // They are closures — private to this noise handler instance.

        // The "handshake hash" — a running digest of everything sent/received.
        // It grows to authenticate the entire transcript.
        // Initialised from NOISE_MODE (the protocol name string).
        const data = Buffer.from(NOISE_MODE)
        let hash = data.byteLength === 32 ? data : sha256(data)

        // The "chaining key" — updated with each DH operation via HKDF.
        // Used to derive encKey and decKey.
        let salt = hash

        // Symmetric encryption key (for data we SEND to the server)
        let encKey = hash
        // Symmetric decryption key (for data we RECEIVE from the server)
        // During the handshake both enc and dec use the same key
        let decKey = hash

        // Per-direction frame counters — used as the AES-GCM IV
        let readCounter = 0
        let writeCounter = 0

        // Whether the Noise handshake has completed.
        // Before: one shared counter (writeCounter) is used for both directions.
        // After:  separate counters for each direction.
        let isFinished = false

        // Whether we've already sent the intro frame (WA header + routing info).
        // The intro is only sent once at the very start of the connection.
        let sentIntro = false

        // Buffer for accumulating incoming bytes across multiple WS frames
        let inBytes = Buffer.alloc(0)

        // ── Authenticate the initial Noise state ───────────────────────────────
        // These calls "mix" the WA header and our public key into the handshake
        // hash.  This ties the encryption keys to the specific protocol parameters
        // and our identity, so any tampering or replay would invalidate the hash.
        authenticate(NOISE_HEADER)
        authenticate(publicKey)

        /**
         * Mix `data` into the running handshake hash.
         *
         * Called with every piece of handshake data sent or received.  Once the
         * handshake is finished (isFinished = true) the hash is reset and
         * authentication is no longer needed.
         */
        function authenticate(data: Uint8Array) {
                if (!isFinished) {
                        hash = sha256(Buffer.concat([hash, data]))
                }
        }

        /**
         * Encrypt a plaintext frame with the current Noise key state.
         *
         * Uses the current `encKey` and `writeCounter` as the AES-GCM key/IV.
         * The current `hash` is the "additional data" for GCM, which means
         * the ciphertext is authenticated against the full handshake transcript.
         *
         * After encryption, the counter increments and the ciphertext is
         * authenticated (mixed into the hash) — during the handshake phase.
         */
        const encrypt = (plaintext: Uint8Array) => {
                const result = aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash)

                writeCounter += 1

                // During handshake: mix ciphertext into hash to authenticate the transcript
                authenticate(result)
                return result
        }

        /**
         * Decrypt an incoming frame with the current Noise key state.
         *
         * Before handshake completion: use writeCounter (shared counter).
         * After handshake completion:  use readCounter (separate per-direction counter).
         *
         * The hash is used as AES-GCM additional data — if the server tampers with
         * the ciphertext OR the additional data, decryption will throw.
         */
        const decrypt = (ciphertext: Uint8Array) => {
                // Before the handshake is finished both sides use writeCounter;
                // after finishing they use separate readCounter / writeCounter.
                const iv = generateIV(isFinished ? readCounter : writeCounter)
                const result = aesDecryptGCM(ciphertext, decKey, iv, hash)

                if (isFinished) {
                        readCounter += 1   // post-handshake: increment read counter
                } else {
                        writeCounter += 1  // during handshake: shared counter
                }

                // Mix the received ciphertext into the hash (handshake transcript authentication)
                authenticate(ciphertext)
                return result
        }

        /**
         * Run HKDF on the given data against the current `salt`, producing
         * 64 bytes split into [write (32 bytes), read (32 bytes)].
         *
         * This is the Noise protocol's "MixKey" step: after every DH operation
         * the shared secret is fed into HKDF to derive new encryption keys and
         * update the chaining salt.
         */
        const localHKDF = async (data: Uint8Array) => {
                const key = await hkdf(Buffer.from(data), 64, { salt, info: '' })
                return [key.slice(0, 32), key.slice(32)]
        }

        /**
         * Mix a DH shared secret into the symmetric key state.
         *
         * Called after each Diffie-Hellman operation during the handshake.
         * Updates salt, encKey, decKey, and resets counters.
         * The first 32 bytes of HKDF output become the new salt (chaining key);
         * the second 32 bytes become both enc and dec key (same key pre-handshake).
         */
        const mixIntoKey = async (data: Uint8Array) => {
                const [write, read] = await localHKDF(data)
                salt = write!
                encKey = read!
                decKey = read!   // during handshake enc and dec are the same key
                readCounter = 0
                writeCounter = 0
        }

        /**
         * Finalise the Noise handshake.
         *
         * Called after the last DH operation.  HKDF is run on an empty input
         * to derive the two final independent keys: write key (for outgoing data)
         * and read key (for incoming data).  After this point enc and dec keys
         * differ — full duplex encryption begins.
         *
         * Also resets the handshake hash (no more transcript authentication needed)
         * and sets isFinished = true so counters split into per-direction.
         */
        const finishInit = async () => {
                const [write, read] = await localHKDF(new Uint8Array(0))
                encKey = write!
                decKey = read!
                hash = Buffer.from([])    // handshake is done — reset the hash
                readCounter = 0
                writeCounter = 0
                isFinished = true
        }

        return {
                encrypt,
                decrypt,
                authenticate,
                mixIntoKey,
                finishInit,

                /**
                 * processHandshake — Handle the server's ServerHello message.
                 *
                 * This is step 2 of the Noise_XX handshake (client receives the server's
                 * ephemeral key, static key, and certificate payload):
                 *
                 *   1. Authenticate and DH with server's ephemeral key
                 *   2. Decrypt and DH with server's static key
                 *   3. Decrypt and verify the server's certificate chain
                 *   4. Encrypt and send back our noise public key
                 *   5. DH our noise private key with server's ephemeral key
                 *
                 * @param serverHello - Decoded ServerHello protobuf from the server
                 * @param noiseKey    - Our client static noise key pair
                 * @returns The encrypted client noise public key to send back to the server
                 */
                processHandshake: async ({ serverHello }: proto.HandshakeMessage, noiseKey: KeyPair) => {
                        // Step 1: Mix in server's ephemeral pub key and do DH
                        authenticate(serverHello!.ephemeral!)
                        await mixIntoKey(Curve.sharedKey(privateKey, serverHello!.ephemeral!))

                        // Step 2: Decrypt server's static key and do another DH
                        const decStaticContent = decrypt(serverHello!.static!)
                        await mixIntoKey(Curve.sharedKey(privateKey, decStaticContent))

                        // Step 3: Decrypt the certificate payload and verify the server's serial
                        const certDecoded = decrypt(serverHello!.payload!)
                        const { intermediate: certIntermediate } = proto.CertChain.decode(certDecoded)
                        // TODO: Also verify the leaf certificate (full chain validation)
                        const { issuerSerial } = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate!.details!)

                        if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
                                // The server's certificate doesn't match what we expect.
                                // This could indicate a MITM attack or an outdated WA_CERT_DETAILS.
                                throw new Boom('certification match failed', { statusCode: 400 })
                        }

                        // Step 4: Encrypt our noise public key and send it back
                        const keyEnc = encrypt(noiseKey.public)

                        // Step 5: DH our noise private key with server's ephemeral → finalises authentication
                        await mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello!.ephemeral!))

                        return keyEnc  // caller sends this back to the server
                },

                /**
                 * encodeFrame — Wrap a binary payload in a Noise frame for sending.
                 *
                 * If the handshake is finished, the payload is AES-GCM encrypted first.
                 * The frame format is:
                 *
                 *   [3-byte length (big-endian)][payload]
                 *
                 * For the very first frame (intro), the WA header ([87,65,6,3]) is
                 * prepended — and for Business API accounts, routing info is included.
                 * All subsequent frames skip the header.
                 *
                 * @param data - The raw binary payload to send
                 * @returns A Buffer ready to be sent over the WebSocket
                 */
                encodeFrame: (data: Buffer | Uint8Array) => {
                        if (isFinished) {
                                // Post-handshake: encrypt before framing
                                data = encrypt(data)
                        }

                        let header: Buffer

                        if (routingInfo) {
                                // Business API: prepend routing header before the WA header
                                // Format: "ED" + [0x00, 0x01] + [routingInfo.length (3 bytes)] + routingInfo
                                header = Buffer.alloc(7)
                                header.write('ED', 0, 'utf8')
                                header.writeUint8(0, 2)
                                header.writeUint8(1, 3)
                                header.writeUint8(routingInfo.byteLength >> 16, 4)
                                header.writeUint16BE(routingInfo.byteLength & 65535, 5)
                                header = Buffer.concat([header, routingInfo, NOISE_HEADER])
                        } else {
                                header = Buffer.from(NOISE_HEADER)
                        }

                        // Only the first frame includes the WA protocol header
                        const introSize = sentIntro ? 0 : header.length
                        const frame = Buffer.alloc(introSize + 3 + data.byteLength)

                        if (!sentIntro) {
                                frame.set(header)   // write the WA header into the frame
                                sentIntro = true
                        }

                        // Write the 3-byte big-endian payload length
                        frame.writeUInt8(data.byteLength >> 16, introSize)
                        frame.writeUInt16BE(65535 & data.byteLength, introSize + 1)
                        // Write the payload itself
                        frame.set(data, introSize + 3)

                        return frame
                },

                /**
                 * decodeFrame — Extract and process complete Noise frames from a byte stream.
                 *
                 * WhatsApp's binary protocol adds its own 3-byte length-prefixed framing
                 * on top of WebSocket frames.  Because WebSocket messages can be fragmented,
                 * we buffer incoming bytes and extract frames as they become complete.
                 *
                 * For each complete frame:
                 *   • Before handshake: pass raw bytes to onFrame (for handshake processing)
                 *   • After handshake:  decrypt the frame, then decode binary node and pass to onFrame
                 *
                 * @param newData - New bytes received from the WebSocket
                 * @param onFrame - Callback invoked for each complete decoded frame/node
                 */
                decodeFrame: async (newData: Buffer | Uint8Array, onFrame: (buff: Uint8Array | BinaryNode) => void) => {
                        // Append new bytes to the accumulation buffer
                        inBytes = Buffer.concat([inBytes, newData])

                        logger.trace(`recv ${newData.length} bytes, total recv ${inBytes.length} bytes`)

                        // Read the 3-byte length prefix: [byte2 byte1 byte0] = big-endian 24-bit int
                        const getBytesSize = () => {
                                if (inBytes.length >= 3) {
                                        return (inBytes.readUInt8() << 16) | inBytes.readUInt16BE(1)
                                }
                        }

                        let size = getBytesSize()
                        // Process as many complete frames as we have buffered
                        while (size && inBytes.length >= size + 3) {
                                // Extract the frame payload (skip the 3-byte length prefix)
                                let frame: Uint8Array | BinaryNode = inBytes.slice(3, size + 3)
                                // Remove this frame from the buffer
                                inBytes = inBytes.slice(size + 3)

                                if (isFinished) {
                                        // Post-handshake: decrypt and then decode as a BinaryNode
                                        const result = decrypt(frame)
                                        frame = await decodeBinaryNode(result)
                                }

                                logger.trace({ msg: (frame as BinaryNode)?.attrs?.id }, 'recv frame')

                                onFrame(frame)
                                size = getBytesSize()
                        }
                }
        }
}
