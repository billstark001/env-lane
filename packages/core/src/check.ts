import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import fg from 'fast-glob'
import { loadEnvLaneConfig } from './config.js'
import { resolveTargetPackage } from './workspace.js'

export interface CheckResult {
  ok: boolean
  selectorKey: string
  violations: Array<{ file: string; relativeFile: string; line?: number }>
}

function lineForKey(content: string, key: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  const idx = lines.findIndex((line) => re.test(line))
  return idx >= 0 ? idx + 1 : undefined
}

export async function checkDotenvSelector(
  options: { cwd?: string; configFile?: string; target?: string } = {},
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
  return { ok: violations.length === 0, selectorKey: config.selector.envKey, violations }
}
