import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import fg from 'fast-glob'
import { loadEnvLaneConfig } from './config.js'
import { listEnvFiles } from './dotenv.js'
import { listWorkspacePackages, resolveTargetPackage } from './workspace.js'

export interface CheckResult {
  ok: boolean
  selectorKey: string
  violations: Array<{ file: string; relativeFile: string; line?: number }>
  missingRequired: Array<{ file: string; relativeFile: string; target: string }>
}

function lineForKey(content: string, key: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  const idx = lines.findIndex((line) => re.test(line))
  return idx >= 0 ? idx + 1 : undefined
}

export async function checkDotenvSelector(
  options: {
    cwd?: string
    configFile?: string
    target?: string
    build?: string
    requireOverride?: boolean
  } = {},
): Promise<CheckResult> {
  const config = await loadEnvLaneConfig(options)
  const target =
    options.target && options.target !== 'all'
      ? await resolveTargetPackage(options.target, options)
      : undefined
  const scanDir = target?.dir ?? config.rootDir
  const files = await fg(['**/.env', '**/.env.*', '**/*.env', '**/*.env.*'], {
    cwd: scanDir,
    absolute: true,
    onlyFiles: true,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/tmp/**',
      '**/.git/**',
      '**/.turbo/**',
    ],
  })
  const violations: CheckResult['violations'] = []
  for (const file of files) {
    if (!existsSync(file)) continue
    const content = readFileSync(file, 'utf8')
    const parsed = parse(content)
    if (Object.prototype.hasOwnProperty.call(parsed, config.selector.envKey)) {
      violations.push({
        file,
        relativeFile: path.relative(config.rootDir, file).replaceAll(path.sep, '/'),
        line: lineForKey(content, config.selector.envKey),
      })
    }
  }
  const missingRequired: CheckResult['missingRequired'] = []
  if (options.requireOverride ?? config.dotenv.requireOverride) {
    const targets =
      options.target && options.target !== 'all'
        ? [await resolveTargetPackage(options.target, options)]
        : await listWorkspacePackages(options)
    for (const pkg of targets) {
      const envFiles = await listEnvFiles({
        cwd: options.cwd,
        configFile: options.configFile,
        target: pkg.relativeDir,
        build: options.build,
        requireOverride: true,
      })
      for (const file of envFiles.filter((item) => item.required && !item.exists)) {
        missingRequired.push({
          file: file.path,
          relativeFile: file.relativePath,
          target: pkg.name ?? pkg.relativeDir,
        })
      }
    }
  }
  return {
    ok: violations.length === 0 && missingRequired.length === 0,
    selectorKey: config.selector.envKey,
    violations,
    missingRequired,
  }
}
