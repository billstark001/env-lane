import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadVaultConfig } from './config.js';

function parseKey(line: string): string | undefined {
  const match = line.match(/^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1];
}

function commentOut(line: string): string {
  return line.trimStart().startsWith('#') ? line : `# ${line}`;
}

export async function sortEnvFile(envFilePath: string, templateFilePath: string) {
  const envAbs = path.resolve(envFilePath);
  const templateAbs = path.resolve(templateFilePath);
  if (!existsSync(templateAbs)) throw new Error(`Template env file does not exist: ${templateAbs}`);
  const current = existsSync(envAbs) ? readFileSync(envAbs, 'utf8') : '';
  const envLines = current.split(/\r?\n/).filter((line, idx, arr) => idx < arr.length - 1 || line.length > 0);
  const templateLines = readFileSync(templateAbs, 'utf8').split(/\r?\n/).filter((line, idx, arr) => idx < arr.length - 1 || line.length > 0);
  const envByKey = new Map<string, string[]>();
  const extras: string[] = [];
  for (const line of envLines) {
    const key = parseKey(line);
    if (!key) { extras.push(line); continue; }
    const bucket = envByKey.get(key) ?? [];
    bucket.push(line);
    envByKey.set(key, bucket);
  }
  const used = new Set<string>();
  const out: string[] = [];
  for (const line of templateLines) {
    const key = parseKey(line);
    if (!key) { out.push(line); continue; }
    const existing = envByKey.get(key);
    if (existing?.length) {
      out.push(...existing);
      used.add(key);
    } else {
      out.push(commentOut(line));
    }
  }
  for (const [key, lines] of envByKey) {
    if (!used.has(key)) out.push(...lines);
  }
  if (extras.some(Boolean)) out.push(...extras.filter(Boolean));
  const next = `${out.join('\n')}\n`;
  const changed = current !== next;
  if (changed) {
    mkdirSync(path.dirname(envAbs), { recursive: true });
    writeFileSync(envAbs, next, 'utf8');
  }
  return { applied: changed, filePath: envAbs, templateFilePath: templateAbs };
}

export async function sortEnvFilesFromConfig(configPath: string, keyArg = 'all', envSuffixArg = 'all') {
  const config = loadVaultConfig(configPath);
  if (!config.sort) throw new Error('config.sort is required for sortEnvFilesFromConfig.');
  const targets = Object.entries(config.sort).filter(([key]) => keyArg === 'all' || key === keyArg);
  const results = [];
  for (const [, target] of targets) {
    const jobs: string[] = [];
    if (envSuffixArg === 'all' || envSuffixArg === 'default') jobs.push(path.resolve(config.baseDir, target.file));
    if (target.files && envSuffixArg !== 'default') {
      for (const [suffix, file] of Object.entries(target.files)) {
        if (envSuffixArg === 'all' || envSuffixArg === suffix) jobs.push(path.resolve(config.baseDir, file));
      }
    }
    for (const file of jobs) results.push(await sortEnvFile(file, path.resolve(config.baseDir, target.template)));
  }
  return { applied: results.some(result => result.applied), count: results.length, results };
}
