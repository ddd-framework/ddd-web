# Changelog

## 0.19.2

### Fixed
- `mswHandlers`: a path parameter in the URL pattern is an MSW `:param` (one segment) instead of `*` (any segments).
  `*/books/*` also answered `/books/7/archive` and every other deeper path, so a handler could swallow the request of
  another operation and hide a wrong URL. Parameter names are reduced to word characters and kept unique
  (`{file-name}` → `:file_name`). The params a `response` function receives are unchanged. Regenerate the handlers;
  a hand-written `url` override keeps working as it is.

### Tests
- `mswPathPattern` (names, several parameters, duplicates) and a runtime check that `/books/:bookId` leaves
  `/books/7/preview` unanswered.

## 0.19.1

### Fixed
- `enums: 'const'`: an integer enum keeps its numbers (`{ "1": 1, "101": 101 }`); the members were strings (`"1"`), so
  the property type did not fit the numbers the backend sends.

## 0.19.0

### Added
- `generateLegacySdk({ prune: true })`: deletes the files an earlier run wrote and this run no longer plans. A
  manifest (`manifestFile`, default `.ddd-web-legacy-sdk.json`) records each source's and output's files; only listed
  files are deleted (hand-written files in a shared output directory stay), only for outputs that ran, and never a
  file an output that did not run (left out, skipped, not configured this time) still lists. The first run deletes
  nothing; `dryRun` reports and deletes nothing; folders left empty below an output directory are removed. Each
  result carries `pruned` (the deleted paths). Off by default: without `prune` nothing changes.
- `mswHandlers` (default mode): `<stem>Mocks.ts` next to each api file with one MSW handler factory per operation that
  has a request builder — URL `*` + path with `*` per path parameter, default answer from the application's model
  mocks (`modelMocks.importPrefix` + model path + `fileSuffix`, `get<Model>Mock`), an array of the item mock, `null`
  for no content and file downloads; overrides `url`, `status`, `delay`, `response` (value or function of params,
  default mock, info); `StoryMock` type exported. Per api: `outputFile`, `exportName`, `false`. `msw` is the
  consumer's dependency (generated code imports it); none is added to DDD Web. Off when absent: the generated
  output is byte-identical to 0.18.0 (compared on the sample spec and on three large application documents).
- Types `LegacySdkResult`, `MswHandlersOptions`, `ApiMswHandlersOptions`, `ModelMocksOptions` from `/codegen`.

### Tests
- `test/codegen/legacy-prune.test.ts` (first run, removed files, shared directory with hand-written files, partial
  and skipped runs, dry run, manifest bounds) and `test/codegen/msw-handlers.test.ts` (snapshot, path parameters,
  arrays, no content, text and binary, filtered endpoints, type check against generated models, MSW at runtime).
  `msw` is a dev dependency for these tests only.

## 0.18.0

### Added
- Opt-in SDK modes over the consumer's `swagger-sdk-generator` (`ddd-web-sdk --mode future|legacy`, or
  `generator.mode` in `openapi-config.ts`). Without a mode the generator is unchanged: DDD RTK Query, same output.
  - `future` (`swagger-sdk-generator@^3`): models and a typed promise client with a configurable transport (Fetch by
    default, an injected Axios instance, or a custom one) and optional seeded mocks.
  - `legacy` (`swagger-sdk-generator@^3.1`): legacy-dialect models, Redux-RxJS stores with thunks, and mocks.
  - Each opt-in API writes to `src/generated-sdk/<mode>/<output-file-stem>/` (`generator.outputDir` sets the base),
    is checked against the DDD contract, gets missing path parameters repaired, honours `skipUpdatePostTwins`, and is
    restored with every other selected API when the type check fails; `--api` and `--schema` work as for the default.
  - `generator.outputs` passes output options through, e.g. `client.transport` or `stores.runtimeModule` (one
    application-owned store runtime instead of a generated one).
- `generateLegacySdk()` from `/codegen`: runs legacy mode for an application that keeps its own sources and output
  directories (plain OpenAPI documents, staged before writing; files outside the plan stay).
- Docs: `docs/sdk-generator-integration.md`.

## 0.17.1

