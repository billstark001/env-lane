# Versioning, changelog and publishing

## Independent package versions

Use `MAJOR.MINOR.PATCH`. Publishable packages and Rust workspace members share a major version;
while that major is zero, they also share a minor version. Patch versions may differ. The private
root package and Cargo workspace default version describe the compatibility line, rather than
the most recent package patch. Private test packages need no bump for unrelated releases.

Bump a package when its shipped behavior, files, or dependency requirements change. A dependency
range correction is a shipped metadata change and warrants a patch release even if its application
code is unchanged. Leave unaffected packages at their existing versions and omit them from the
release plan. Rust crates may override `version.workspace` for their own patch. The CLI executable
version matches `env-lane`; the native Vault plugin version matches `@env-lane/vault`.

## Dependency ranges

Ordinary internal npm dependencies must use an explicit compatible minimum, for example
`workspace:^0.5.1`. pnpm packs this as `^0.5.1`, allowing 0.5.2 and later compatible 0.5.x patches.
Use the oldest release containing the required behavior as the minimum; changing a different
package's patch must not silently move that floor. Do not use `workspace:*`, exact versions,
or bounded ranges that exclude later compatible patches for these dependencies. The workspace
metadata check enforces this policy and verifies that local versions satisfy their minimums.

Generated `@env-lane/native-*` and `@env-lane/vault-native-*` optional dependencies are the
exception: each platform artifact must exactly match its owning loader/plugin package release.
The native loader verifies this identity. Generate each family from its own package version;
the native and Vault families may have different patches. Every selected owning package publishes
all eight corresponding platform packages before itself.

Configuration cache compatibility follows `formatVersion` plus the compatible bridge release
line, rather than exact bridge/Core package equality. Patch updates preserve cache format;
incompatible envelope changes must increment the format version. Source hashes and dynamic-cache
freshness checks still apply.

## Changelog rules

Keep `CHANGELOG.md` in reverse chronological order with an Unreleased section. Use dated entries
and the categories Added, Changed, Fixed, Deprecated, Removed, Security, and Migration as needed.
Describe observable behavior and dependency changes; link the related issue or PR when useful.

- A shared major release, or shared minor release while major is zero, uses
  `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`.
- A partial or package patch release uses
  `## exact-package-name [MAJOR.MINOR.PATCH] - YYYY-MM-DD`.
- Write one entry per changed package. Do not invent entries or bump unaffected packages just
  because they share a batch tag. Generated platform packages belong in their owning package's
  entry. State when a release only changes dependency ranges.
- Repository-only tooling changes can stay under Unreleased. They do not require an SDK release.

## Selective release plans

A committed `releases/<tag>.json` declares the exact package versions in a publishing batch:

~~~json
{
  "packages": {
    "@env-lane/native": "0.5.2",
    "env-lane": "0.5.2"
  },
  "standalone": true
}
~~~

Use `vX.Y.Z` for a batch, or a scoped tag such as `core-v0.5.2` or `vault-v0.5.2` for independent
package releases. Supported scopes are `cli`, `native`, `core`, `vault`, `config-compat`, and
`plugin-sdk`; a scoped tag must select that package at the tagged version. This lets Core and Vault
both release 0.5.2 on different commits without reusing a tag. Each tag has its own plan file.

The batch tag is the highest selected version and at least one selected package has that version.
It does not assign a version to unselected packages. Manifest versions must equal their planned
versions. Set `standalone` only when selecting `@env-lane/native`. Cross-platform builds run only when
native or Vault packages are selected; JavaScript-only batches skip that matrix. Standalone
archives include the current Vault plugin version, even when Vault is omitted from npm publishing.

1. Update only affected package/crate versions, compatible dependency floors, and both lockfiles.
2. Write dated package changelog entries and the batch plan.
3. Run `pnpm check`, `pnpm rust:check`, and inspect `pnpm pack:dry-run` contents. The conformance
   gates verify selective plans, differing native/Vault patches, and real packed dependency ranges.
4. Preview the exact publishing list with `pnpm release:dry-run --tag vX.Y.Z`. This prints the
   selection without building or publishing artifacts.
5. Commit to main, then create an annotated batch or scoped tag on that clean commit. Substitute
   that exact tag in the preview and verification commands.
6. Run `pnpm release:verify --tag vX.Y.Z`, then push main and the tag.

Pushing the tag triggers `release.yml`; manual dispatch must also select that tag ref. Verification
checks the clean tagged commit, workspace compatibility, the committed selection, and changelog
entries. Publishing packs only selected workspace packages with pnpm, and uploads them with npm.
Before publishing, omitted internal dependency minimums must already exist in the registry.
Registry failures other than a missing version abort the run. Rerunning a partially completed
batch skips versions already published; it never overwrites them. GitHub standalone releases are
created only after npm publishing succeeds.

Each npm package, including generated platform packages, must already exist and authorize
repository `billstark001/env-lane`, workflow `release.yml`, environment `npm` as its Trusted
Publisher. First publication of a new package needs a separate bootstrap. The publish job grants
`id-token: write`, uses npm >= 11.5.1 with provenance, and rejects `NODE_AUTH_TOKEN` and `NPM_TOKEN`.
Keep this workflow identity stable when editing the release process. See the
[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
