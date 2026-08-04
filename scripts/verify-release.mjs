import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const rootDir = path.resolve(import.meta.dirname, '..')
const manifestPaths = [
  'package.json',
  'packages/core/package.json',
  'packages/vault/package.json',
  'packages/cli/package.json',
]

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), 'utf8'))
}

function git(...args) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim()
}

const manifests = manifestPaths.map((relativePath) => ({
  relativePath,
  manifest: readJson(relativePath),
}))
const version = manifests[0].manifest.version
for (const { relativePath, manifest } of manifests) {
  if (manifest.version !== version) {
    throw new Error(`${relativePath} has version ${manifest.version}; expected ${version}.`)
  }
}

const argumentIndex = process.argv.indexOf('--tag')
const argumentTag = argumentIndex === -1 ? undefined : process.argv[argumentIndex + 1]
const expectedTag = `v${version}`
const headTags = git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean)
const releaseTag =
  argumentTag ??
  (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined) ??
  headTags.find((tag) => tag === expectedTag)
if (!releaseTag) {
  throw new Error(
    `Release verification requires tag ${expectedTag}. Pass --tag ${expectedTag} locally.`,
  )
}
if (releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${version}.`)
}

const changelog = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8')
if (!changelog.includes(`## [${version}]`)) {
  throw new Error(`CHANGELOG.md does not contain a ${version} release heading.`)
}

if (git('status', '--porcelain')) {
  throw new Error('Release verification requires a clean working tree.')
}

if (process.env.GITHUB_ACTIONS === 'true') {
  if (process.env.GITHUB_REF_TYPE !== 'tag') {
    throw new Error('The release workflow must run from a tag ref.')
  }
  const tagCommit = git('rev-list', '-n', '1', releaseTag)
  const headCommit = git('rev-parse', 'HEAD')
  if (tagCommit !== headCommit) {
    throw new Error(`Release tag ${releaseTag} does not point at the checked-out commit.`)
  }
}

process.stdout.write(`Release metadata verified for ${releaseTag}.\n`)