### Fixed
- A CommonJS script that loads code importing `@mgamadeus/ddd-web/contract` no longer fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`: the entries without runtime dependencies (`/contract`, `/query`, `/auth`,
  `/fetch-api-request`, `/issues`, `/issues/browser`, `/issues/node`, `/issues/wire`) have a `default` condition on
  their ES module build, so `require()` loads them on Node ≥ 20.19 / ≥ 22.12 (require of an ES module; no entry uses
  top-level await). On an older Node 20 the error is now `ERR_REQUIRE_ESM`.
- No CommonJS build: one module instance per entry, no dual-package state. `/api` (RTK Query peer dependency),
  `/vite` and `/codegen` stay import-only.

### Tests
- The consumer check requires every entry with a `default` condition from a CommonJS script against the packed
  tarball (`test/consumer/smoke-require.cjs`); a manifest test pins which entries are requirable.

## 0.17.0

### Changed
- `ddd-web link-skills` is now the vendor skill links tool shared with `ddd-link-skills` of mgamadeus/ddd 3.36.0
  (same behaviour, output and manifest; spec in the README, "Agent skills"):
  - finds the repository root (nearest ancestor with `.git`, else `.claude`; `--root`, `DDD_SKILLS_ROOT`), so the
    postinstall of a frontend in a subfolder links into the repository's `.claude/skills`, not `web/.claude/skills`;
  - links the skills of every `node_modules/@mgamadeus/*` AND `vendor/mgamadeus/*` package up to three levels below
    the root, not only this package's; a name shipped by two packages is reported as a clash;
  - writes into the real location when `.claude` or `.claude/skills` is a symlink, mirrors into existing real
    `.agents/skills` / `.codex/skills` folders (`../../.claude/skills/<name>`), never creates or changes a mirror
    layout;
  - removes broken links into DDD vendor areas (skill or package removed); app skills, real folders and foreign
    symlinks are never touched;
  - records each link in `<primary>/.ddd-skills.json` and keeps a `# ddd-skills:start` … `# ddd-skills:end` block in
    the `.gitignore` files; reports generated links git still tracks with the `git rm --cached` command;
  - output prefixed `[ddd-skills]`, one line per change; a normal run exits 0 (warnings), 1 only on a write error.
- `linkSkills()` keeps its signature and result (`linked` / `relinked` / `unchanged` / `skipped`, now with
  `package`); `cwd` is where the root search starts; `sourceDir` is deprecated.

### Added
- `ddd-web link-skills --check` (CI, session start: exit 1 on missing, stale or broken links, outdated manifest or
  gitignore block, clashes, tracked generated links, edited vendor skills), `--dry-run`, `--quiet`, `--root <dir>`.
- `runSkillLinks()`, `findSkillsRepositoryRoot()` and the types `SkillLinksOptions`, `SkillLinksReport`,
  `SkillsManifest`, `SkillsManifestEntry` from `/codegen`.

### App side
- `web/package.json`: `"postinstall": "ddd-web link-skills"`; with a Composer backend also
  `"@php vendor/bin/ddd-link-skills"` in `post-install-cmd` / `post-update-cmd` (either hook alone links everything).
- Once: untrack the formerly hand-made links the tool lists (`git rm --cached -- …`) and commit them with the new
  `.gitignore` blocks; add `ddd-web link-skills --check` to CI.

## 0.16.2

### Fixed
- `createIssuesRedactor` / `redactText` / `redactUrl`: a token after a token path segment (`/reset-password/…`) and a
  `token` query value now end at the next `/`, `?`, `#`, `&`, whitespace, quote (`'` `"` `` ` ``), `<`, `>`, `)` or
  `]`. Before, a token path segment in free text consumed the rest of the text up to the next `?` or `#`, so the text
  after it was lost and the e-mail and additional rules never applied to it.

## 0.16.1

### Changed
- `createBrowserIssuesReporter` / `createNodeIssuesReporter` and `BrowserIssuesReporterOptions` /
  `NodeIssuesReporterOptions` are generic over the wire event and request-body types, defaulting to the DDD ones: a
  `wire` built from your generated models now type-checks with the adapters, not only with `createIssuesReporter`.
  Existing calls compile unchanged.

### Added
- `NodeIssuesReporterOptions.endpoint` (string or function): the full URL of the ingest endpoint; wins over
  `apiBaseUrl` when both are set. `apiBaseUrl` keeps its behaviour (a function returns the full URL) for compatibility.
  The browser reporter already takes `endpoint` and has no `apiBaseUrl`.

## 0.16.0

### Added
- Client-errors reporter for the issues log of a mgamadeus/ddd backend (`IssuesLogService::logClientIssue`, Core
  3.10.0 or newer; body `{ report: { client, events } }` of the `ClientIssueReport` value objects, default path
  `/api/public/common/issues/report`):
  - `@mgamadeus/ddd-web/issues`: the platform-free core — `createIssuesReporter` (redact, drop, de-duplicate by
    `clientFingerprint` into `count`, session or windowed caps, batching ≤ 10 events / 48 KB, size shrinking, one retry,
    backoff, bearer and server-token headers), `normalizeError` / `parseStack` (V8, SpiderMonkey, JavaScriptCore),
    `createIssuesRedactor` / `redactUrl` / `redactText`, `buildClientFingerprint`, `ISSUES_LIMITS` /
    `mergeIssuesLimits`, `ISSUE_DROP_RULES` / `findIssueDropRule`, breadcrumb builders and trail, `buildRoutePattern`
    / `createIssuesRouteTracker`, `createFetchIssuesTransport`. No DOM, no Node API, no global read at import time:
    loads in React Native.
  - `@mgamadeus/ddd-web/issues/browser`: `createBrowserIssuesReporter`, `installBrowserIssueCapture` (uncaught errors,
    unhandled rejections; breadcrumbs from failed requests, `console.error` and clicks; flush on `pagehide`),
    `createBeaconIssuesTransport`, `createBrowserIssuesRouteTracker`, `captureRenderError`, `readOrCreateIssuesTabId`.
  - `@mgamadeus/ddd-web/issues/node`: `createNodeIssuesReporter`, `createServerRequestErrorHandler` (the shape of an
    `onRequestError` hook), `installNodeIssueCapture`.
  - `@mgamadeus/ddd-web/issues/wire`: the wire types (`DddClientIssueReport`, `DddClientIssueEvent`, …,
    `DddClientIssueIngestResult`), `dddIssuesWireAdapter`, `DDD_ISSUES_REPORT_PATH`.
- `pnpm typecheck` also checks the issues core without the DOM lib and without Node types
  (`tsconfig.issues-core.json`).

## 0.15.0

### Added
- `endpoints.requestBuilders: 'all'`: `<stem>Requests.ts` holds the request builder of every operation of the
  document (their argument types are written), while the api file injects only what `filterEndpoints` keeps.

### Changed
- Parameters `in: cookie` leave the generated endpoints by default (`endpoints.cookieParameters: 'drop'`): a browser
  sends its cookies itself and RTK Query's `FetchArgs` has no field for them — a request builder carrying `cookies`
  failed the type check. `cookieParameters: 'keep'` restores the former output.

## 0.14.0

### Added
- `endpoints.requestBuilders: true`: the request builder of every endpoint (its `query`) goes into
  `<stem>Requests.ts` next to the api file — `export const <stem>Requests = { <endpoint>: (queryArg: <Arg>): string |
  FetchArgs => ({ url, params, body, … }) }` — and the endpoint uses it (`query: <stem>Requests.<endpoint>`). A bundle
  that only builds requests imports that module without the endpoint injection. Off by default.

## 0.13.0

### Added
- `@mgamadeus/ddd-web/contract` exports `normalizeDddError`, `getErrorMessage`, `getErrorStatus`,
  `DEFAULT_ERROR_MESSAGE`, `DEFAULT_ERROR_MESSAGES` and the types `DddNormalizedError`, `DddErrorMessages`: code that
  loads no RTK Query runtime (a logic layer without Redux) normalizes DDD errors too. `/api` exports the same
  functions as before.

## 0.12.0

### Added
- `models.scope: 'all'`: every schema an operation of the document reaches is written, also when `filterEndpoints`
  leaves the operation out of the api file (a models-only pass; its argument and response types are not written).
  Default `reachable` (as before).

### Fixed
- With several documents, the enum consts of a shared model came from the LAST document while its type came from the
  first: both come from the first-listed document now.
- An enum value that gives no identifier after the key rules (`gemini/gemini-3.1-flash`) is its own quoted key.

## 0.11.0

### Added
- `models.index: false`: no barrel `index.ts`; the api file imports every model by its path.
- `models.enumPropertyType: 'wide'`: an enum property typed from the plain const object (`string` in effect) instead
  of the Strict one (default `strict`, as in 0.9.0).
- `models.objectType: 'const'`: a string `objectType` gets the one-value const of its schema name
  (`App_Domain_X: "App\\Domain\\X"`) and is required.

### Changed
- `models.naming: 'document'`: every model file exports its own schema's name, also when another folder holds the
  same name (before: qualified, `MoneyCurrency`); an importer aliases it, the barrel leaves such a name out (it broke
  the closing type check with a duplicate export), the api file imports each model by its path.
- Enum const keys camel-case a dash (`gpt-realtime` → `gptRealtime`).
- `endpoints.naming`: the built name is used verbatim — RTK codegen no longer camel-cases it a second time
  (`…FromLegacyDB` stayed `…FromLegacyDb`); `filterEndpoints` and `endpointOverrides` match the built name.

### Fixed
- An enum declared on an array schema stays an array (`Array<…>`).

## 0.10.0

### Added
- Codegen option `endpoints` (off by default, output unchanged without it):
  - `naming: 'path'`: endpoint (and hook) names as a pure function of verb and path — the prefix
    (`stripPathPrefix`, default `/api` or `/app/api`) cut, every `{param}/` cut out and only the last one kept, the
    rest capitalised behind the verb, `By<LastInner>` appended, a trailing `{param}` as `By<Param>` where it stands;
    `naming` may also be a function. Two operations with the same name stop the run. `buildEndpointNameFromPath` is
    exported.
  - `bodyArg: 'requestBody'`: the request body is the argument's `requestBody`, independent of the DTO's schema
    name.

## 0.9.0

### Added
- Codegen option `models` (every option off by default, output unchanged without it):
  - `naming: 'document'`: a model is named by the last dot segment of its schema name, unchanged
    (`AIConversationMessage`, not `AiConversationMessage`), and placed in the folders of the segments before it; a
    neighbour namespace that prefixes the name never splits it (`…Messages.DelegationResults` stays
    `Messages/DelegationResults.ts` beside `Messages/Delegation/`).
  - `enums: 'const'` (with `naming: 'document'`): an enum property becomes `export const <Model><Property>` and
    `<Model><Property>Strict` (`as const`) in its model's file, the property typed from the Strict object
    (`| null` when nullable, `Array<…>` for an enum of array items).
  - `nullableRefs: true`: `| null` beside a nullable `$ref`.
  - `idType: 'number' | 'string'`: the type of an `id` declared `string | integer`.

## 0.8.0

### Added
- `createDddBaseQuery().upload()` sends more than the DDD multipart form, with the same Bearer, hooks, refresh and
  retry: a form the caller built (`formData`, sent as it is) and a JSON body (`body` without `files`,
  `content-type: application/json`), each with upload progress; `files` is optional now.
- Download progress: `onDownloadProgress(loaded, total)` and `responseType` (`json` default, `text`, `blob`); a
  `GET` without body serves a download with progress.

### Changed
- The `params` of `upload()` go through `fetchOptions.paramsSerializer` when the consumer sets one (before: always
  the DDD serializer).

## 0.7.0

### Added
- `@mgamadeus/ddd-web/fetch-api-request`: `FetchApiRequest`, `resolveFetchApiRequest()`, `isFetchApiRequest`,
  `isFetchApiRequestConstructor`. They provide the Fetch API's `Request` constructor in pages whose global `Request` was
  replaced (MooTools 1.x, Prototype), taking it from a hidden frame when the page's constructor is not genuine.
- `@mgamadeus/ddd-web/vite`: `dddFetchApiRequestPlugin()` binds the `Request` of RTK Query's `fetchBaseQuery` to
  `FetchApiRequest` in builds, and fails the build when the toolkit's query module stays unbound.

### Fixed
- `createDddBaseQuery`: in such a page a request is refused with a `FETCH_ERROR` that names the cause
  (`DDD_FOREIGN_GLOBAL_REQUEST_MESSAGE`). Before, it was sent to `<page>/[object Object]` and failed as `PARSING_ERROR`.
  Your own `fetchOptions.fetchFn` is wrapped by the same check (`guardFetchApiRequest`).

## 0.6.2

### Fixed
- The generator loads in a consumer that installs with `legacy-peer-deps` and has `ajv` 6 at the top of
  `node_modules`: the `ajv` lookups of `ajv-draft-04` (the OpenAPI parser's) are answered from the parser's own `ajv`
  8, and the codegen is loaded after that hook.
- The closing type check runs the PROJECT's compiler, found through `typescript/package.json` `bin` (TypeScript 7
  exports no `typescript/bin/tsc`; the check fell back silently to the codegen's older TypeScript), and logs which one
  ran. The generator's own compiler only when the project has no `typescript`.
- Troubleshooting: a polling read with `subscribe: false` and `keepUnusedDataFor: 0` is aborted by the removal timer of
  the previous answer — subscribe while the read runs, unsubscribe after the answer.

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
