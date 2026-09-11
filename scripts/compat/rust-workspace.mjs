import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { plainValue, runRustExample, withOracle, workspace } from './rust-support.mjs'

const fixture = JSON.parse(
  readFileSync(path.join(workspace, 'compat/fixtures/workspace/globs.json')),
)

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/index.js'))
  )
  const root = path.join(temporary, 'project')
  for (const relative of ['.', ...fixture.directories]) {
    const directory = path.resolve(root, relative)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: relative }))
  }
  const requests = []
  const expected = []
  for (const [index, patterns] of fixture.patterns.entries()) {
    const configFile = path.join(root, `config-${index}.json`)
    const packageGlobs = patterns.map((pattern) =>
      pattern.replaceAll('$ROOT', root.replaceAll('\\', '/')),
    )
    writeFileSync(configFile, JSON.stringify({ workspace: { packageGlobs, includeRoot: false } }))
    const options = { cwd: root, configFile }
    // Traversal quirks retained only by the legacy API are normalized by its
    // outer consumer. Native matching itself retains literal escaped names.
    const nativePatterns = packageGlobs.map(
      (pattern) =>
        fixture.outerAdaptations.find((item) => item.pattern === pattern)?.nativePattern ?? pattern,
    )
    const nativeConfig = path.join(root, `native-${index}.json`)
    writeFileSync(
      nativeConfig,
      JSON.stringify({ workspace: { packageGlobs: nativePatterns, includeRoot: false } }),
    )
    requests.push({ cwd: root, configFile: nativeConfig, operation: 'packages' })
    expected.push(plainValue(await legacy.listWorkspacePackages(options)))
  }
  const actual = runRustExample('config-protocol', requests)
  const mismatches = []
  for (const [index, response] of actual.entries()) {
    try {
      assert.deepEqual(response, expected[index])
    } catch {
      mismatches.push({
        patterns: fixture.patterns[index],
        expected: expected[index].map((pkg) => pkg.relativeDir),
        actual: Array.isArray(response) ? response.map((pkg) => pkg.relativeDir) : response,
      })
    }
  }
  assert.deepEqual(mismatches, [], 'Workspace glob differential')
  const literalConfig = path.join(root, 'literal-bracket.json')
  writeFileSync(
    literalConfig,
    JSON.stringify({ workspace: { packageGlobs: ['literal\\[abc\\]'], includeRoot: false } }),
  )
  assert.deepEqual(
    runRustExample('config-protocol', [
      { cwd: root, configFile: literalConfig, operation: 'packages' },
    ])[0].map((pkg) => pkg.relativeDir),
    ['literal[abc]'],
  )
  process.stdout.write(`Rust workspace glob differential: ${actual.length} cases passed.\n`)
})
