# Maintaining @mgamadeus/ddd-web

## Contents

1. Repository layout
2. Build, tests and the consumer check
3. The contract with mgamadeus/ddd
4. Release
5. Versioning and changelog
6. Rules for changes

## 1. Repository layout

```text
src/
  contract/   x-ddd-* types and defaults, error body, operators, QueryOptions params, translations, change history,
              DDD date-time — no runtime dependencies
  query/      builders (literals, filters, structure, order-by, select, expand, paging, keys, values) and the
              definition-driven validators (definition.ts) — no React, no RTK
  api/        createDddBaseQuery, refresh coordination, errors, downloads, debug passthrough, auth endpoints
  auth/       token storage adapters, JWT helpers, SSR-safe storage
  codegen/    cli.ts (bins), config.ts (defineConfig, loadConfig), generate.ts (pipeline), spec.ts (load + validate),
              registry / models / rtk / endpoints / enhance / tags / response-handlers (text + file detection and
              injection) / repair / output (atomic commit),
              workspace.ts, link-skills.ts
test/         vitest suites per subpath; fixtures/specs/sample-admin.json (neutral sample: books, authors);
              consumer/ (installed-package check); fixtures/private/ is ignored — never commit app specs
scripts/      clean.mjs (dist cleaned once before tsup), check-package.mjs (exports / bin targets, --require-skills)
.claude/skills/ddd-web-specialist/   this skill — shipped in the tarball, linked into apps by `ddd-web link-skills`
```

Each subpath is its own tsup entry with its own `.d.ts`; `codegen` is Node-only and must never be imported from the
other subpaths. `@reduxjs/toolkit` is an optional peer (only `api` needs it); `codegen` depends on
`@rtk-query/codegen-openapi`, `jiti` and `prettier`.

## 2. Build, tests and the consumer check

pnpm only (version pinned in `package.json` → `packageManager`; `corepack enable`). One lockfile.

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
node scripts/check-package.mjs .                       # every exports / bin target exists in dist
pnpm pack --dry-run                                    # what the tarball would contain (dist, .claude/skills, docs)
pnpm pack && test/consumer/run.sh mgamadeus-ddd-web-*.tgz pnpm /tmp/ddd-web-consumer
```

`test/consumer/run.sh <tarball> <npm|pnpm> <workDir>` installs the tarball into a fresh project and checks it as a user
would: tarball contents, runtime imports of every subpath, a strict TypeScript consumer with `moduleResolution`
`bundler` and `nodenext`, `ddd-web-sdk` on the sample spec (with `esmExtensions` for nodenext) plus a type check of the
generated SDK, and `link-skills`. CI (`.github/workflows/ci.yml`) runs all of this for npm and pnpm on every push to
`main` and every pull request, and fails on `workspace:` / `link:` / `file:` specifiers in `package.json`.

Test expectations:
- A codegen change gets a regression test against `test/fixtures/specs/sample-admin.json` (extend the sample — books,
  authors — rather than adding an app's spec).
- A `query` change states the backend rule it mirrors (`FiltersOptionsParser`, `FiltersOptions` column-kind
  validation) and tests the boundary.
- Refresh changes test concurrency: parallel 401s, a late 401 after a failed refresh, logout during a refresh.

## 3. The contract with mgamadeus/ddd

The codegen depends on what the DDD OpenAPI generator emits:
- **Implicit parts:** `tags[].description` with `<SchemaDefinition schemaRef="…"/>`; dotted schema names
  (`App.Domain.…`, `DDD.…`) that become model folders; the error body `{ error, validationErrors, exceptionDetails }`;
  the QueryOptions grammar; `#[Update]` serving PATCH and POST on one path.
- **Extensions** (types in `src/contract/extensions.ts`, all optional): `info.x-ddd-contract` (`{ contract, ddd }`),
  operation `x-ddd-query`, `x-ddd-side-effects`, `x-ddd-entity`, `x-ddd-cache-ttl`; property `x-ddd-translatable`,
  `x-ddd-hidden`, `x-ddd-preserve-on-omission`; schema `x-ddd-roles-required-for-update`. Every extension has a
  documented default when absent; the codegen must keep working on a spec without any of them.
- `SUPPORTED_CONTRACT` (`src/codegen/spec.ts`) is the contract range this version understands; outside it the codegen
  aborts with an update hint. Raise `max` only together with support for the new contract.

How both sides stay in step: a change to the OpenAPI output in `mgamadeus/ddd` shows up in its golden spec test, is
listed as a contract change in its changelog and is checked against this package's CI (sample spec + consumer check)
before it is released. On this side, a new contract number means: types in `contract`, behaviour in `codegen` /
`query`, a sample-spec case, `SUPPORTED_CONTRACT`, a changelog entry.

## 4. Release

1. Update `CHANGELOG.md` (move "Unreleased" to the version) and set `version` in `package.json`.
2. Commit, push, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag must equal `v` + the `package.json`
   version.
3. `.github/workflows/release.yml` (tags `v*`): version check, install, typecheck, test, build, pack, tarball check
   **with `--require-skills`** (fails without a `.claude/skills/*/SKILL.md`), consumer checks with npm and pnpm, then
   `npm stage publish <tarball>` via trusted publishing (OIDC, no token; npm ≥ 11.15.0). Versions with a prerelease
   suffix (`x.y.z-…`) go to the dist-tag `next`, others to `latest`.
4. The staged version is not public until a maintainer approves it: `npm stage list @mgamadeus/ddd-web`, then
   `npm stage approve <stage-id>` (2FA).

The verified tarball itself is staged — nothing is rebuilt after the checks. A failed release is fixed with a new
patch version; never re-tag a published version.

## 5. Versioning and changelog

Semver. In `0.x` a minor version may break the API, a patch never does. Every breaking change gets a migration note in
`CHANGELOG.md` (what to change in `openapi-config.ts`, which export was renamed, whether to regenerate). Hook names are
part of the API: a change to how they are derived is breaking.

## 6. Rules for changes

- No UI components, no styling, no app domain logic; generic only. Examples and fixtures stay neutral (books,
  authors, `example.com`).
- This repository is public: no local paths, no app-specific names, no internal procedures in code, docs, tests or
  commit messages.
- Keep `contract` and `query` free of React and RTK; keep `codegen` out of browser entry points.
- Update this skill (and the README) together with any change to options, CLI flags, generated files or behaviour
  described here.
