import { NATIVE_TARGETS } from './native-targets.mjs'

function platform(suffix) {
  if (!Object.values(NATIVE_TARGETS).includes(suffix)) {
    throw new Error(`Unknown native platform: ${suffix}`)
  }
  const [os, cpu, abi] = suffix.split('-')
  return {
    cpu: [cpu],
    os: [os],
    ...(os === 'linux' ? { libc: [abi === 'gnu' ? 'glibc' : 'musl'] } : {}),
  }
}

export function nativePlatformManifest(suffix, version, description) {
  const addon = `env-lane-native.${suffix}.node`
  const binary = suffix.startsWith('win32') ? 'env-lane.exe' : 'env-lane'
  return {
    name: `@env-lane/native-${suffix}`,
    version,
    description,
    license: 'MIT',
    ...platform(suffix),
    main: addon,
    files: [addon, binary],
  }
}

export function vaultPlatformManifest(suffix, version) {
  const binary = suffix.startsWith('win32') ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
  return {
    name: `@env-lane/vault-native-${suffix}`,
    version,
    description: 'Native Vault plugin for env-lane',
    license: 'MIT',
    ...platform(suffix),
    main: binary,
    files: [binary],
  }
}

export function platformReadme(manifest) {
  const purpose = manifest.name.includes('/vault-native-')
    ? 'Platform executable for the optional `@env-lane/vault` plugin.'
    : 'Platform Node-API binding and CLI executable for `env-lane`.'
  return `# ${manifest.name}\n\n${purpose}\n`
}
