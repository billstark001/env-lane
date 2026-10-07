import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { loadReleasePlan, releaseTag, workspace } from './release-plan.mjs'

function git(...args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
}

execFileSync(process.execPath, ['scripts/verify-workspace-metadata.mjs'], {
  cwd: workspace,
  stdio: 'inherit',
})
const tag = releaseTag()
const plan = loadReleasePlan(workspace, tag)
const changelog = readFileSync(`${workspace}/CHANGELOG.md`, 'utf8')
for (const item of plan.packages) {
  assert.ok(
    changelog.includes(`\n## ${item.name} [${item.version}] - `) ||
      changelog.includes(`\n## [${item.version}] - `),
    `CHANGELOG.md needs a dated ${item.name} ${item.version} release entry`,
  )
}
assert.equal(git('status', '--porcelain'), '', 'Release verification requires a clean working tree')
assert.equal(git('rev-list', '-n', '1', tag), git('rev-parse', 'HEAD'), `${tag} must point at HEAD`)
if (process.env.GITHUB_ACTIONS === 'true') {
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'Run the release workflow from a tag ref')
  assert.equal(process.env.GITHUB_REF_NAME, tag)
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `native=${plan.native || plan.vault}\nstandalone=${plan.standalone}\n`,
  )
}
process.stdout.write(
  `Release metadata verified for ${tag}: ${plan.packages.map((p) => p.name).join(', ')}.\n`,
)
