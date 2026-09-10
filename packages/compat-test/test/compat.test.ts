import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runWithInjectedEnv, sortEnvFile } from '@env-lane/core'
import {
  applyEnvDocumentPatches,
  formatEnvValue,
  parseEnvDocument,
  renderEnvTextDocument,
} from '@env-lane/core/env-document'
import {
  buildRestorePlan,
  decryptRecord,
  deriveVaultKey,
  deriveVaultSyncKey,
  encryptRecord,
  keyedDigest,
} from '@env-lane/vault'
import { parse as parseDotenv } from 'dotenv'
import { describe, expect, it } from 'vitest'

const workspace = path.resolve(import.meta.dirname, '../../..')

function fixtureJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(path.join(workspace, 'compat/fixtures', relativePath), 'utf8'),
  ) as T
}

function effectiveValues(content: string): Record<string, string> {
  return Object.fromEntries(
    [...parseEnvDocument(content).currentMap].map(([key, entry]) => [key, entry.effectiveValue]),
  )
}

describe('shared 0.4.2 dotenv compatibility corpus', () => {
  it('matches frozen values, document metadata, duplicates, and dotenv 17.4.2', () => {
    const corpus = fixtureJson<{
      dotenvVersion: string
      cases: Array<{
        id: string
        content?: string
        base64?: string
        values: Record<string, string>
        lineNumbers: Record<string, number>
        occurrences?: Record<string, number>
        invalidLineCount: number
        shadowedEntryCount: number
        document: {
          hasBom: boolean
          eol: string
          hasFinalNewline: boolean
          lineCount: number
        }
      }>
    }>('dotenv/effective-values.json')
    expect(corpus.dotenvVersion).toBe('17.4.2')

    for (const testCase of corpus.cases) {
      const content =
        testCase.content ?? Buffer.from(testCase.base64 ?? '', 'base64').toString('utf8')
      const document = parseEnvDocument(content)
      expect(effectiveValues(content), testCase.id).toEqual(testCase.values)
      expect(parseDotenv(content), `${testCase.id} dotenv oracle`).toEqual(testCase.values)
      expect(
        Object.fromEntries([...document.currentMap].map(([key, entry]) => [key, entry.lineNumber])),
        `${testCase.id} line numbers`,
      ).toEqual(testCase.lineNumbers)
      expect(
        Object.fromEntries(
          [...document.occurrencesMap].map(([key, occurrences]) => [key, occurrences.length]),
        ),
        `${testCase.id} occurrences`,
      ).toEqual(
        testCase.occurrences ??
          Object.fromEntries(Object.keys(testCase.values).map((key) => [key, 1])),
      )
      expect(document.invalidLineCount, testCase.id).toBe(testCase.invalidLineCount)
      expect(document.shadowedEntryCount, testCase.id).toBe(testCase.shadowedEntryCount)
      expect(
        {
          hasBom: document.document.hasBom,
          eol: document.document.eol,
          hasFinalNewline: document.document.hasFinalNewline,
          lineCount: document.document.lines.length,
        },
        testCase.id,
      ).toEqual(testCase.document)

      const rendered = renderEnvTextDocument(document.document, document.document.lines)
      expect(effectiveValues(rendered), `${testCase.id} parse-render-parse`).toEqual(
        testCase.values,
      )
    }
  })

  it('freezes patch output and patch idempotence', () => {
    const corpus = fixtureJson<{
      cases: Array<{
        id: string
        initial: string
        patches: Array<{ op: 'set'; key: string; value: string } | { op: 'delete'; key: string }>
        options: Parameters<typeof applyEnvDocumentPatches>[2]
        expected: string
      }>
    }>('dotenv/patches.json')

    for (const testCase of corpus.cases) {
      const root = mkdtempSync(path.join(tmpdir(), 'env-lane-dotenv-patch-'))
      const file = path.join(root, '.env')
      writeFileSync(file, testCase.initial)
      expect(applyEnvDocumentPatches(file, testCase.patches, testCase.options).changed).toBe(true)
      expect(readFileSync(file, 'utf8'), testCase.id).toBe(testCase.expected)
      expect(applyEnvDocumentPatches(file, testCase.patches, testCase.options).changed).toBe(false)
      expect(readFileSync(file, 'utf8'), `${testCase.id} idempotent`).toBe(testCase.expected)
    }
  })

  it('round-trips every representable format value and freezes errors', () => {
    const corpus = fixtureJson<{
      cases: Array<{ id: string; value: string; formatted?: string; error?: string }>
    }>('dotenv/format-values.json')
    for (const testCase of corpus.cases) {
      if (testCase.error) {
        expect(() => formatEnvValue(testCase.value), testCase.id).toThrow(
          expect.objectContaining({ code: testCase.error }),
        )
        continue
      }
      const formatted = formatEnvValue(testCase.value)
      expect(formatted, testCase.id).toBe(testCase.formatted)
      expect(parseDotenv(`VALUE=${formatted}`).VALUE, testCase.id).toBe(testCase.value)
    }
  })

  it('runs deterministic generated line/quote/escape/comment/duplicate differential cases', () => {
    const generator = fixtureJson<{
      seed: number
      cases: number
      keys: string[]
      quotes: Array<'none' | 'single' | 'double' | 'backtick'>
      comments: Array<'none' | 'inline' | 'inside-quote'>
      duplicateEvery: number
    }>('dotenv/generator.json')
    let state = generator.seed >>> 0
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state
    }
    const lines: string[] = []
    for (let index = 0; index < generator.cases; index += 1) {
      const key =
        index % generator.duplicateEvery === 0
          ? generator.keys[0]
          : generator.keys[next() % generator.keys.length]
      const quote = generator.quotes[next() % generator.quotes.length]
      const comment = generator.comments[next() % generator.comments.length]
      const base = `value-${index}-${next().toString(16)}`
      let token = comment === 'inside-quote' ? `${base} # literal` : base
      if (quote === 'single') token = `'${token}'`
      else if (quote === 'double') token = `"${token}${index % 11 === 0 ? '\\nnext' : ''}"`
      else if (quote === 'backtick') token = `\`${token}\``
      const separator = index % 5 === 0 ? ': ' : '='
      const prefix = index % 9 === 0 ? 'export ' : ''
      const suffix = comment === 'inline' ? ' # generated comment' : ''
      lines.push(`${prefix}${key}${separator}${token}${suffix}`)
    }
    const content = lines.join('\n')
    expect(effectiveValues(content)).toEqual(parseDotenv(content))
  })

  it('keeps sort check side-effect free and sorting idempotent', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'env-lane-dotenv-sort-'))
    const file = path.join(root, '.env')
    const template = path.join(root, '.env.example')
    writeFileSync(file, 'EXTRA=three\nB=two\nA=one\n')
    writeFileSync(template, 'A=\nB=\n')
    const before = readFileSync(file, 'utf8')
    expect((await sortEnvFile(file, template, { check: true })).changed).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await sortEnvFile(file, template)).applied).toBe(true)
    const sorted = readFileSync(file, 'utf8')
    expect((await sortEnvFile(file, template)).applied).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(sorted)
  })
})

