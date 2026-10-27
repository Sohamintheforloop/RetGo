/**
 * End-to-end encryption for private help requests (Web Crypto only, no third-party library).
 *
 * Scheme ("sealed box"): ephemeral ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM.
 *  - The app encrypts to the maintainers' PUBLIC key, which is compiled into the app (VITE_MAINTAINER_PUBKEY).
 *    Only the maintainers hold the private key, offline. Our Worker and Cloudflare KV see ciphertext only.
 *  - Each request also carries a fresh per-request reply public key inside the encrypted payload. The maintainer
 *    encrypts the reply to that key, and only this device holds the matching private key.
 * tools/maintainer.py implements the identical scheme in Python.
 */
export interface Envelope {
  v: 1
  epk: string // ephemeral public key, base64 of the 65-byte uncompressed P-256 point
  iv: string // 12-byte AES-GCM nonce, base64
  ct: string // ciphertext + 16-byte tag, base64
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const SALT = enc.encode('rgap-e2ee-v1-salt')
const INFO = enc.encode('rgap-e2ee-v1')
const AAD = enc.encode('rgap-v1')
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

const toB64 = (buf: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(buf)))
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveAesKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const importPublic = (b64: string) => crypto.subtle.importKey('raw', fromB64(b64), CURVE, true, [])

/** Encrypt text so that only the holder of recipientPubB64's private key can read it. */
export async function sealTo(recipientPubB64: string, plaintext: string): Promise<Envelope> {
  const eph = await crypto.subtle.generateKey(CURVE, false, ['deriveBits'])
  const key = await deriveAesKey(eph.privateKey, await importPublic(recipientPubB64))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(plaintext))
  return { v: 1, epk: toB64(await crypto.subtle.exportKey('raw', eph.publicKey)), iv: toB64(iv), ct: toB64(ct) }
}

/** Decrypt an envelope with our private key. Throws if it was tampered with or is for someone else. */
export async function openWith(privateKey: CryptoKey, env: Envelope): Promise<string> {
  const key = await deriveAesKey(privateKey, await importPublic(env.epk))
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: AAD }, key, fromB64(env.ct))
  return dec.decode(pt)
}

/** Fresh per-request reply keypair. The private half is returned as a JWK for local storage. */
export async function newReplyKeypair(): Promise<{ publicB64: string; privateJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])
  return {
    publicB64: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  }
}

export const importPrivateJwk = (jwk: JsonWebKey) => crypto.subtle.importKey('jwk', jwk, CURVE, false, ['deriveBits'])

/** Short fingerprint users can compare with the one published in the GitHub README. */
export async function fingerprint(pubB64: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64(pubB64)))
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return hex.slice(0, 16).match(/.{4}/g)!.join('-')
}
