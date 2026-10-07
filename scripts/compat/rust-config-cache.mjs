import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compileConfig, locateConfig } from '../../packages/config-compat/src/cache.mjs'
import { inspectRunnerArguments } from '../../packages/config-compat/src/runner-arguments.mjs'
import { runRustExample, workspace } from './rust-support.mjs'

const build = spawnSync('cargo', ['build', '--locked', '--bin', 'env-lane'], {
  cwd: workspace,
  encoding: 'utf8',
})
assert.equal(build.status, 0, build.stderr)
const binary = path.join(
  workspace,
  'target/debug',
  process.platform === 'win32' ? 'env-lane.exe' : 'env-lane',
)
const compiler = path.join(workspace, 'packages/config-compat/src/cli.mjs')
const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-compiled-config-'))
const gitOnly = mkdtempSync(path.join(tmpdir(), 'env-lane-git-config-'))

async function until(predicate, description) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

assert.deepEqual(
  inspectRunnerArguments([
    '--config',
    'env-lane.config.ts',
    'run',
    'root',
    'vault',
    '--config',
    'child.json',
  ]),
  { operation: 'run', configFile: 'env-lane.config.ts' },
)
assert.deepEqual(
  inspectRunnerArguments([
    'vault',
    'plan',
    'key.txt',
    '--vault-config=custom.vault.ts',
    '--cwd',
    '/tmp',
  ]),
  { operation: 'vault', cwd: '/tmp' },
)
assert.deepEqual(inspectRunnerArguments(['-cenv-lane.config.ts', 'packages']), {
  operation: 'packages',
  configFile: 'env-lane.config.ts',
})

