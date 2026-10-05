const path = require('node:path')

function platformSuffix() {
  const { platform, arch } = process
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported env-lane native architecture: ${arch}`)
  }
  if (platform === 'darwin') return `darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`
  if (platform === 'win32') return `win32-${arch === 'arm64' ? 'arm64' : 'x64'}-msvc`
  if (platform === 'linux') {
    const musl = !process.report?.getReport()?.header?.glibcVersionRuntime
    return `linux-${arch === 'arm64' ? 'arm64' : 'x64'}-${musl ? 'musl' : 'gnu'}`
  }
  throw new Error(`Unsupported env-lane native platform: ${platform}/${arch}`)
}

function resolveBinary() {
  if (process.env.ENV_LANE_NATIVE_BINARY) return path.resolve(process.env.ENV_LANE_NATIVE_BINARY)
  const name = `@env-lane/native-${platformSuffix()}`
  let addon
  try {
    addon = require.resolve(name)
  } catch (error) {
    throw new Error(`Native env-lane package ${name} is not installed`, { cause: error })
  }
  return path.join(path.dirname(addon), process.platform === 'win32' ? 'env-lane.exe' : 'env-lane')
}

module.exports = { platformSuffix, resolveBinary }
