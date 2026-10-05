import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runRustExample, withOracle } from './rust-support.mjs'

await withOracle(async ({ runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/index.js'))
  )
  const keys = [
    'VALUE',
    'apiKey',
    'HTTPAccessToken',
    'public_key',
    'VITE_SUPABASE_ANON_KEY',
    'DATABASE_URL',
    'token_count',
    'PASSWORD',
    'passwordLength',
    'AWS_ACCESS_KEY_ID',
    ' wallet address ',
    'KEY',
    'provider',
    'USER',
    'private-key',
    '日本語',
    '\uFEFFapiKey\uFEFF',
  ]
  const opaque =
    Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index, 97 + index)).join('') +
    '0123456789_-'
  const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"synthetic-user"}').toString('base64url')}.${'s'.repeat(30)}`
  const values = [
    `日本語ghp_${'a'.repeat(30)}`,
    `before${String.fromCharCode(0xfeff)}password=synthetic-secret`,
    `before${String.fromCharCode(0x85)}password=synthetic-secret`,
    '',
    'visible',
    '1234567',
    '12345678',
    'short-secret-value',
    'http://localhost:3000',
    `https://${'user'}:${'pass'}@example.test`,
    `https://example.test/?api_key=${opaque}`,
    `https://example.test/${opaque}`,
    `password=${opaque}`,
    `{"token":"${opaque}"}`,
    jwt,
    `v4.local.${opaque}`,
    `sb_publishable_${opaque}`,
    `sk-proj-${opaque}`,
    `-----BEGIN PUBLIC KEY-----\n${opaque}\n-----END PUBLIC KEY-----`,
    `-----BEGIN PRIVATE KEY-----\n${opaque}\n-----END PRIVATE KEY-----`,
    opaque,
    Array.from({ length: 64 }, (_, index) => (index % 16).toString(16)).join(''),
    '😀Abc12_'.repeat(9),
    `${String.fromCharCode(0xfeff)}12345678${String.fromCharCode(0xfeff)}`,
    `${String.fromCharCode(0x85)}12345678${String.fromCharCode(0x85)}`,
  ]
  const requests = keys.flatMap((key) => values.map((value) => ({ key, value })))
  const actual = runRustExample('redaction-protocol', requests)
  for (const [index, { key, value }] of requests.entries()) {
    assert.deepEqual(
      actual[index],
      {
        key: legacy.isSecretLikeKey(key),
        value: legacy.isSecretLikeValue(value),
        jwt: legacy.isJwt(value),
        paseto: legacy.isPaseto(value),
        entropy: legacy.isHighEntropyString(value),
        redacted: legacy.redactValue(key, value),
      },
      JSON.stringify({ key, value }),
    )
  }
  process.stdout.write(`Rust redaction differential: ${requests.length} synthetic cases passed.\n`)
})
