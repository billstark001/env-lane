import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const workspace = path.resolve(import.meta.dirname, '../..')
const oracleDir = path.join(workspace, 'compat/oracle/v0.4.2')
const manifest = JSON.parse(readFileSync(path.join(oracleDir, 'manifest.json'), 'utf8'))
const artifactPath = path.join(oracleDir, manifest.artifact)
const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')

if (digest !== manifest.sha256) {
  throw new Error(`Oracle SHA-256 mismatch: expected ${manifest.sha256}, received ${digest}`)
}
// biome-ignore lint/security/noSecrets: This is the public immutable Git commit, not a secret.
if (manifest.gitCommit !== 'bdd0e9f4881b433063629e3caed04cd102444e44') {
  throw new Error(`Unexpected oracle commit: ${manifest.gitCommit}`)
}

const listing = spawnSync('tar', ['-tzf', artifactPath], { encoding: 'utf8' })
if (listing.status !== 0) throw new Error(`Cannot list oracle artifact: ${listing.stderr}`)
const entries = listing.stdout.trim().split('\n')
if (entries.some((entry) => !entry.startsWith('runtime/') || entry.includes('../'))) {
  throw new Error('Oracle archive contains a path outside runtime/')
}
const verboseListing = spawnSync('tar', ['-tvzf', artifactPath], { encoding: 'utf8' })
if (verboseListing.status !== 0)
  throw new Error(`Cannot inspect oracle artifact: ${verboseListing.stderr}`)
if (verboseListing.stdout.split('\n').some((line) => line.startsWith('l'))) {
  throw new Error('Oracle archive must not contain symbolic links')
}
const archivedLock = spawnSync('tar', ['-xOf', artifactPath, 'runtime/package-lock.json'], {
  encoding: 'utf8',
})
if (archivedLock.status !== 0)
  throw new Error(`Cannot read oracle package lock: ${archivedLock.stderr}`)
if (archivedLock.stdout !== readFileSync(path.join(oracleDir, manifest.runtimeLock), 'utf8')) {
  throw new Error('Oracle archive package-lock does not match the checked-in runtime lock')
}

process.stdout.write(`Verified env-lane ${manifest.version} oracle ${digest}\n`)