describe('shared 0.4.2 Vault persistence fixtures', () => {
  it('freezes KDF, HKDF, HMAC, schema v0/v1 ciphertext, and cross-decrypt layout', async () => {
    const fixture = fixtureJson<{
      keyMaterialUtf8: string
      derivedKeyHex: string
      derivedSyncKeyHex: string
      fingerprintInput: string
      fingerprintHex: string
      records: Array<{ plaintext: string; ciphertext: string }>
    }>('vault/schema-v0-v1.json')
    const root = mkdtempSync(path.join(tmpdir(), 'env-lane-vault-protocol-'))
    const keyFile = path.join(root, 'key.txt')
    writeFileSync(keyFile, fixture.keyMaterialUtf8)
    const key = deriveVaultKey(keyFile)
    const syncKey = deriveVaultSyncKey(key)
    expect(key.toString('hex')).toBe(fixture.derivedKeyHex)
    expect(syncKey.toString('hex')).toBe(fixture.derivedSyncKeyHex)
    expect(keyedDigest(syncKey, fixture.fingerprintInput)).toBe(fixture.fingerprintHex)
    for (const record of fixture.records) {
      expect(decryptRecord(key, record.ciphertext)).toBe(record.plaintext)
      const generated = encryptRecord(key, record.plaintext)
      expect(Buffer.from(generated, 'base64').length).toBeGreaterThan(28)
      expect(decryptRecord(key, generated)).toBe(record.plaintext)
    }

    writeFileSync(path.join(root, 'package.json'), '{"name":"vault-protocol-fixture"}\n')
    writeFileSync(path.join(root, '.env'), '')
    mkdirSync(path.join(root, '.vault'))
    writeFileSync(
      path.join(root, 'env-lane.vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    writeFileSync(
      path.join(root, '.vault/store.dat'),
      `${fixture.records.map((record) => record.ciphertext).join('\n')}\n`,
    )
    const plan = await buildRestorePlan(undefined, keyFile, {
      cwd: root,
      vaultConfigFile: 'env-lane.vault.json',
    })
    const entries = plan.files.flatMap((file) => file.entries)
    expect(entries.map((entry) => [entry.key, entry.preview.vault])).toEqual([
      ['LEGACY', '<redacted>'],
      ['MODERN', '<redacted>'],
    ])
    expect(entries.every((entry) => entry.filePath === path.join(root, '.env'))).toBe(true)
  })
})

describe('Windows child-process compatibility', () => {
  it.skipIf(process.platform !== 'win32')(
    'runs a .cmd from a spaced path without consuming shell metacharacters',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'env lane windows '))
      const capturePath = path.join(root, 'captured-arguments.json')
      const scriptPath = path.join(root, 'capture args.mjs')
      const commandPath = path.join(root, 'capture args.cmd')
      const argumentsToCapture = [
        'plain',
        'space value',
        'amp&ersand',
        'caret^value',
        'semi;colon',
        'quote"value',
      ]
      writeFileSync(path.join(root, 'package.json'), '{"name":"windows-process-fixture"}\n')
      writeFileSync(
        scriptPath,
        "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.ARG_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\n",
      )
      writeFileSync(commandPath, '@echo off\r\nnode "%~dp0capture args.mjs" %*\r\n')
      const previousCapturePath = process.env.ARG_CAPTURE_PATH
      process.env.ARG_CAPTURE_PATH = capturePath
      try {
        const exitCode = await runWithInjectedEnv({
          cwd: root,
          target: '.',
          command: [commandPath, ...argumentsToCapture],
        })
        expect(exitCode).toBe(0)
        expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual(argumentsToCapture)
      } finally {
        if (previousCapturePath === undefined) delete process.env.ARG_CAPTURE_PATH
        else process.env.ARG_CAPTURE_PATH = previousCapturePath
      }
    },
  )
})
