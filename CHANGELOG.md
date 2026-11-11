# Changelog

## 0.6.1

### Fixed
- codegen: `<stem>Tags.ts` lists only the tags of the endpoints that are generated. A tag whose operations are all
  left out by `filterEndpoints` (or by `skipUpdatePostTwins`) was still listed, although no generated endpoint
  provides or invalidates it. **If hand-written endpoints use such a tag, name it as an own tag**:
  `mergeDddTagTypes([...adminApiTagTypes], ['Tracks'])`.

## 0.6.0

### Changed
- codegen: path parameters are encoded in the generated URL (`encodeURIComponent(String(queryArg.x))`); the api
  config option `encodePathParams` now defaults to `true`. A value with `/`, `?`, `#` or a space no longer changes
  the route. **After regenerating, remove your own `encodeURIComponent()` around path arguments** — the value would
  be encoded twice — or set `encodePathParams: false` for that api to keep the previous output.

## 0.5.0

Requests can be bound to the session they were prepared for. Additive: without `getSessionKey` nothing changes.

### Added
- api: option `getSessionKey` of `createDddBaseQuery` and three ways to bind a request to a session:
  `withDddExpectedSessionKey(request, key)` in an endpoint's `query`, `expectedSessionKey` of an upload, and
  `extraOptions: { bindToSession: true }` (the session that is current when the request starts;
  `{ expectedSessionKey }` for a `queryFn`). A bound request is sent, and repeated after a refresh, only while that
  session is the current one; otherwise it ends with the error of `isDddSessionChanged` (`DDD_SESSION_CHANGED`)
  without a network call, a refresh or a logout. Type `DddSessionBindingOptions`, constant
  `DDD_EXPECTED_SESSION_KEY_HEADER`.

### Fixed by binding
- A request that waited for a running refresh, or was repeated after one, was sent with the token of whatever
  session was current at that moment: after an account switch a body prepared for one account could be stored under
  another. Bind requests whose body belongs to an account (offline queues, uploads, imports).

## 0.4.0

File uploads, sessions without refresh token and typed cache tags. Minor release: the generated arguments of multipart
operations change.

### Added
- codegen: an operation with a `multipart/form-data` request body gets a `multipartFiles` argument (one list per file
  field) and sends `buildDddMultipartBody(<json body>, multipartFiles)`: JSON while no file is given, else multipart
  with the JSON envelope in the form field `body` and each file as `<field>[]`. Skipped with a warning for an
  endpoint with `flattenArg`.
