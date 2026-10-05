import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { loadConfig } from 'c12'
import { findUp } from 'find-up'

export const CACHE_VERSION = 1
export const BRIDGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

const executableExtensions = ['js', 'ts', 'mjs', 'cjs', 'mts', 'cts']
const nativeExtensions = ['json', 'yaml', 'yml', 'jsonc', 'json5', 'toml']
const nonStaticSyntax =
  /\b(?:import\s*\(|require\s*\(|process\b|globalThis\b|performance\b|import\.meta\b|Date\b|fetch\s*\(|readFile(?:Sync)?\s*\(|readdir(?:Sync)?\s*\(|eval\s*\(|new\b|function\b|class\b|while\b|for\b|await\b|Math\.random\s*\(|crypto\b)/
const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g
const importPattern =
  /(?:\bimport\s+(?:[^'";]*?\s+from\s*)?|\bexport\s+(?:[^'";]*?\s+from\s*))['"]([^'"]+)['"]/g

function digest(data) {
  return createHash('sha256').update(data).digest('hex')
}

function assertJson(value, at = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || seen.has(value)) {
    throw new Error(`Configuration cannot be represented as JSON at ${at}`)
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJson(item, `${at}[${index}]`, seen)
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(`Configuration must contain plain objects at ${at}`)
    }
    for (const [key, item] of Object.entries(value)) assertJson(item, `${at}.${key}`, seen)
  }
  seen.delete(value)
}

async function projectRoot(cwd) {
  const marker = await findUp(['pnpm-workspace.yaml', 'package.json', '.git'], {
    cwd,
    type: 'file',
  })
  const [gitDirectory, gitFile] = await Promise.all([
    findUp('.git', { cwd, type: 'directory' }),
    findUp('.git', { cwd, type: 'file' }),
  ])
  const gitMarker = [gitDirectory, gitFile]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0]
  const gitRoot = gitMarker ? path.dirname(gitMarker) : undefined
  if (gitRoot) {
    const relative = marker ? path.relative(path.dirname(marker), gitRoot) : undefined
    if (
      !marker ||
      (relative !== undefined &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    ) {
      return gitRoot
    }
  }
  if (!marker) return cwd
  const candidate = path.dirname(marker)
  if (path.basename(marker) === 'package.json') {
    const workspace = await findUp('pnpm-workspace.yaml', { cwd: candidate, type: 'file' })
    if (!workspace) return candidate
    const workspaceRoot = path.dirname(workspace)
    if (gitRoot) {
      const relative = path.relative(gitRoot, workspaceRoot)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return candidate
      }
    }
    return workspaceRoot
  }
  return candidate
}

function localDependencyGraph(entry, packageName) {
  const visited = new Map()
  let staticGraph = true
  const extensions = [...nativeExtensions, ...executableExtensions]
  const isFile = (candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  }
  const resolveImport = (requested) => {
    if (isFile(requested)) return requested
    const candidates = [
      ...extensions.map((extension) => `${requested}.${extension}`),
      ...extensions.map((extension) => path.join(requested, `index.${extension}`)),
    ].filter(isFile)
    // Loader precedence for multiple source formats is not a safe cache dependency.
    if (candidates.length !== 1) staticGraph = false
    return candidates[0]
  }
  function visit(file) {
    if (visited.has(file)) return
    let bytes
    try {
      bytes = readFileSync(file)
    } catch {
      staticGraph = false
      return
    }
    const source = bytes.toString('utf8')
    visited.set(file, digest(bytes))
    if (nonStaticSyntax.test(source) || /\bextends\s*:|=>|`/.test(source)) staticGraph = false
    for (const call of source.matchAll(callPattern)) {
      if (call[1] !== 'defineConfig' && !/^define[A-Za-z]+Config$/.test(call[1]))
        staticGraph = false
    }
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) {
        if (!['env-lane', '@env-lane/core', packageName].includes(specifier)) staticGraph = false
        continue
      }
      const requested = path.resolve(path.dirname(file), specifier)
      const found = resolveImport(requested)
      if (!found) {
        staticGraph = false
        continue
      }
      visit(found)
    }
  }
  visit(entry)
  return {
    cacheable: staticGraph,
    dependencies: [...visited]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, sha256]) => ({ file, sha256 })),
  }
}

function cacheFile(root, kind, source) {
  return path.join(root, '.env-lane-cache', `${kind}-${digest(source)}.json`)
}

function discover(root, name, specified) {
  const base =
    specified ?? path.join(root, name === 'env-lane' ? 'env-lane.config' : `env-lane.${name}`)
  if ([...nativeExtensions, ...executableExtensions].includes(path.extname(base).slice(1))) {
    return existsSync(base) ? base : undefined
  }
  for (const extension of [...nativeExtensions, ...executableExtensions]) {
    for (const candidate of [
      `${base}.${extension}`,
      path.join(root, '.config', `${name}.config.${extension}`),
      path.join(root, '.config', `${name}.${extension}`),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export async function locateConfig({ kind = 'main', cwd = process.cwd(), configFile } = {}) {
  const invocationCwd = path.resolve(cwd)
  const root = await projectRoot(invocationCwd)
  const name = kind === 'main' ? 'env-lane' : kind
  const specified = configFile ? path.resolve(invocationCwd, configFile) : undefined
  const source = discover(root, name, specified)
  return {
    root,
    source,
    executable: Boolean(source && executableExtensions.includes(path.extname(source).slice(1))),
  }
}

function reusable(envelope, kind, source, root, graph) {
  return (
    envelope?.formatVersion === CACHE_VERSION &&
    envelope.bridgeVersion === BRIDGE_VERSION &&
    envelope.kind === kind &&
    envelope.source === source &&
    envelope.projectRoot === root &&
    envelope.configDir === path.dirname(source) &&
    envelope.cacheable === true &&
    envelope.config !== null &&
    typeof envelope.config === 'object' &&
    !Array.isArray(envelope.config) &&
    graph.cacheable &&
    JSON.stringify(envelope.dependencies) === JSON.stringify(graph.dependencies)
  )
}

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export async function compileConfig({
  kind = 'main',
  cwd = process.cwd(),
  configFile,
  packageName,
} = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(kind)) throw new Error(`Invalid configuration kind: ${kind}`)
  const invocationCwd = path.resolve(cwd)
  const root = await projectRoot(invocationCwd)
  const name = kind === 'main' ? 'env-lane' : kind
  const specified = configFile ? path.resolve(invocationCwd, configFile) : undefined
  const source = discover(root, name, specified)
  if (!source) throw new Error(`No ${kind} configuration file was found`)
  const extension = path.extname(source).slice(1)
  if (nativeExtensions.includes(extension))
    throw new Error('Native declarative config does not need compilation')
  if (!executableExtensions.includes(extension))
    throw new Error(`Unsupported configuration extension: ${extension}`)
  const graph = localDependencyGraph(source, packageName)
  const output = cacheFile(root, kind, source)
  if (existsSync(output)) {
    try {
      const old = JSON.parse(readFileSync(output, 'utf8'))
      if (reusable(old, kind, source, root, graph))
        return { file: output, reused: true, cacheable: true }
    } catch {}
  }
  const loaded = await loadConfig({
    name,
    cwd: root,
    configFile: path.relative(root, source),
    packageJson: false,
    dotenv: false,
    rcFile: false,
    globalRc: false,
    configFileRequired: true,
  })
  assertJson(loaded.config)
  const envelope = {
    formatVersion: CACHE_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    kind,
    source,
    projectRoot: root,
    configDir: path.dirname(source),
    cacheable: graph.cacheable,
    dependencies: graph.dependencies,
    config: loaded.config,
  }
  atomicJson(output, envelope)
  return { file: output, reused: false, cacheable: graph.cacheable }
}
