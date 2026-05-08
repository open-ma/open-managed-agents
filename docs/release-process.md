# Release Process

OMA uses [changesets](https://github.com/changesets/changesets) to manage
versioning and publishing for the public npm packages:

- `@openma/cli` (`packages/cli`)

`@openma/sdk` is **deprecated**: the openma API is wire-compatible with
Anthropic's Managed Agents API, so the recommended client is now
`@anthropic-ai/sdk` pointed at `baseURL: 'https://openma.dev'`. The package
remains in `packages/sdk` for reference; no new versions will be published.
See `packages/sdk/README.md` for the migration note.

All `@open-managed-agents/*` internal packages are private and never
published — changesets is configured to skip them entirely.

## TL;DR

```bash
# In the PR that introduces a user-visible change to cli or sdk:
pnpm changeset

# Pick the package(s), choose patch / minor / major, write a one-line
# changelog. Commits a .changeset/<random>.md file. Push it with the PR.
```

That's it. Once the PR is merged, the release bot does the rest.

## How a release happens

1. **You open a PR with code + a changeset.** `pnpm changeset` walks you
   through which package changed, what kind of bump (patch / minor /
   major), and a one-line summary. The summary lands in the changelog
   verbatim, so write it for users, not for reviewers.

2. **Reviewer merges the PR.** Code is on `main`. The release workflow
   (`.github/workflows/release.yml`) sees a pending changeset and opens
   (or updates) a "Version Packages" PR with:
   - Bumped versions in the affected `package.json`s
   - Updated `CHANGELOG.md`s containing every changeset summary since the
     last release, grouped by package
   - The `.changeset/*.md` files removed (consumed)

3. **You review the Version Packages PR.** Sanity-check the version bumps
   and changelog. Merge when ready.

4. **Merging triggers publish.** The release workflow runs again, sees no
   pending changesets, and publishes the bumped packages to npm via OIDC
   trusted publisher (no NPM_TOKEN). dist-tag is auto-derived from the
   version: `0.x.y` → `latest`, `0.x.y-beta.N` → `beta`.

5. **GitHub Release** is created automatically with the changelog body.

## Bump types

- `patch` — bug fix, no API change. `0.3.1 → 0.3.2`
- `minor` — backwards-compatible feature. `0.3.1 → 0.4.0`
- `major` — breaking change. `0.3.1 → 1.0.0`
- For `0.x.y` versions, semver allows breaking changes in `minor` bumps,
  but pick the most informative one. We're past the point where we can
  break the CLI without warning anyone.

## Beta / prerelease workflow

To start a beta cycle for the next release:

```bash
pnpm changeset pre enter beta
git add .changeset/pre.json
git commit -m "enter beta prerelease mode"
git push
```

While in beta mode, every Version Packages PR produces `0.x.y-beta.N`
versions, and publishes to `--tag beta` automatically. Users on the
default `latest` tag are unaffected.

To exit beta and ship the stable version:

```bash
pnpm changeset pre exit
git add .changeset/pre.json
git commit -m "exit beta prerelease mode"
git push
```

The next Version Packages PR will roll the accumulated changesets into a
single stable bump and publish to `latest`.

## What if my PR doesn't change a published package?

Don't add a changeset. Most PRs touch internal packages, console UI,
docs, or workers — none of those publish to npm. The release workflow
ignores PRs without a changeset.

If you're not sure, run `pnpm changeset --empty` to add a marker that
explicitly says "no version bump needed" (useful for changesets bot
checks).

## Trusted publisher setup

`release.yml` publishes via npm's OIDC trusted publisher. Each public
package needs the workflow registered on npmjs.com:

1. Go to https://www.npmjs.com/package/@openma/cli/access
2. Trusted Publishers → Add publisher → GitHub Actions
3. Owner: `open-ma`, repo: `open-managed-agents`
4. Workflow filename: `release.yml`
5. Environment: `production`

If the trusted publisher isn't configured, publish step 401s with
"audience mismatch" — recover by adding it.

**One workflow per package limit.** npm's trusted publisher only allows
one workflow per package, so we can't keep the old `publish-cli.yml` /
`publish-sdk.yml` as standalone escape hatches — they'd 401. The
`workflow_dispatch` trigger on `release.yml` itself is the escape hatch:
manually triggering it re-runs the same logic as a push, useful when you
want to re-attempt a publish after fixing a config issue without making
a no-op commit.

## Troubleshooting

**My changeset PR didn't open a Version Packages PR.**
Check `.changeset/` on main — if there's a `*.md` file there, the
workflow should have run. Look at the latest "Release" workflow run for
errors. Most common: trusted publisher config drift on npm.

**The Version Packages PR shows the wrong bump.**
Edit the `.changeset/*.md` file directly on the source PR (or on main
via a follow-up PR), then the bot re-rolls the Version Packages PR.

**I want to publish out-of-band right now without going through
changesets.**
You still need a changeset — the publish step only fires when changesets
sees a real version bump in `package.json`. Open a tiny PR that adds a
changeset for the hotfix, merge it, then merge the auto-generated
Version Packages PR. Total flow is 3 PR merges; with practice it's a
few minutes.

**I accidentally bumped to a version I shouldn't have.**
npm doesn't let you republish or downgrade. Bump again to a higher
version with the right content. Use `npm deprecate` if a published
version was actively harmful.

**I need to re-point a dist-tag (e.g. roll back `latest` to an older
version).**
This isn't supported via OIDC — you'll need to `npm login` locally and
run `npm dist-tag add @openma/cli@<version> latest`. Use sparingly; the
right answer for "this version is bad" is usually publish a new version
that fixes it, not move the tag.
