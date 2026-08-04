import { describe, expect, it } from 'vitest'
import {
  SYNTHETIC_CREDENTIALS,
  SYNTHETIC_PUBLIC_CASES,
  SYNTHETIC_SECRET_CASES,
} from '../../../core/test/fixtures/synthetic-credentials.js'
import { restoreCurrentPreview, restoreValuePreview } from '../../src/domain/restore-preview.js'

describe('Vault restore previews', () => {
  it.each([
    ['API_URL', 'https://api.example.com/v1/items', 'https://api.example.com/v1/items'],
    [
      'DATABASE_URL',
      'postgres://user:password@db.example.com:5432/moment',
      'postgres://<redacted>@db.example.com:5432/moment',
    ],
    [
      'CALLBACK_URL',
      'https://example.com/callback?token=abc&mode=test',
      'https://example.com/callback?token=abc&mode=test',
    ],
    [
      'RPC_URL',
      'https://rpc.provider.com/v2/secret-project-id',
      'https://rpc.provider.com/v2/<redacted>',
    ],
    ['RPC_URL', 'https://mainnet.base.org', 'https://mainnet.base.org'],
    ['RPC_URL', 'https://mainnet.base.org/v1', 'https://mainnet.base.org/v1'],
  ])('partially redacts %s without hiding safe URL structure', (key, value, expected) => {
    expect(restoreValuePreview(key, value, 'partial')).toBe(expected)
  })

  it('keeps full redaction safe and makes unredacted output explicit', () => {
    expect(restoreValuePreview('SECRET_TOKEN', 'secret-value', 'full')).toBe('<redacted>')
    expect(restoreValuePreview('SECRET_TOKEN', 'secret-value', 'partial')).toBe('<redacted>')
    expect(restoreValuePreview('SECRET_TOKEN', 'secret-value', 'none')).toBe('secret-value')
  })

  it('never redacts values or URL components shorter than eight characters', () => {
    expect(restoreValuePreview('PASSWORD', '1234567', 'full')).toBe('1234567')
    expect(restoreValuePreview('PASSWORD', '12345678', 'full')).toBe('<redacted>')
    expect(
      restoreValuePreview('CALLBACK_URL', 'https://example.test/?token=1234567', 'partial'),
    ).toBe('https://example.test/?token=1234567')
    expect(
      restoreValuePreview('CALLBACK_URL', 'https://example.test/?token=12345678', 'partial'),
    ).toBe('https://example.test/?token=<redacted>')
    expect(
      restoreValuePreview('CALLBACK_URL', 'https://example.test/?token=%61%62%63', 'partial'),
    ).toBe('https://example.test/?token=%61%62%63')
    expect(
      restoreValuePreview('DATABASE_URL', 'postgres://u:p@db.example.test/db', 'partial'),
    ).toBe('postgres://u:p@db.example.test/db')
    expect(restoreCurrentPreview('PASSWORD', ['1234567'], 'full')).toBe('1234567')
    expect(restoreCurrentPreview('PASSWORD', ['1234567', '12345678'], 'full')).toBe(
      '["1234567","<redacted>"]',
    )
  })

  it('optionally reveals configured leading and trailing characters', () => {
    const reveal = { start: 4, end: 4 }
    expect(
      restoreValuePreview('PRIVATE_KEY', SYNTHETIC_CREDENTIALS.ethereum.privateKey, 'full', reveal),
    ).toBe('<redacted:0xa1......39d5>')
    expect(
      restoreValuePreview('RPC_URL', 'https://rpc.example/v2/secret-project-id', 'partial', reveal),
    ).toBe('https://rpc.example/v2/<redacted:secr......t-id>')
    expect(restoreValuePreview('TOKEN', 'too-short', 'full', reveal)).toBe(
      '<redacted:too-......hort>',
    )
    expect(restoreValuePreview('TOKEN', '12345678', 'full', reveal)).toBe('<redacted>')
  })

  it.each(SYNTHETIC_SECRET_CASES)(
    'partially redacts the shared $name fixture',
    ({ key, value }) => {
      const preview = restoreValuePreview(key, value, 'partial')
      expect(preview).not.toBe(value)
      expect(preview).not.toContain(value)
    },
  )

  it.each(SYNTHETIC_PUBLIC_CASES)('preserves the shared public $name fixture', ({ key, value }) => {
    expect(restoreValuePreview(key, value, 'partial')).toBe(value)
  })

  it('heuristically masks high-entropy URL components with optional human-readable hints', () => {
    const opaque = SYNTHETIC_CREDENTIALS.generic.opaqueHighEntropy
    const value = `https://api.example.test/v2/${opaque}/items?project_ref=${opaque}`
    expect(restoreValuePreview('ENDPOINT_URL', value, 'partial', { start: 4, end: 4 })).toBe(
      'https://api.example.test/v2/<redacted:Fv5D......Wm9I>/items?project_ref=<redacted:Fv5D......Wm9I>',
    )
  })
})
