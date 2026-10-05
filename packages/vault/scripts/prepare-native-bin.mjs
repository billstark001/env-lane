import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const name = process.platform === 'win32' ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
const source = path.join(root, 'target/debug', name)
if (existsSync(source)) {
  const destination = path.join(root, 'packages/vault/dist', name)
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}
