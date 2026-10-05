import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { plainValue, withOracle, workspace } from './rust-support.mjs'

function compareFileBridges({
  temporary,
  previousDocument,
  currentDocument,
  previousVault,
  currentVault,
}) {
  const documentCases = [
    { name: 'missing', initial: null, patches: [{ op: 'set', key: 'NEW', value: 'added' }] },
    { name: 'empty-missing', initial: null, patches: [] },
    {
      name: 'duplicate-crlf',
      initial: ['\uFEFFKEY=first', 'KEY=second', '# OTHER=old', ''].join('\r\n'),
      patches: [
        { op: 'set', key: 'KEY', value: 'third' },
        { op: 'set', key: 'OTHER', value: 'new value' },
      ],
      options: { update: 'last', matchCommented: true, removeDuplicateEntries: true },
    },
    { name: 'delete', initial: 'A=one\nB=two\n', patches: [{ op: 'delete', key: 'A' }] },
    { name: 'unchanged', initial: 'A=one\n', patches: [{ op: 'set', key: 'A', value: 'one' }] },
    {
      name: 'replacement-utf8',
      initial: Buffer.from([0x41, 0x3d, 0xff, 0x0a]),
      patches: [{ op: 'set', key: 'A', value: 'updated' }],
    },
  ]
  for (const sample of documentCases) {
    const observe = (api, label) => {
      const directory = path.join(temporary, 'document-bridge', sample.name, label)
      mkdirSync(directory, { recursive: true })
      const file = path.join(directory, '.env')
      if (sample.initial !== null) writeFileSync(file, sample.initial)
      const loaded = plainValue(api.loadEnvDocument(file))
      const patched = plainValue(api.applyEnvDocumentPatches(file, sample.patches, sample.options))
      delete patched.filePath
      return {
        loaded,
        patched,
        after: existsSync(file) ? readFileSync(file).toString('base64') : null,
      }
    }
    assert.deepEqual(
      observe(currentDocument, 'current'),
      observe(previousDocument, 'previous'),
      sample.name,
    )
  }

  for (const sample of [
    { name: 'create-empty', initial: null, content: '' },
    { name: 'create-content', initial: null, content: 'A=one\n' },
    { name: 'same-content', initial: 'A=one\n', content: 'A=one\n' },
    { name: 'replace-content', initial: 'A=one\n', content: 'A=two\n' },
  ]) {
    const observe = (api, label) => {
      const directory = path.join(temporary, 'write-bridge', sample.name, label)
      mkdirSync(directory, { recursive: true })
      const file = path.join(directory, '.env')
      if (sample.initial !== null) writeFileSync(file, sample.initial)
      const changed = api.writeEnvDocumentContent(file, sample.content)
      return { changed, after: existsSync(file) ? readFileSync(file).toString('base64') : null }
    }
    assert.deepEqual(observe(currentDocument, 'current'), observe(previousDocument, 'previous'))
  }
  if (process.platform !== 'win32') {
    const observe = (api, label) => {
      const directory = path.join(temporary, 'symlink-bridge', label)
      mkdirSync(directory, { recursive: true })
      const target = path.join(directory, 'target.env')
      const link = path.join(directory, '.env')
      writeFileSync(target, 'A=one\n')
      symlinkSync(target, link)
      const changed = api.writeEnvDocumentContent(link, 'A=two\n')
      return { changed, linked: readFileSync(link, 'utf8'), target: readFileSync(target, 'utf8') }
    }
    assert.deepEqual(observe(currentDocument, 'current'), observe(previousDocument, 'previous'))
  }
  const observeApproval = (api, label) => {
    const directory = path.join(temporary, 'approval-bridge', label)
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'approval.json')
    const approval = { purpose: 'disposable conformance fixture' }
    api.writeApprovalDocument(file, approval)
    const firstInode = statSync(file).ino
    api.writeApprovalDocument(file, approval)
    return {
      content: readFileSync(file, 'utf8'),
      replacedOnRepeat:
        process.platform === 'win32' ? undefined : statSync(file).ino !== firstInode,
    }
  }
  assert.deepEqual(
    observeApproval(currentVault, 'current'),
    observeApproval(previousVault, 'previous'),
  )
}

await withOracle(async ({ temporary, runtime }) => {
  const previous = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/index.js')).href
  )
  const current = await import(
    pathToFileURL(path.join(workspace, 'packages/core/dist/index.js')).href
  )
  const previousDocument = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/env-document.js')).href
  )
  const currentDocument = await import(
    pathToFileURL(path.join(workspace, 'packages/core/dist/env-document.js')).href
  )
  const previousVault = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js')).href
  )
  const currentVault = await import(
    pathToFileURL(path.join(workspace, 'packages/vault/dist/index.js')).href
  )
  const variants = [
    [undefined, {}],
    ['default', {}],
    [' all ', { allowAll: true }],
    ['all', { allowAll: false }],
    [' production ', {}],
    ['.env.production', {}],
    ['invalid/variant', { fieldName: 'sync target variant' }],
    ['\uFEFFstaging\uFEFF', {}],
    ['', { fallback: 'local' }],
  ]
  const classify = (api, value, options) => {
    try {
      return { value: api.normalizeEnvFileVariant(value, options) }
    } catch (error) {
      return { code: error.code, message: error.message }
    }
  }
  for (const [value, options] of variants) {
    assert.deepEqual(classify(current, value, options), classify(previous, value, options))
  }

  const outer = path.join(temporary, 'workspace')
  const nested = path.join(outer, 'apps', 'web')
  mkdirSync(nested, { recursive: true })
  writeFileSync(path.join(outer, 'package.json'), '{}')
  writeFileSync(path.join(outer, 'pnpm-workspace.yaml'), 'packages: [apps/*]\n')
  writeFileSync(path.join(outer, 'env-lane.config.json'), '{}')
  writeFileSync(path.join(nested, 'package.json'), '{}')
  for (const cwd of [outer, nested]) {
    const oldRoot = (await previous.loadEnvLaneConfig({ cwd })).rootDir
    const newRoot = (await current.loadEnvLaneConfig({ cwd })).rootDir
    assert.equal(newRoot, oldRoot)
  }
  const repo = path.join(outer, 'repo')
  const child = path.join(repo, 'child')
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  mkdirSync(child)
  writeFileSync(path.join(repo, 'package.json'), '{}')
  writeFileSync(path.join(repo, 'env-lane.config.json'), '{}')
  // 0.4.2 accidentally inherited the outer pnpm workspace. The native root
  // finder keeps this nested Git repository independent, as the 0.5 test suite requires.
  assert.equal((await previous.loadEnvLaneConfig({ cwd: child })).rootDir, outer)
  assert.equal((await current.loadEnvLaneConfig({ cwd: child })).rootDir, repo)

  compareFileBridges({ temporary, previousDocument, currentDocument, previousVault, currentVault })
  process.stdout.write('Core and Vault file bridge conformance passed.\n')
})
