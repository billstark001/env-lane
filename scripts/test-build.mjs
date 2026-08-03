import { accessSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(import.meta.dirname, '..')
const packages = ['core', 'vault', 'cli']

for (const packageName of packages) {
  const distDir = path.join(rootDir, 'packages', packageName, 'dist')
  for (const artifact of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
    accessSync(path.join(distDir, artifact))
  }
  await import(pathToFileURL(path.join(distDir, 'index.js')).href)
  createRequire(import.meta.url)(path.join(distDir, 'index.cjs'))
}

accessSync(path.join(rootDir, 'packages', 'cli', 'dist', 'cli.js'))
