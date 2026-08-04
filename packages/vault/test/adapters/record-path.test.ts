import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeVaultRecordPath, resolveVaultRecordPath } from '../../src/adapters/record-path.js'

describe('Vault record paths', () => {
  it('stores the same portable config-relative path on POSIX and Windows', () => {
    expect(
      encodeVaultRecordPath(
        '/Users/alice/project',
        '/Users/alice/project/apps/backend/.env',
        path.posix,
      ),
    ).toBe('apps/backend/.env')
    expect(
      encodeVaultRecordPath(
        'C:\\Users\\alice\\project',
        'C:\\Users\\alice\\project\\apps\\backend\\.env',
        path.win32,
      ),
    ).toBe('apps/backend/.env')
  })

  it('resolves a macOS-produced record path in a Windows checkout', () => {
    const storedPath = encodeVaultRecordPath(
      '/Users/alice/project',
      '/Users/alice/project/apps/backend/.env',
      path.posix,
    )

    expect(resolveVaultRecordPath('D:\\work\\project', storedPath, path.win32)).toBe(
      'D:\\work\\project\\apps\\backend\\.env',
    )
  })

  it('rejects absolute or platform-specific version 1 record paths', () => {
    expect(() => resolveVaultRecordPath('/project', '/Users/alice/project/.env')).toThrow(
      /portable relative paths/i,
    )
    expect(() => resolveVaultRecordPath('/project', 'C:\\project\\.env')).toThrow(
      /portable relative paths/i,
    )
  })
})
