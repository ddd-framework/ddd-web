# Changelog

## Unreleased
- Port of the DDD contract client (codegen, query, api, auth, contract).

### Fixed (review round 1)
- Build: the parallel tsup configs no longer clean each other's output (`dist/codegen/index.d.ts` was missing);
  `pnpm build` cleans `dist` once up front.
- codegen: the atomic output swap registers each restore right after its backup move — a failure between moving the
  old output away and moving the new one in restores the old output; a failed restore keeps the backup and names it.
- codegen: models with the same leaf name in different namespaces stay separate files with unique exported names
  (`Item`, `BooksItem`, …); the barrel exports every model file instead of dropping same-leaf entries.
- codegen: `--api` runs rebuild shared models from every configured spec, so fields contributed by other apis are kept.
- codegen: user `endpointOverrides` without `type` (e.g. only `parameterFilter`) no longer displace the
  `x-ddd-side-effects` classification; an explicit user `type` still wins.
- codegen: `skipUpdatePostTwins` honours `x-ddd-entity` (only upsert twins of the same entity) and, without it,
  requires identical summary, parameters, request body, responses and side-effect classification.
- codegen: writes without `x-ddd-entity` invalidate the whole entity tag (LIST + all ids).
- codegen: endpoints are matched to their operation through the generation itself, not by parsing URLs back —
  entity tags and side effects now survive `encodePathParams` and `flattenArg`.
- codegen: `esmExtensions` applies to model imports, the models barrel and the api's models import (`index.js`).
- codegen: only text-only endpoints get a `string` response type (binary downloads stay as RTK types them).
- codegen: `$ref` path parameters are resolved before deciding a placeholder is undeclared.
- codegen: RegExp side-effect overrides with `g` / `y` flags match statelessly.
- codegen: the `x-ddd-*` types and the side-effect default come from `contract` (`hasSideEffects`; OPTIONS/TRACE
  now count as reads); the codegen's tolerant input types derive from them.
- codegen: `ddd-web link-skills` says clearly when the installed package ships no skills or is not installed.
- api: token refresh shares one result per session generation: waiting requests retry even if the refreshed token
  string is unchanged, a late 401 after a failed refresh does not log out again, and a refresh that finishes after a
  logout or session change is discarded.
- api: `async-mutex` dependency removed.
- api: a non-empty string error body is used as the error message.
- auth: an injected token storage and a failing serializer can no longer make `TokenStorage` throw.
- auth: a present but invalid expiry claim counts as expired.
- contract: date-times with an offset are calendar-checked (`2026-02-30T00:00:00Z` → `null`).
- query: join keywords directly after a quote, bracket, number or `null` are recognised (`a eq '1'or b eq '2'`), so
  `combineFilters` groups such clauses correctly.
- query: list literals are written as JSON lists (`["a","b"]`), so any string — also with newlines or other
  control characters — reaches the backend unchanged (`formatFilterListItem`).
- query: `buildStaticArgsKey` / `buildColumnSearchesKey` serialise sorted `[name, value]` pairs as JSON
  (collision-free).

### CI / release
- CI checks every `exports` / `bin` target in the build and in the packed tarball, compiles a strict TypeScript
  consumer (bundler and nodenext) against the installed tarball with npm and pnpm, runs `ddd-web-sdk` on the sample
  spec there and type-checks the generated SDK (`test/consumer/run.sh`).
- Release workflow (`v*` tags): tag = version check, full verification, skills required in the tarball, staged
  publish via npm trusted publishing (`npm stage publish`, npm ≥ 11.15.0; approve with `npm stage approve`).

## 0.0.1
- Placeholder release to reserve the package name.
