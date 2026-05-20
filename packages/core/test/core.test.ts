import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listEnvFiles, listWorkspacePackages, resolveInjectedEnv, resolveTargetPackage } from '../src/index.js';

function fixture(): string {
  const root = path.join(tmpdir(), `env-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, 'apps/api'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  writeFileSync(path.join(root, 'env-lane.config.ts'), `export default { workspace: { aliases: { api: '@acme/api' } } };\n`);
  writeFileSync(path.join(root, 'apps/api/package.json'), JSON.stringify({ name: '@acme/api' }));
  writeFileSync(path.join(root, 'apps/api/.env'), 'A=1\nSECRET_TOKEN=abc\n');
  writeFileSync(path.join(root, 'apps/api/.env.production'), 'A=2\nB=3\n');
  return root;
}

describe('@env-lane/core', () => {
  it('discovers workspace packages and aliases', async () => {
    const root = fixture();
    const packages = await listWorkspacePackages({ cwd: root });
    expect(packages.some(pkg => pkg.name === '@acme/api')).toBe(true);
    await expect(resolveTargetPackage('api', { cwd: root })).resolves.toMatchObject({ name: '@acme/api' });
  });

  it('falls back to root when there are no subpackages', async () => {
    const root = path.join(tmpdir(), `env-lane-root-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'single' }));
    await expect(resolveTargetPackage(undefined, { cwd: root })).resolves.toMatchObject({ isRoot: true });
  });

  it('lists files and resolves injected env in order', async () => {
    const root = fixture();
    const files = await listEnvFiles({ cwd: root, target: 'api', build: 'production' });
    expect(files.map(file => path.basename(file.path))).toEqual(['.env', '.env.production']);
    const resolved = await resolveInjectedEnv({ cwd: root, target: 'api', build: 'production', includeProcessEnv: false });
    expect(resolved.values.A).toBe('2');
    expect(resolved.values.B).toBe('3');
    expect(resolved.values.ENV_BUILD).toBe('production');
  });
});
