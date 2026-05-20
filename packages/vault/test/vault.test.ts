import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decryptEnvFiles, encryptEnvFiles, sortEnvFile, warnUnsafeVault } from '../src/index.js';

describe('@env-lane/vault', () => {
  it('emits an unsafe warning unless explicitly disabled', () => {
    const write = vi.fn();
    warnUnsafeVault({ stderr: { write } });
    expect(write).toHaveBeenCalled();
    write.mockClear();
    warnUnsafeVault({ disableUnsafeWarning: true, stderr: { write } });
    expect(write).not.toHaveBeenCalled();
  });

  it('encrypts and decrypts dotenv files', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material');
    writeFileSync(path.join(root, '.env'), 'A=1\nB=2\n');
    writeFileSync(path.join(root, 'vault.json'), JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }));
    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), { disableUnsafeWarning: true });
    expect(enc.setRecordsWritten).toBe(2);
    writeFileSync(path.join(root, '.env'), 'A=changed\n');
    const dec = await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), { disableUnsafeWarning: true });
    expect(dec.filesWritten).toBe(1);
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('A=1');
  });

  it('sorts env file using template order', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, '.env'), 'B=2\nA=1\n');
    writeFileSync(path.join(root, '.env.example'), 'A=\nB=\nC=\n');
    await sortEnvFile(path.join(root, '.env'), path.join(root, '.env.example'));
    expect(readFileSync(path.join(root, '.env'), 'utf8').split('\n').slice(0, 3)).toEqual(['A=1', 'B=2', '# C=']);
  });
});
