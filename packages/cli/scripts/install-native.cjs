const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } = require('node:fs')
const path = require('node:path')
const { resolveBinary } = require('@env-lane/native/bin.cjs')

const packageRoot = path.resolve(__dirname, '..')
// Skip only this repository's source package. Consumer workspaces can also have
// pnpm-workspace.yaml above node_modules/env-lane.
if (
  path.basename(packageRoot) === 'cli' &&
  path.basename(path.dirname(packageRoot)) === 'packages' &&
  existsSync(path.resolve(packageRoot, '../../Cargo.toml')) &&
  existsSync(path.resolve(packageRoot, '../../crates/env-lane-cli'))
) process.exit(0)

const source = resolveBinary()
const destinationDir = path.join(packageRoot, 'dist')
mkdirSync(destinationDir, { recursive: true })
const destination = path.join(destinationDir, 'env-lane')
copyFileSync(source, destination)
chmodSync(destination, 0o755)
if (process.platform === 'win32') copyFileSync(source, `${destination}.exe`)

let vaultVersion = null
try {
  let directory = path.dirname(require.resolve('@env-lane/vault'))
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json')
    if (existsSync(manifest)) {
      const packageJson = JSON.parse(readFileSync(manifest, 'utf8'))
      if (packageJson.name === '@env-lane/vault') {
        vaultVersion = packageJson.version
        break
      }
    }
    directory = path.dirname(directory)
  }
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}
writeFileSync(path.join(destinationDir, 'env-lane-install.json'), `${JSON.stringify({ vaultVersion })}\n`)
