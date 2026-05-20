import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { parse } from 'dotenv';
import { loadEnvLaneConfig } from './config.js';

export interface CheckResult {
  ok: boolean;
  selectorKey: string;
  violations: Array<{ file: string; relativeFile: string }>;
}

export async function checkDotenvSelector(options: { cwd?: string; configFile?: string } = {}): Promise<CheckResult> {
  const config = await loadEnvLaneConfig(options);
  const files = await fg(['**/.env', '**/.env.*', '**/*.env', '**/*.env.*'], {
    cwd: config.rootDir,
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**']
  });
  const violations: CheckResult['violations'] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = parse(readFileSync(file, 'utf8'));
    if (Object.prototype.hasOwnProperty.call(parsed, config.selector.envKey)) {
      violations.push({ file, relativeFile: path.relative(config.rootDir, file).replaceAll(path.sep, '/') });
    }
  }
  return { ok: violations.length === 0, selectorKey: config.selector.envKey, violations };
}
