import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const { platformSuffix } = require('../packages/native/bin.cjs')
const binary = process.platform === 'win32' ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
const source = path.join(root, 'target/debug', binary)
if (!existsSync(source)) throw new Error(`Build ${source} before staging local plugins.`)
const base = path.join(root, 'target/debug/plugins/@env-lane')
const vault = path.join(base, 'vault')
const platform = path.join(base, `vault-native-${platformSuffix()}`)
mkdirSync(vault, { recursive: true })
mkdirSync(platform, { recursive: true })
copyFileSync(path.join(root, 'packages/vault/package.json'), path.join(vault, 'package.json'))
copyFileSync(source, path.join(platform, binary))
writeFileSync(
  path.join(platform, 'package.json'),
  JSON.stringify({ name: `@env-lane/vault-native-${platformSuffix()}` }),
)