function compile(kind, config) {
  const result = spawnSync(
    process.execPath,
    [compiler, 'compile', '--kind', kind, '--cwd', temporary, '--config', config],
    {
      cwd: workspace,
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function packages() {
  const result = spawnSync(
    binary,
    ['packages', '--cwd', temporary, '--config', 'env-lane.config.ts', '--json'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    },
  )
  return { status: result.status, output: JSON.parse(result.stdout) }
}

try {
  const nativeRoot = path.join(temporary, 'native-formats')
  mkdirSync(nativeRoot)
  writeFileSync(path.join(nativeRoot, 'package.json'), '{}')
  for (const [extension, content] of [
    ['json', '{}'],
    ['jsonc', '{ // comment\n}'],
    ['json5', '{ unquoted: true }'],
    ['toml', 'enabled = true\n'],
  ]) {
    const configFile = `env-lane.config.${extension}`
    writeFileSync(path.join(nativeRoot, configFile), content)
    const located = await locateConfig({ cwd: nativeRoot, configFile })
    assert.equal(located.executable, false, configFile)
    await assert.rejects(
      compileConfig({ cwd: nativeRoot, configFile }),
      /Native declarative config does not need compilation/,
    )
  }
  writeFileSync(path.join(nativeRoot, 'env-lane.config.ts'), 'throw new Error("must not run")')
  const discoveredNative = await locateConfig({ cwd: nativeRoot })
  assert.equal(discoveredNative.source, path.join(nativeRoot, 'env-lane.config.json'))
  assert.equal(discoveredNative.executable, false)
  const gitRoot = path.join(gitOnly, 'repo')
  writeFileSync(path.join(gitOnly, 'package.json'), '{}')
  mkdirSync(path.join(gitRoot, '.git'), { recursive: true })
  mkdirSync(path.join(gitRoot, 'nested'))
  writeFileSync(path.join(gitRoot, 'env-lane.config.ts'), 'export default {}\n')
  assert.equal((await locateConfig({ cwd: path.join(gitRoot, 'nested') })).root, gitRoot)
  writeFileSync(path.join(gitOnly, 'pnpm-workspace.yaml'), 'packages: [apps/*]\n')
  writeFileSync(path.join(gitRoot, 'package.json'), '{}')
  assert.equal((await locateConfig({ cwd: path.join(gitRoot, 'nested') })).root, gitRoot)
  rmSync(path.join(gitRoot, '.git'), { recursive: true })
  writeFileSync(path.join(gitRoot, '.git'), 'gitdir: elsewhere\n')
  assert.equal((await locateConfig({ cwd: path.join(gitRoot, 'nested') })).root, gitRoot)
  cpSync(path.join(workspace, 'compat/fixtures/topologies/moment-landing'), temporary, {
    recursive: true,
  })
  const mainSource = path.join(temporary, 'env-lane.config.ts')
  writeFileSync(
    mainSource,
    readFileSync(mainSource, 'utf8').replace(
      'export default {',
      'export default { vault: { enabled: true },',
    ),
  )
  const before = packages()
  assert.equal(before.status, 1)
  assert.equal(before.output.error.code, 'CONFIG_COMPILATION_REQUIRED')
  const main = compile('main', 'env-lane.config.ts')
  assert.equal(main.reused, false)
  assert.equal(main.cacheable, true)
  assert.equal(compile('main', 'env-lane.config.ts').reused, true)
  const invalidEnvelope = JSON.parse(readFileSync(main.file, 'utf8'))
  writeFileSync(main.file, JSON.stringify({ ...invalidEnvelope, config: null }))
  assert.equal(compile('main', 'env-lane.config.ts').reused, false)
  assert.equal(packages().status, 0)
  const compatibleEnvelope = JSON.parse(readFileSync(main.file, 'utf8'))
  for (const bridgeVersion of ['0.5.0', '0.5.2']) {
    writeFileSync(main.file, JSON.stringify({ ...compatibleEnvelope, bridgeVersion }))
    assert.equal(packages().status, 0, `Compatible bridge ${bridgeVersion}`)
  }
  for (const bridgeVersion of ['0.6.0', '1.0.0', 'invalid']) {
    writeFileSync(main.file, JSON.stringify({ ...compatibleEnvelope, bridgeVersion }))
    assert.equal(packages().output.error.code, 'CONFIG_COMPILATION_REQUIRED')
  }
  writeFileSync(main.file, JSON.stringify({ ...compatibleEnvelope, formatVersion: 2 }))
  assert.equal(packages().output.error.code, 'CONFIG_COMPILATION_REQUIRED')
  writeFileSync(main.file, JSON.stringify(compatibleEnvelope))
  const vaultSource = path.join(temporary, 'env-lane.vault.ts')
  writeFileSync(
    vaultSource,
    readFileSync(vaultSource, 'utf8').replace(
      '  disableUnsafeWarning: true,',
      "  exclude: [{ files: ['.env'], keys: ['SECRET*'] }],\n  disableUnsafeWarning: true,",
    ),
  )
  const vault = compile('vault', 'env-lane.vault.ts')
  assert.equal(vault.cacheable, true)
  assert.equal(JSON.parse(readFileSync(vault.file, 'utf8')).kind, 'vault')
  const [vaultConfig] = runRustExample('vault-config-protocol', [
    {
      cwd: temporary,
      mainConfig: 'env-lane.config.ts',
      vaultConfig: 'env-lane.vault.ts',
    },
  ])
  assert.ok(!('error' in vaultConfig), `${vaultConfig.error}: ${vaultConfig.message}`)
  assert.equal(vaultConfig.envFiles.length, 4)
  assert.equal(vaultConfig.restore.redaction, 'partial')
  assert.deepEqual(vaultConfig.exclude, [{ files: ['.env'], keys: ['SECRET*'] }])
  const loaded = packages()
  assert.equal(loaded.status, 0)
  assert.equal(loaded.output.length, 2)
  const invalidRunFormat = spawnSync(
    binary,
    ['run', 'server', '--cwd', temporary, '--config', 'env-lane.config.ts', '--json', '--', 'node'],
    { encoding: 'utf8' },
  )
  assert.equal(invalidRunFormat.status, 1)
  assert.equal(invalidRunFormat.stdout, '')
  assert.match(invalidRunFormat.stderr, /UNSUPPORTED_OUTPUT_FORMAT/)

  const source = path.join(temporary, 'env-lane.config.ts')
  writeFileSync(source, `${readFileSync(source, 'utf8')}\n// cache invalidation\n`)
  const stale = packages()
  assert.equal(stale.status, 1)
  assert.equal(stale.output.error.code, 'CONFIG_COMPILATION_REQUIRED')
  assert.match(stale.output.error.message, /cache is stale/)
  assert.equal(compile('main', 'env-lane.config.ts').reused, false)
  assert.equal(packages().status, 0)
  const directoryModule = path.join(temporary, 'config-parts')
  mkdirSync(directoryModule)
  writeFileSync(path.join(directoryModule, 'index.ts'), 'export const includeRoot = false\n')
  writeFileSync(
    path.join(temporary, 'env-lane.directory.ts'),
    "import { includeRoot } from './config-parts'\nexport default { workspace: { includeRoot } }\n",
  )
  const directoryConfig = compile('main', 'env-lane.directory.ts')
  assert.equal(directoryConfig.cacheable, true)
  assert.equal(compile('main', 'env-lane.directory.ts').reused, true)
  writeFileSync(path.join(directoryModule, 'index.ts'), 'export const includeRoot = true\n')
  assert.equal(compile('main', 'env-lane.directory.ts').reused, false)
  writeFileSync(path.join(directoryModule, 'index.js'), 'export const includeRoot = false\n')
  assert.equal(compile('main', 'env-lane.directory.ts').cacheable, false)
  const dynamic = path.join(temporary, 'env-lane.dynamic.mjs')
  writeFileSync(
    dynamic,
    "export default { workspace: { includeRoot: process.env.DYNAMIC_INCLUDE === 'yes', packageGlobs: ['server'] } }\n",
  )
  const dynamicCache = compile('main', 'env-lane.dynamic.mjs')
  assert.equal(dynamicCache.cacheable, false)
  const direct = spawnSync(
    binary,
    ['packages', '--cwd', temporary, '--config', dynamic, '--json'],
    { encoding: 'utf8' },
  )
  assert.equal(JSON.parse(direct.stdout).error.code, 'CONFIG_COMPILATION_REQUIRED')
  const runner = (value) =>
    spawnSync(
      process.execPath,
      [compiler, 'run', 'packages', '--cwd', temporary, '--config', dynamic, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, ENV_LANE_NATIVE_BINARY: binary, DYNAMIC_INCLUDE: value },
      },
    )
  const withoutRoot = runner('no')
  const withRoot = runner('yes')
  assert.equal(withoutRoot.status, 0, withoutRoot.stderr)
  assert.equal(withRoot.status, 0, withRoot.stderr)
  assert.equal(JSON.parse(withRoot.stdout).length, JSON.parse(withoutRoot.stdout).length + 1)
  const joinedShortConfig = spawnSync(
    process.execPath,
    [compiler, 'run', 'packages', '--cwd', temporary, `-c${dynamic}`, '--json'],
    {
      encoding: 'utf8',
      env: { ...process.env, ENV_LANE_NATIVE_BINARY: binary, DYNAMIC_INCLUDE: 'yes' },
    },
  )
  assert.equal(joinedShortConfig.status, 0, joinedShortConfig.stderr)
  assert.deepEqual(JSON.parse(joinedShortConfig.stdout), JSON.parse(withRoot.stdout))
  const child = (command, input) =>
    spawnSync(
      process.execPath,
      [
        compiler,
        'run',
        'run',
        'server',
        '--cwd',
        temporary,
        '--config',
        dynamic,
        '--quiet',
        '--',
        ...command,
      ],
      {
        input,
        env: { ...process.env, ENV_LANE_NATIVE_BINARY: binary },
        timeout: 20_000,
      },
    )
  const io = child(
    [
      process.execPath,
      '-e',
      [
        "const fs=require('node:fs')",
        // biome-ignore lint/security/noSecrets: This synthetic child reads stdin, not a secret.
        'const input=fs.readFileSync(0)',
        // biome-ignore lint/security/noSecrets: This synthetic child compares a fixed test word.
        "const ok=input.equals(Buffer.from('ping'))",
        'process.stdout.write(Buffer.from([0,255,10]))',
        'process.stderr.write(Buffer.from([1,254,13]))',
        'process.exitCode=ok?7:9',
      ].join(';'),
    ],
    Buffer.from('ping'),
  )
  assert.equal(io.status, 7)
  assert.deepEqual(io.stdout, Buffer.from([0, 255, 10]))
  assert.deepEqual(io.stderr, Buffer.from([1, 254, 13]))
  const missingChild = child(['env-lane-synthetic-missing-command'])
  assert.equal(missingChild.status, 127)
  assert.match(missingChild.stderr.toString(), /RUN_COMMAND_NOT_FOUND/)
  if (process.platform !== 'win32') {
    const terminated = child([process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"])
    assert.equal(terminated.status, null)
    assert.equal(terminated.signal, 'SIGTERM')
    const ready = path.join(temporary, '.child-ready')
    const stopped = path.join(temporary, '.child-terminated')
    const runner = spawn(
      process.execPath,
      [
        compiler,
        'run',
        'run',
        'server',
        '--run-cwd',
        'root',
        '--cwd',
        temporary,
        '--config',
        dynamic,
        '--quiet',
        '--',
        process.execPath,
        'child-wait.mjs',
      ],
      { stdio: 'ignore', env: { ...process.env, ENV_LANE_NATIVE_BINARY: binary } },
    )
    let childPid
    try {
      const closed = new Promise((resolve) =>
        runner.once('close', (code, signal) => resolve({ code, signal })),
      )
      await until(() => existsSync(ready), 'Config runner child readiness')
      childPid = Number(readFileSync(ready, 'utf8'))
      runner.kill('SIGINT')
      const timeout = setTimeout(() => runner.kill('SIGKILL'), 10_000)
      timeout.unref()
      const outcome = await closed.finally(() => clearTimeout(timeout))
      await until(() => existsSync(stopped), 'Config runner child cleanup')
      assert.deepEqual(outcome, { code: null, signal: 'SIGINT' })
      assert.equal(readFileSync(stopped, 'utf8'), 'SIGINT')
    } finally {
      runner.kill('SIGKILL')
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {}
      }
    }
  }
  writeFileSync(dynamic, 'export default { workspace: { includeRoot: Math.random() > 0.5 } }\n')
  assert.equal(compile('main', 'env-lane.dynamic.mjs').cacheable, false)
  process.stdout.write(
    'Rust JS/TS config cache: static reuse, stale rejection and dynamic runner passed.\n',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
  rmSync(gitOnly, { recursive: true, force: true })
}
