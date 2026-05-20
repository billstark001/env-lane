import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import picomatch from 'picomatch';
import { decryptRecord, deriveVaultKey, encryptRecord } from './crypto.js';
import { loadVaultConfig, type VaultConfig } from './config.js';
import { warnUnsafeVault } from './warning.js';

export type VaultOperation = 'set' | 'delete';

export interface VaultRecord {
  f: string;
  k: string;
  t: number;
  op: VaultOperation;
  v?: string;
}

function portable(file: string): string { return file.replaceAll(path.sep, '/'); }

function isExcluded(config: VaultConfig, filePath: string, key: string): boolean {
  const rel = portable(path.relative(config.baseDir, filePath));
  for (const rule of config.exclude) {
    const fileMatch = picomatch(rule.files, { dot: true });
    const keyMatch = picomatch(rule.keys, { dot: true });
    if ((fileMatch(rel) || fileMatch(path.basename(filePath))) && keyMatch(key)) return true;
  }
  return false;
}

function readStore(config: VaultConfig, key: Buffer): Map<string, Map<string, VaultRecord>> {
  const state = new Map<string, Map<string, VaultRecord>>();
  if (!existsSync(config.storePath)) return state;
  const lines = readFileSync(config.storePath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  lines.forEach((line, order) => {
    try {
      const record = JSON.parse(decryptRecord(key, line)) as VaultRecord;
      const filePath = path.resolve(record.f);
      const perFile = state.get(filePath) ?? new Map<string, VaultRecord>();
      const existing = perFile.get(record.k);
      if (!existing || record.t > existing.t || (record.t === existing.t && order >= 0)) perFile.set(record.k, { ...record, f: filePath });
      state.set(filePath, perFile);
    } catch {
      // Keep vault migration tolerant: unreadable records are ignored unless every record is bad.
    }
  });
  return state;
}

function append(config: VaultConfig, key: Buffer, record: VaultRecord): void {
  mkdirSync(path.dirname(config.storePath), { recursive: true });
  appendFileSync(config.storePath, `${encryptRecord(key, JSON.stringify(record))}\n`, 'utf8');
}

export async function encryptEnvFiles(configPath: string, keyFilePath: string, options: { disableUnsafeWarning?: boolean } = {}) {
  const config = loadVaultConfig(configPath);
  warnUnsafeVault({ disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning });
  const key = deriveVaultKey(keyFilePath);
  const state = readStore(config, key);
  let setRecordsWritten = 0;
  let deleteRecordsWritten = 0;
  let skippedUnchanged = 0;
  let excludedEntriesIgnored = 0;
  let missingFilesSkipped = 0;

  for (const filePath of config.envFiles) {
    if (!existsSync(filePath)) { missingFilesSkipped++; continue; }
    const parsed = parse(readFileSync(filePath, 'utf8'));
    const prev = state.get(filePath) ?? new Map<string, VaultRecord>();
    const current = new Map<string, string>();
    for (const [keyName, value] of Object.entries(parsed)) {
      if (isExcluded(config, filePath, keyName)) { excludedEntriesIgnored++; continue; }
      current.set(keyName, value);
      const old = prev.get(keyName);
      if (old?.op === 'set' && old.v === value) { skippedUnchanged++; continue; }
      append(config, key, { f: filePath, k: keyName, v: value, op: 'set', t: Date.now() });
      setRecordsWritten++;
    }
    if (config.trackDeletions) {
      for (const [keyName, old] of prev.entries()) {
        if (old.op === 'set' && !current.has(keyName)) {
          append(config, key, { f: filePath, k: keyName, op: 'delete', t: Date.now() });
          deleteRecordsWritten++;
        }
      }
    }
  }
  return { storePath: config.storePath, setRecordsWritten, deleteRecordsWritten, skippedUnchanged, excludedEntriesIgnored, missingFilesSkipped };
}

export async function decryptEnvFiles(configPath: string, keyFilePath: string, options: { dryRun?: boolean; disableUnsafeWarning?: boolean } = {}) {
  const config = loadVaultConfig(configPath);
  warnUnsafeVault({ disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning });
  const key = deriveVaultKey(keyFilePath);
  const state = readStore(config, key);
  let filesWritten = 0;
  const results: Array<{ filePath: string; keys: number; changed: boolean }> = [];
  for (const filePath of config.envFiles) {
    const desired = state.get(filePath) ?? new Map<string, VaultRecord>();
    const lines = [...desired.values()]
      .filter(record => record.op === 'set' && typeof record.v === 'string' && !isExcluded(config, filePath, record.k))
      .sort((a, b) => a.k.localeCompare(b.k))
      .map(record => `${record.k}=${record.v}`);
    const next = lines.length ? `${lines.join('\n')}\n` : '';
    const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    const changed = current !== next;
    if (changed && !options.dryRun) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, next, 'utf8');
      filesWritten++;
    }
    results.push({ filePath, keys: lines.length, changed });
  }
  return { storePath: config.storePath, filesWritten, results };
}

export async function runVault(configPath: string, keyFilePath: string, mode: 'encrypt' | 'decrypt', options: { dryRun?: boolean; disableUnsafeWarning?: boolean } = {}) {
  return mode === 'encrypt'
    ? encryptEnvFiles(configPath, keyFilePath, options)
    : decryptEnvFiles(configPath, keyFilePath, options);
}
