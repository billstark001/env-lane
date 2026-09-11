import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  normalizeRoot,
  plainValue,
  runRustExample,
  snapshotTree,
  withOracle,
  workspace,
} from './rust-support.mjs'

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/index.js'))
  )
  const file = path.join(temporary, '.env')
  const templateFile = path.join(temporary, '.env.example')
  const requests = []
  const expected = []
  const add = (content, template, options = {}) => {
    if (content === null) rmSync(file, { force: true })
    else writeFileSync(file, content)
    writeFileSync(templateFile, template)
    const {
      filePath: _file,
      templateFilePath: _template,
      ...plan
    } = legacy.buildEnvSortPlan(file, templateFile, options)
    requests.push({ content, template, options })
    expected.push(plainValue(plan))
  }
  const fixture = JSON.parse(
    readFileSync(path.join(workspace, 'compat/fixtures/sort/plans.json'), 'utf8'),
  )
  for (const testCase of fixture.cases) add(testCase.content, testCase.template, testCase.options)
  let state = 420042
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const lines = [
    'A=one',
    '# A=',
    'A=last',
    'B=two',
    '# B=old',
    '# heading',
    '',
    '',
    'INVALID',
    'C="line one\nline two"',
    '  export D: four',
    '# tail',
  ]
  for (let index = 0; index < 300; index++) {
    const content = Array.from({ length: next() % 16 }, () => lines[next() % lines.length]).join(
      '\n',
    )
    const template = Array.from({ length: next() % 10 }, () => lines[next() % lines.length]).join(
      '\n',
    )
    add(content, template, {
      unlistedVariablesComment: index % 3 ? '' : 'Extra variables\n# retain these',
      eol: index % 2 ? 'lf' : 'crlf',
      preserveBOM: index % 2 === 0,
    })
  }
  const actual = runRustExample('sort-protocol', requests)
  for (const [index, result] of actual.entries())
    assert.deepEqual(
      result,
      expected[index],
      `sort plan ${index}: ${JSON.stringify(requests[index])}`,
    )

  const oldFile = path.join(temporary, 'old.env')
  const newFile = path.join(temporary, 'new.env')
  writeFileSync(oldFile, 'B=two\nA=one\n')
  writeFileSync(newFile, 'B=two\nA=one\n')
  writeFileSync(templateFile, 'A=\nB=\n')
  const operations = []
  const oldResults = []
  for (const check of [true, false, false]) {
    operations.push({
      operation: 'file',
      file: newFile,
      template: templateFile,
      options: { check },
    })
    const before = readFileSync(oldFile, 'utf8')
    const result = await legacy.sortEnvFile(oldFile, templateFile, { check })
    oldResults.push({ ...result, filePath: newFile })
    if (check) assert.equal(readFileSync(oldFile, 'utf8'), before)
  }
  assert.deepEqual(runRustExample('sort-protocol', operations), oldResults)
  assert.equal(readFileSync(newFile, 'utf8'), readFileSync(oldFile, 'utf8'))
  await verifyConfiguredSort(legacy, temporary)
  process.stdout.write(
    `Rust sort differential: ${actual.length} plans, check/write/idempotence and final bytes passed.\n`,
  )
})

async function verifyConfiguredSort(legacy, temporary) {
  for (const topology of ['moment-project', 'moment-landing']) {
    const source = path.join(workspace, 'compat/fixtures/topologies', topology)
    const oldRoot = path.join(temporary, `${topology}-old`)
    const newRoot = path.join(temporary, `${topology}-new`)
    cpSync(source, oldRoot, { recursive: true })
    cpSync(source, newRoot, { recursive: true })
    const config = JSON.parse(readFileSync(path.join(source, 'env-lane.config.json'), 'utf8'))
    const operations = []
    const results = []
    for (const key of Object.keys(config.sort ?? {})) {
      for (const check of [true, false, false]) {
        operations.push({
          operation: 'configured',
          cwd: newRoot,
          key,
          variant: 'all',
          options: { check },
        })
        results.push(
          normalizeRoot(
            await legacy.sortEnvFilesFromConfig(
              path.join(oldRoot, 'env-lane.config.json'),
              key,
              'all',
              { cwd: oldRoot, check },
            ),
            oldRoot,
          ),
        )
      }
    }
    if (operations.length) {
      assert.deepEqual(normalizeRoot(runRustExample('sort-protocol', operations), newRoot), results)
      assert.deepEqual(snapshotTree(newRoot), snapshotTree(oldRoot))
    }
  }
}
