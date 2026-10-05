import { chmodSync, copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const { platformSuffix } = require('@env-lane/native/bin.cjs')
const binary = process.platform === 'win32' ? 'env-lane.exe' : 'env-lane'
const source = [
  path.join(root, 'target/debug', binary),
  path.join(root, 'packages/native/npm', platformSuffix(), binary),
].find((candidate) => existsSync(candidate))
if (!source) throw new Error(`Native CLI artifact ${binary} is required before packaging.`)
const destination = path.join(root, 'packages/cli/dist/env-lane')
copyFileSync(source, destination)
if (process.platform !== 'win32') chmodSync(destination, 0o755)
if (process.platform === 'win32') copyFileSync(source, `${destination}.exe`)
