const { copyFileSync, existsSync, mkdirSync, chmodSync } = require('node:fs')
const path = require('node:path')
const { platformSuffix } = require('@env-lane/native/bin.cjs')

const root = path.resolve(__dirname, '..')
// The repository source package uses target/debug; consumers receive a platform package.
if (
  path.basename(root) === 'vault' &&
  path.basename(path.dirname(root)) === 'packages' &&
  existsSync(path.resolve(root, '../../Cargo.toml'))
) process.exit(0)

const name = process.platform === 'win32' ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
const packageName = `@env-lane/vault-native-${platformSuffix()}`
const source = require.resolve(packageName)
const destination = path.join(root, 'dist', name)
mkdirSync(path.dirname(destination), { recursive: true })
copyFileSync(source, destination)
if (process.platform !== 'win32') chmodSync(destination, 0o755)
