export interface RedactOptions {
  showSecrets?: boolean
  redactionText?: string
  detectValues?: boolean
  minEntropyLength?: number
  entropyThreshold?: number
  allowListKeys?: RegExp[]
  denyListKeys?: RegExp[]
}

type ResolvedRedactOptions = Required<
  Pick<
    RedactOptions,
    'showSecrets' | 'redactionText' | 'detectValues' | 'minEntropyLength' | 'entropyThreshold'
  >
> &
  Pick<RedactOptions, 'allowListKeys' | 'denyListKeys'>

const DEFAULT_OPTIONS: ResolvedRedactOptions = {
  showSecrets: false,
  redactionText: '<redacted>',
  detectValues: true,
  minEntropyLength: 40,
  entropyThreshold: 4.0,
  allowListKeys: [],
  denyListKeys: [],
}

const SAFE_KEY_PATTERNS = [
  /^public_key$/,
  /^public_cert(?:ificate)?$/,
  /^certificate$/,
  /^cert$/,
  /^fingerprint$/,
  /^token_count$/,
  /^tokens_count$/,
  /^max_tokens$/,
  /^key_(?:id|name|type|version)$/,
  /^(?:id|name|type|version)_key$/,
]

const SENSITIVE_KEY_TOKENS = new Set([
  'secret',
  'private',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'pass',
  'token',
  'bearer',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'cookie',
  'session',
  'jwt',
  'dsn',
])

const SENSITIVE_KEY_PHRASE_RE =
  /(?:^|_)(?:api_key|access_key|secret_key|private_key|client_secret|client_token|access_token|refresh_token|id_token|auth_token|csrf_token|database_url|db_url|redis_url|redis_uri|rpc_url|mongo_url|mongodb_url|mongo_uri|mongodb_uri|postgres_url|postgresql_url|connection_string|signing_secret|webhook_secret|webhook_url)(?:$|_)/i

const COMPACT_SENSITIVE_KEY_RE =
  /(?:apikey|accesskey|secretkey|privatekey|clientsecret|clienttoken|accesstoken|refreshtoken|idtoken|authtoken|csrftoken|databaseurl|dburl|redisurl|redisuri|rpcurl|mongourl|mongodburl|mongouri|mongodburi|postgresurl|postgresqlurl|connectionstring|signingsecret|webhooksecret|webhookurl|pgpassword)/i

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
]

const CREDENTIAL_QUERY_KEY_RE =
  /^(?:access_?token|id_?token|refresh_?token|api_?key|key|token|secret|password|passwd|pwd|signature|sig|client_secret)$/i

const INLINE_KV_RE =
  /(?:^|[\s,{])["']?([A-Za-z][A-Za-z0-9_.-]{1,80})["']?\s*[:=]\s*["']?([^"',}\]\s;]{8,})["']?/g

export function isSecretLikeKey(key: string, options: RedactOptions = {}): boolean {
  const opts = resolveOptions(options)
  const rawKey = key.trim()

  if (!rawKey) return false

  if (matchesAny(opts.denyListKeys ?? [], rawKey)) return true
  if (matchesAny(opts.allowListKeys ?? [], rawKey)) return false

  const normalized = normalizeKey(rawKey)

  if (!normalized) return false

  if (SAFE_KEY_PATTERNS.some((re) => testRegExp(re, normalized))) {
    return false
  }

  if (testRegExp(SENSITIVE_KEY_PHRASE_RE, normalized)) {
    return true
  }

  const compact = normalized.replaceAll('_', '')

  if (testRegExp(COMPACT_SENSITIVE_KEY_RE, compact)) {
    return true
  }

  const tokens = normalized.split('_').filter(Boolean)

  if (tokens.length === 1 && tokens[0] === 'key') {
    return true
  }

  return tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token))
}

export function isSecretLikeValue(value: string, options: RedactOptions = {}): boolean {
  const opts = resolveOptions(options)
  const trimmed = value.trim()

  if (!trimmed) return false

  if (SECRET_VALUE_PATTERNS.some((re) => testRegExp(re, trimmed))) {
    return true
  }

  if (hasCredentialsInUrl(trimmed)) {
    return true
  }

  if (hasInlineSecretAssignment(trimmed, opts)) {
    return true
  }

  return looksHighEntropy(trimmed, opts)
}

export function shouldRedact(
  key: string,
  value: string,
  options: boolean | RedactOptions = false,
): boolean {
  const opts = resolveOptions(options)

  if (opts.showSecrets || !value) return false

  return isSecretLikeKey(key, opts) || (opts.detectValues && isSecretLikeValue(value, opts))
}

export function redactValue(key: string, value: string, showSecrets?: boolean): string
export function redactValue(key: string, value: string, options?: RedactOptions): string
export function redactValue(
  key: string,
  value: string,
  options: boolean | RedactOptions = false,
): string {
  const opts = resolveOptions(options)

  if (opts.showSecrets) return value

  return shouldRedact(key, value, opts) ? opts.redactionText : value
}

export function redactRecord(
  values: Record<string, string>,
  showSecrets?: boolean,
): Record<string, string>
export function redactRecord(
  values: Record<string, string>,
  options?: RedactOptions,
): Record<string, string>
export function redactRecord(
  values: Record<string, string>,
  options: boolean | RedactOptions = false,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      redactValue(key, value, options as RedactOptions),
    ]),
  )
}