- api: `buildDddMultipartBody`, `buildDddFormData`, `hasDddMultipartFiles`, types `DddMultipartFiles`, `DddFilePart`
  (a `File` / `Blob` or React Native's `{ uri, name, type }`).
- api: `createDddBaseQuery()` returns a base query with `upload(request, api, extraOptions)`: a multipart upload
  through `XMLHttpRequest` with progress (`onProgress`) and cancel (`signal`, `isDddUploadAborted`), sharing Bearer,
  the `headers` / `languageCode` hooks, the refresh and one retry. Option `createUploadRequest`.
- api: option `relogin` — re-opens the session when no refresh token is stored or the refresh was rejected
  (`DddReloginFn`, `DddReloginContext`). Without it the behaviour is unchanged.
- api: `mergeDddTagTypes(generated, own)` for the base api's `tagTypes`; an own tag that differs from a generated one
  only by case does not compile.

### Changed
- codegen: a multipart-only operation no longer has the body argument RTK codegen derived from the multipart schema
  (it typed the files as a schema of the backend's upload class); pass `multipartFiles` instead.
- A refresh for a session without refresh token is discarded when the access token changed while it ran.

### Replaces hand-written code
Search an app for these after the update and move them to the package:
- `new FormData(` together with `injectEndpoints`, `fetch(` or `XMLHttpRequest` → `multipartFiles` / `upload()`;
- a constant refresh token that only exists to make the refresh run (`getTokens` returning a marker) → `relogin`;
- a `tagTypes:` list that repeats generated tag names → `mergeDddTagTypes`.

## 0.3.1

The repository moved to the ddd-framework organisation: github.com/ddd-framework/ddd-web. No code changes; the npm
package name stays `@mgamadeus/ddd-web`.

### Changed
- package.json `repository`, `bugs` and `homepage` point to github.com/ddd-framework/ddd-web.

## 0.3.0

Cache invalidation by identity. Minor release because the default output changes: writes that invalidated their whole
tag type now invalidate only the entity they write plus LIST.

### Changed
- codegen: a mutation without `x-ddd-entity` derives the identity of the entity it writes and invalidates
  `{ type, id }` + `{ type, id: 'LIST' }` instead of LIST + every cached entry of the tag type:
  - a path parameter naming the tag's entity (`{bookId}` for `Books`), also with an action suffix
    (`DELETE /books/{bookId}/cover`, `POST /books/{bookId}/publish`), or a parameter right after the tag's collection
    segment that names no other entity (`/books/{id}`);
  - else the entity property of the request DTO (`{ book: Book }` → `<body>.book.id`, or `<body>.id` when the body is
    the entity). The id tag is only added while the body carries an id, so a create invalidates LIST alone. A body
    with a set, a list or a second entity of the tag (merge, batch) has no single identity.
  - Only a write without identity still invalidates LIST + the whole tag type.
- codegen: `x-ddd-entity` stays authoritative; its `body:<path>` identity on an upsert is now used as well
  (LIST + the entity while the body carries an id) instead of invalidating the whole tag type.
- The enhanced file contains a small `tagWithId` helper when a body identity is used.

### Added
- codegen: `invalidation?: (operation) => InvalidationTag[] | undefined` in `defineConfig`, globally and per api entry
  (api entry first, the first resolver that returns a list wins; `undefined` keeps the default). It gets the endpoint
  key, method, path, chosen tag, operation, `x-ddd-entity`, side-effect classification, path / body argument paths and
  the default tags. Tags: `'Books'` (whole type), `{ type, id }` (literal id, e.g. `'LIST'`), `{ type, arg }` (id read
  from the endpoint argument by a dotted path). Tag types introduced by a resolver are registered.
- codegen: `broadInvalidation`, a resolver that restores the 0.2 output.
- codegen: exported types `InvalidationTag`, `InvalidationOperation`, `InvalidationResolver`.

### Migration
- Regenerate the SDK. Screens refetch less after a write.
- A screen that relied on the broad invalidation (e.g. an action that changes other entities of the same type, or a
  single-entity query whose cache tag does not match the written id) may now show stale data. Fix it per endpoint
  with an `invalidation` resolver, or keep the old behaviour entirely with
  `defineConfig({ invalidation: broadInvalidation, … })`.

## 0.2.2

### Fixed
- api: `normalizeDddError` / `getErrorMessage` / `getErrorStatus` treat a response that is not JSON (RTK
  `PARSING_ERROR`: an HTML error page, a PHP fatal, a proxy 502) as an HTTP error — `status` is the HTTP status and the
  message is `Server error (HTTP <status>)` (≥ 500) or `Request failed (HTTP <status>)`, never the parser's
  `SyntaxError: Unexpected token '<' …` text and never the body (it stays in `body`).
- api: `FETCH_ERROR` and `TIMEOUT_ERROR` get readable messages (`The server could not be reached`,
  `The request timed out`) instead of the browser's error text.

### Added
- api: `DddErrorMessages` / `DEFAULT_ERROR_MESSAGES` and a third argument of `normalizeDddError` / `getErrorMessage`
  to replace (e.g. translate) these texts.

## 0.2.1

### Fixed
- codegen: the `responseHandler` (`blobResponseHandler` / `"text"`) is injected on the TypeScript syntax tree of the
  generated api file instead of by line patterns. Endpoints whose long names prettier wraps onto their own line
  (`key:` / `build.query<` / type arguments on separate lines) silently got no handler in 0.2.0 while their result
  type already said `DddFileResponse` / `string`.
- codegen: generation aborts with an error listing each endpoint (and the reason) when a detected or overridden
  handler cannot be injected, instead of skipping it.

### Migration
- Regenerate the SDK; affected long-named download and text endpoints now get their handler.

## 0.2.0

### Added
- codegen: file responses are detected by their 2xx content types (`application/octet-stream`, `application/zip`,
  `application/pdf`, `application/vnd.*` incl. spreadsheet types, `text/csv`, `image/*`, `audio/*`, `video/*`,
  `font/*`; never `…json`). Such endpoints get `responseHandler: blobResponseHandler` (imported from
  `@mgamadeus/ddd-web/api`) and the result type `DddFileResponse` (`{ blob, filename, contentType }`).
- codegen: `responseHandlers` overrides in `defineConfig`, globally and per api entry:
  `{ method?, path: string | RegExp, handler: 'blob' | 'text' | 'json' }`, matched like `sideEffects` (api entry
  first, first match wins). Overrides win over detection; `json` turns a detected handler off. For specs that declare
  no or the wrong content type, e.g. `application/json` for an Excel export route.
- codegen: exported types `ResponseHandlerOverride` and `OperationMatcher`.

### Changed
- codegen: a forced `text` handler on a JSON-declared response types the result as `string`.

### Migration
- Regenerate the SDK. Endpoints that return files now resolve to `DddFileResponse` instead of a JSON-parsed body —
  replace hand-written download endpoints with the generated hooks:
  `const { blob, filename } = await trigger(args).unwrap(); downloadBlob(blob, filename ?? 'export.xlsx')`.
- An app with file endpoints imports `@mgamadeus/ddd-web/api` from generated code, so `@reduxjs/toolkit` (the
  optional peer of `api`) must be installed — it already is for any RTK Query app.

## 0.1.0

First usable release.
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
