import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeRoot, runRustExample, workspace } from './rust-support.mjs'

// This gate consumes the same frozen case as the legacy fixture runner. It tests
// native application results; CLI byte rendering has its own later boundary.
const operations = {
  'core.load-config': 'load',
  'core.packages': 'packages',
  'core.resolve-target': 'resolveTarget',
  'core.files': 'files',
  'core.resolve': 'resolve',
  'core.selector-check': 'selectorCheck',
  'core.policy-check': 'policyCheck',
  'core.sync': 'sync',
}
const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-rust-shared-'))
try {
  const fixture = JSON.parse(
    readFileSync(
      path.join(workspace, 'compat/fixtures/cases/moment-project-core-api.json'),
      'utf8',
    ),
  )
  const root = path.join(temporary, fixture.topology)
  cpSync(path.join(workspace, 'compat/fixtures/topologies', fixture.topology), root, {
    recursive: true,
  })
  const requests = fixture.steps.map((step) => {
    assert.equal(step.kind, 'api')
    assert.ok(operations[step.operation], `No native adapter for ${step.operation}`)
    return { ...step.input, operation: operations[step.operation], cwd: root }
  })
  const results = runRustExample('config-protocol', requests)
  for (const [index, result] of results.entries()) {
    const step = fixture.steps[index]
    assert.equal(step.expected.status, 0)
    assert.deepEqual(
      normalizeRoot(result, root),
      JSON.parse(step.expected.stdout),
      `${fixture.id}: ${step.operation}`,
    )
  }
  for (const [file, expected] of Object.entries(fixture.expectedFiles ?? {})) {
    assert.equal(readFileSync(path.join(root, file), 'utf8'), expected)
  }
  process.stdout.write(`Rust shared fixture: ${fixture.id}, all ${results.length} steps passed.\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
