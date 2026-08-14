import crypto from 'node:crypto'

/**
 * Token encryption at rest. Social access tokens are bearer credentials for
 * someone's real account -- they never touch the DB in plaintext.
 *
 * AES-256-GCM, random 12-byte IV per record, auth tag appended.
 * Wire format: v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 */

const VERSION = 'v1'

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32')
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}. Generate with: openssl rand -base64 32`)
  }
  return buf
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.')
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split('.')
  if (version !== VERSION) throw new Error(`Unsupported ciphertext version: ${version}`)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}

/** Nullable variants -- accounts without a refresh token are common. */
export const encryptOrNull = (v: string | null | undefined) => (v ? encrypt(v) : null)
export const decryptOrNull = (v: string | null | undefined) => (v ? decrypt(v) : null)

/** Password hashing for local team accounts. scrypt, no external dep. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt') return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 })
  return crypto.timingSafeEqual(expected, actual)
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