/**
 * Optional for logs, etc.
 */
export function redactObject<T>(value: T, options: boolean | RedactOptions = false): T {
  const opts = resolveOptions(options)
  const seen = new WeakSet<object>()

  function visit(input: unknown, key = ''): unknown {
    if (opts.showSecrets) return input

    if (typeof input === 'string') {
      return shouldRedact(key, input, opts) ? opts.redactionText : input
    }

    if (input == null || typeof input !== 'object') {
      return input
    }

    if (seen.has(input)) {
      return '[Circular]'
    }

    seen.add(input)

    if (key && isSecretLikeKey(key, opts)) {
      return opts.redactionText
    }

    if (Array.isArray(input)) {
      return input.map((item) => visit(item, key))
    }

    return Object.fromEntries(
      Object.entries(input).map(([childKey, childValue]) => [
        childKey,
        visit(childValue, childKey),
      ]),
    )
  }

  return visit(value) as T
}

function resolveOptions(options: boolean | RedactOptions = false): ResolvedRedactOptions {
  const partial: RedactOptions = typeof options === 'boolean' ? { showSecrets: options } : options

  return {
    showSecrets: partial.showSecrets ?? DEFAULT_OPTIONS.showSecrets,
    redactionText: partial.redactionText ?? DEFAULT_OPTIONS.redactionText,
    detectValues: partial.detectValues ?? DEFAULT_OPTIONS.detectValues,
    minEntropyLength: partial.minEntropyLength ?? DEFAULT_OPTIONS.minEntropyLength,
    entropyThreshold: partial.entropyThreshold ?? DEFAULT_OPTIONS.entropyThreshold,
    allowListKeys: partial.allowListKeys ?? DEFAULT_OPTIONS.allowListKeys,
    denyListKeys: partial.denyListKeys ?? DEFAULT_OPTIONS.denyListKeys,
  }
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function hasCredentialsInUrl(value: string): boolean {
  try {
    const url = new URL(value)

    if (url.username || url.password) {
      return true
    }

    for (const [name, paramValue] of url.searchParams.entries()) {
      if (testRegExp(CREDENTIAL_QUERY_KEY_RE, name) && paramValue.trim().length >= 8) {
        return true
      }
    }

    return false
  } catch {
    return (
      /:\/\/[^/@\s]+:[^/@\s]+@/.test(value) ||
      /[?&](?:access_?token|id_?token|refresh_?token|api_?key|key|token|secret|password|passwd|pwd|signature|sig|client_secret)=[^&\s]{8,}/i.test(
        value,
      )
    )
  }
}

function hasInlineSecretAssignment(value: string, options: ResolvedRedactOptions): boolean {
  INLINE_KV_RE.lastIndex = 0

  for (const match of value.matchAll(INLINE_KV_RE)) {
    const [, key, assignedValue] = match

    if (!key || !assignedValue) continue

    if (
      isSecretLikeKey(key, options) ||
      SECRET_VALUE_PATTERNS.some((re) => testRegExp(re, assignedValue))
    ) {
      return true
    }
  }

  return false
}

function looksHighEntropy(value: string, options: ResolvedRedactOptions): boolean {
  if (value.length < options.minEntropyLength) return false
  if (/\s/.test(value)) return false

  // UUID / hash / pure numeric IDs are usually non-secret
  if (/^[0-9]+$/.test(value)) return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return false
  }
  if (/^[0-9a-f]{32,128}$/i.test(value)) return false

  if (countCharacterClasses(value) < 3) return false

  return shannonEntropy(value) >= options.entropyThreshold
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>()

  for (const char of value) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1)
  }

  let entropy = 0

  for (const count of frequencies.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }

  return entropy
}

function countCharacterClasses(value: string): number {
  let classes = 0

  if (/[a-z]/.test(value)) classes += 1
  if (/[A-Z]/.test(value)) classes += 1
  if (/[0-9]/.test(value)) classes += 1
  if (/[^A-Za-z0-9]/.test(value)) classes += 1

  return classes
}

function matchesAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => testRegExp(pattern, value))
}

function testRegExp(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(value)
}
