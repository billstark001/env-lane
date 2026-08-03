import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EnvLaneError } from '@env-lane/core'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const KDF_SALT = Buffer.from('env-store-v1-kdf-salt', 'utf8')
const KDF_OPTS = { N: 16384, r: 8, p: 1 }

export function deriveVaultKey(keyFilePath: string): Buffer {
  const abs = path.resolve(keyFilePath)
  if (!existsSync(abs)) {
    throw new EnvLaneError('VAULT_KEY_NOT_FOUND', `Key file does not exist: ${abs}`)
  }
  const material = readFileSync(abs)
  if (!material.length) throw new EnvLaneError('VAULT_KEY_EMPTY', `Key file is empty: ${abs}`)
  return scryptSync(material, KDF_SALT, 32, KDF_OPTS)
}

export function deriveVaultSyncKey(vaultKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      vaultKey,
      Buffer.from('env-lane-vault-sync-state-v1', 'utf8'),
      Buffer.from('value-fingerprint', 'utf8'),
      32,
    ),
  )
}

export function encryptRecord(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptRecord(key: Buffer, line: string): string {
  const buf = Buffer.from(line, 'base64')
  if (buf.length <= IV_LEN + TAG_LEN) {
    throw new EnvLaneError('VAULT_INVALID_RECORD', 'Encrypted record is too short.')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
