import assert from 'node:assert/strict'
import { cpSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  normalizeRoot as normalize,
  plainValue,
  runRustExample,
  snapshotTree as tree,
  withOracle,
  workspace,
} from './rust-support.mjs'

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/index.js'))
  )
  for (const topology of ['moment-project', 'moment-landing']) {
    const source = path.join(workspace, 'compat/fixtures/topologies', topology)
    const oldRoot = path.join(temporary, `${topology}-legacy`)
    const newRoot = path.join(temporary, `${topology}-rust`)
    cpSync(source, oldRoot, { recursive: true })
    cpSync(source, newRoot, { recursive: true })
    const config = JSON.parse(readFileSync(path.join(source, 'env-lane.config.json'), 'utf8'))
    const requests = []
    const expected = []
    for (const build of config.selector.builds) {
      requests.push({
        operation: 'selectorCheck',
        cwd: newRoot,
        target: 'all',
        build,
        requireOverride: true,
      })
      expected.push(
        normalize(
          plainValue(
            await legacy.checkDotenvSelector({
              cwd: oldRoot,
              configFile: path.join(oldRoot, 'env-lane.config.json'),
              target: 'all',
              build,
              requireOverride: true,
            }),
          ),
          oldRoot,
        ),
      )
      for (const name of Object.keys(config.checks ?? {})) {
        requests.push({ operation: 'policyCheck', cwd: newRoot, name, build })
        expected.push(
          normalize(
            plainValue(
              await legacy.runEnvCheck(name, {
                cwd: oldRoot,
                build,
                configFile: path.join(oldRoot, 'env-lane.config.json'),
              }),
            ),
            oldRoot,
          ),
        )
      }
      for (const name of Object.keys(config.sync ?? {})) {
        for (const dryRun of [true, false, false]) {
          const before = tree(oldRoot)
          requests.push({ operation: 'sync', cwd: newRoot, name, build, dryRun })
          expected.push(
            normalize(
              plainValue(
                await legacy.runEnvSync(name, {
                  cwd: oldRoot,
                  build,
                  dryRun,
                  configFile: path.join(oldRoot, 'env-lane.config.json'),
                }),
              ),
              oldRoot,
            ),
          )
          if (dryRun) assert.deepEqual(tree(oldRoot), before)
        }
      }
    }
    const actual = runRustExample('config-protocol', requests)
    assert.deepEqual(normalize(actual, newRoot), expected, topology)
    assert.deepEqual(tree(newRoot), tree(oldRoot), `${topology} exact final file tree`)
    process.stdout.write(
      `Rust policy/sync differential: ${topology}, ${actual.length} operations and final file tree passed.\n`,
    )
  }
})
