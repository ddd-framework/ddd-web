# Using @mgamadeus/ddd-web in an app

## Contents

1. Configuration (`openapi-config.ts`)
2. Generating the SDK (`ddd-web-sdk`)
3. Generated files and cache tags
4. Query builders (`/query`)
5. Base query, refresh and errors (`/api`)
6. Tokens (`/auth`)
7. Contract helpers (`/contract`)
8. Agent skills (`link-skills`)
9. Troubleshooting

## 1. Configuration (`openapi-config.ts`)

`export default defineConfig({...})` (loaded with jiti, so `.ts` works without a build step; `.js` / `.mjs` / `.cjs`
too). A plain RTK-codegen file with `export const apis = [...]` is accepted as well. The config may read env variables
— it is re-evaluated after the workspace value is resolved.

**Per api entry (`apis[]`, one per OpenAPI document / audience):**

| Option | Meaning |
|---|---|
| `schemaFile` (required) | Spec source: `https://…/api/<audience>/documentation/openApi` or a local JSON snapshot (relative to the config file). A snapshot makes generation reproducible and offline. |
| `apiFile` (required) | Module exporting the base api: a relative path, or a bare specifier used verbatim (`@/api/baseApi`). |
| `apiImport` | Named export in `apiFile`. Default `api`. |
| `outputFile` (required) | Generated endpoints file, e.g. `./src/api/adminApi.ts`. Tags and Enhanced files go next to it. |
| `exportName` | Name for `--api`. Default: stem of `outputFile`. |
| `hooks` | `true` or `{ queries, lazyQueries, mutations }`. |
| `audience` | Prefix stripped from operation tags (`Admin Books` → `Books`). Default: stem without `Api`. |
| `baseApiImport` | Import specifier of the base api used by `<stem>Enhanced.ts`. Default: `apiFile` relative to the output dir. |
| `skipUpdatePostTwins` | Overrides the global setting for this api. |
| `sideEffects` | Overrides checked before the global ones (first match wins). |
| `esmExtensions` | `true` for `moduleResolution: nodenext`: generated relative imports end in `.js`. |
| any other key | Passed to RTK codegen (`argSuffix`, `flattenArg`, `endpointOverrides`, `filterEndpoints`, …). |

**Global options:**

| Option | Meaning |
|---|---|
| `modelsDir` | Model output directory. Default `<dir of the first outputFile>/../models`; without it every api must share one output directory. |
| `skipUpdatePostTwins` | DDD `#[Update]` serves the same route as PATCH and POST; `true` generates only the PATCH hook. With `x-ddd-entity` both must be `upsert` of the same entity; without it summary, parameters, body and responses must be identical. Conflicting annotations never skip. Default `false` (keep it `false` when app code already calls the POST hooks). |
| `sideEffects` | `SideEffectsOverride[]` for specs without `x-ddd-side-effects`: `{ method?, path: string \| RegExp, sideEffects, endpointType? }`. A writing GET becomes a mutation, a reading POST a query; `endpointType: 'mutation'` keeps a reading POST a mutation that invalidates nothing. |
| `workspace` | `{ envVar, envFiles?, urlKeys?, prompt? }`: resolves a workspace / subdomain value (CLI `--workspace` → env → URL sniffed from `.env` / `.env.local` → TTY prompt) into `process.env[envVar]` before the config is evaluated again. |
| `tsconfig` | tsconfig of the final type check. Default `tsconfig.json` next to the config. |

```ts
export default defineConfig({
  skipUpdatePostTwins: true,
  sideEffects: [
    { method: 'GET', path: /\/books\/\{bookId\}\/generateSummary$/, sideEffects: true }, // writing GET → mutation
    { method: 'POST', path: '/api/admin/library/books/search', sideEffects: false },     // reading POST → query
  ],
  apis: [
    { schemaFile: './openapi/admin.json', apiFile: './src/api/baseApi.ts', apiImport: 'baseApi',
      outputFile: './src/api/adminApi.ts', hooks: true },
    { schemaFile: './openapi/public.json', apiFile: './src/api/baseApi.ts', apiImport: 'baseApi',
      outputFile: './src/api/publicApi.ts', hooks: true },
  ],
});
```

## 2. Generating the SDK (`ddd-web-sdk`)

```text
ddd-web-sdk [options]        (same as: ddd-web sdk [options])
  --config <path>       config file (default openapi-config.ts)
  --api <exportName>    generate only this api
  --schema <url|file>   spec source for the selected api (needs exactly one api, i.e. with --api)
  --workspace <value>   value for config.workspace.envVar (alias --subdomain)
  --skip-prettier       do not format the generated files
  --skip-tsc            do not type-check after generation
ddd-web link-skills     link the package's agent skills into .claude/skills/
```

Pipeline: load every spec once → validate the DDD contract parts → namespace registry from the `SchemaDefinition`
tags → RTK codegen per api → models → Enhanced endpoints (cache tags) → prettier → `tsc --noEmit`. Models are shared
between apis: an `--api` run still reads every configured spec to rebuild shared models (a spec that cannot be loaded
keeps its models from the previous output, with a warning). Programmatic use: `generateSdk({ config, api, schema,
skipTsc, logger })` from `/codegen`.

Add a script: `"gen:sdk": "ddd-web-sdk"`. Commit the generated files and, if you use snapshots, the snapshot.

## 3. Generated files and cache tags

| File | Content |
|---|---|
| `<stem>.ts` | RTK `injectEndpoints` on the base api: endpoints, hooks (names path-derived) |
| `<stem>Enhanced.ts` | `baseApi.enhanceEndpoints({ addTagTypes, endpoints })` — `providesTags` / `invalidatesTags`; import once |
| `<stem>Tags.ts` | `<stem>TagTypes` (const list) and `<Stem>TagType` (union) |
| `models/…` | one file per schema in its namespace folder (`App/Domain/…`), barrel `index.ts`; same leaf names in different namespaces get unique exported names |

Tag per endpoint: the entity of `x-ddd-entity` when present, else the operation tag, else the last path segment that
names a known tag (warning when none is found — the endpoint gets no tags).

| Endpoint | With `x-ddd-entity` | Without (path heuristic) |
|---|---|---|
| query, single (`…/{id}`) | provides `{ type, id }` | provides `{ type, id }` when the path is `/<collection>/{id}` |
| query, list / filter | provides `{ type, id: 'LIST' }` | same |
| upsert / delete with a path identity | invalidates `{ type, id }` + LIST | — |
| any other write | invalidates LIST + the whole tag | invalidates LIST + the whole tag |
| mutation without side effects | invalidates nothing | invalidates nothing |

## 4. Query builders (`/query`)

The backend reads `filters`, `orderBy`, `expand`, `select`, `top`, `skip` (no `$` prefix). Default `top` is 50.

```ts
import {
  buildQueryOptions, combineFilters, anyOfFilters, buildFieldFilter, buildInFilter, buildNotInFilter,
  buildBetweenFilter, buildNullFilter, buildContainsFilter, buildFulltextFilter, buildIntEqFilter, buildFullDayFilter,
  pageToSkip,
} from '@mgamadeus/ddd-web/query';

const filters = combineFilters(
  buildFieldFilter('status', 'PUBLISHED'),                       // status eq 'PUBLISHED'
  anyOfFilters(buildNullFilter('deletedAt'), buildFieldFilter('archived', false)),  // grouped: ( … or … )
  buildFulltextFilter('title', search, { mode: 'fb' }),          // title fb 'dune*' — undefined for a blank term
  buildIntEqFilter(search, 'id', { stripLeadingChar: '#' }),     // undefined unless numeric
  buildFullDayFilter(day, 'createdAt'),                          // undefined unless a real YYYY-MM-DD
);
const params = buildQueryOptions({
  filters,                                   // string or list of clauses (AND-combined)
  orderBy: [{ property: 'createdAt', direction: 'desc' }, 'title'],
  expand: { author: { select: ['id', 'name'] }, reviews: { filters: "rating ge '4'", top: 5 } },
  select: ['id', 'title', 'author.name'],
  top: 20,
  skip: pageToSkip(pageIndex, 20),
}, { maxTop: 100 });                         // above maxTop: throw (default) or topOverflow: 'clamp'
```

- Builders that return `undefined` are skipped by `combineFilters` / `anyOfFilters` — pass search input straight in.
- Lists (`in`, `ni`, `bw`) are written as JSON (`["a","b"]`); strings are single-quoted with `\'` / `\\` escaped
  (`escapeFilterString`, alias `escapeOData`).
- `ft` / `fb` need a FULLTEXT index on the backend property (otherwise 400).
- `buildContainsFilter(property, term)` writes `eq '*term*'` (LIKE), e.g. for plain translatable columns.
- `sanitizeSearchInput`, `buildStaticArgsKey`, `buildColumnSearchesKey` build stable cache / reset keys.

**Definition-driven** (when the operation carries `x-ddd-query`): `buildDefinedFilter(query, property, operator,
value)` validates
property, operator, column kind, options and value rules; `buildDefinedQueryOptions(query, input)` validates
`orderBy`, `expand`, `select` and `maxTop`; both throw `QueryValidationError` with every `QueryIssue` (the cases the
backend would answer 400 for). `validateFilter(query, { property, operator, value })`, `validateOrderBy`, `validateExpand`,
`validateSelect` return the issues without throwing. A `Date` value is written as `Y-m-d` on a `DAY` filter, as a UTC
DDD date-time otherwise.

## 5. Base query, refresh and errors (`/api`)

`createDddBaseQuery(options)`:

| Option | Meaning |
|---|---|
| `baseUrl` | API origin; request URLs are relative to it |
| `getTokens(context)` | current `{ accessToken, refreshToken }` (Redux state or a `TokenStorage`) |
| `setTokens(tokens, api)` | store a refreshed pair |
| `onLogout(api)` | once, when the session cannot be recovered |
| `refreshPath` / `refresh` | default refresh = `POST refreshPath { refreshToken }` → `{ accessToken, refreshToken }`; or a custom `DddRefreshFn` |
| `shouldRefresh(error, request)` | default `defaultShouldRefresh`: status 401 and not an auth route (`…/common/auth/…`, `isDddAuthRequest`) |
| `languageCode(context)` | value of the DDD `languageCode` header; `context.type` tells queries from mutations (e.g. editing language on writes, UI language on reads) |
| `headers(headers, context)` | further headers after the Bearer header |
| `debug` | pass page URL flags (`?debug`, `?noCache`, `?xdebug`, `?errorsAsJson`) through to API requests; default off |
| `fetchOptions` | further `fetchBaseQuery` options; the default `paramsSerializer` (`dddParamsSerializer`) drops `null` / `undefined` |

Refresh behaviour: one refresh per session generation, shared by all requests that fail meanwhile; each failed request
is retried once. A request that started before a finished refresh reuses its result; a late 401 after a failed refresh
neither refreshes nor logs out again; a refresh that finishes after a logout or a new login is discarded.

```ts
// also refresh on 403, except business refusals
shouldRefresh: (error, request) =>
  (error.status === 401 || error.status === 403) && !isBusinessRefusal(error) && !isDddAuthRequest(request),
```

Errors: `normalizeDddError(error)` → `{ status, message, validationErrors, details, body }` from an RTK error, a thrown
`Error` or a raw body (`error` key first, then a text body); `getErrorMessage`, `getErrorStatus` for UI code.
Downloads: `createDownloadResponseHandler(fallbackName)` as an endpoint's `responseHandler` saves the blob
and resolves to a serializable `{ filename, contentType, size }`; `blobResponseHandler` returns `{ blob, filename,
contentType }` instead; `downloadBlob`, `filenameFromContentDisposition` (RFC 5987) for own
handlers. Apps without a generated auth endpoint: `createAuthEndpoints(api, { loginPath, refreshPath })` injects
`authLogin` / `authRefresh`.

## 6. Tokens (`/auth`)

- `TokenStorage` = `read()` / `write({ accessToken?, refreshToken? })` (`undefined` keeps, `null` removes) /
  `clear()`; implementations never throw.
- `createLocalStorageTokenStorage({ accessKey, refreshKey, serialize, deserialize, storage })` keeps an existing
  storage format, e.g. the access token inside a JSON object:

  ```ts
  createLocalStorageTokenStorage({
    accessKey: 'session', refreshKey: 'session_refresh',
    serialize: (jwt, previous) => JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), jwt }),
    deserialize: (raw) => JSON.parse(raw).jwt,
  });
  ```
- `createMemoryTokenStorage()` for tests and SSR; `safeLocalStorage` / `safeSessionStorage` / `createSafeStorage` never
  throw (private mode, SSR).
- `decodeJwt(token)`, `getTokenExpiry(token)`, `isExpired(token, skewSeconds)` — an invalid expiry claim counts as
  expired.
- The Redux auth slice stays in the app (it binds the app's endpoints and user model).

## 7. Contract helpers (`/contract`)

- DDD `DateTime` serialises `Y-m-d H:i:s` in UTC **without offset** — `new Date(value)` would read local time. Use
  `parseDddDateTime` / `parseDddDateTimeMs` / `formatDddDateTime`, and `formatDddDate` / `isValidDddDate` for `Y-m-d`.
- `normalizeTranslationsStore` / `normalizeTranslationInfos`: PHP sends an empty map as `[]`; these return `{}`.
  `buildTranslationKey` / `parseTranslationKey` for translation map keys.
- `hasSideEffects(method, operation)`, `getContractInfo(document)`, `parseEntityIdentity('path:bookId')`,
  `isHiddenProperty`, `isPreservedOnOmission`, `isTranslatableProperty`.
- Types: `DddErrorBody`, `DddExceptionDetail(s)`, `FilterOperator` (`eq ne gt ge lt le in ni bw ft fb`),
  `QueryOptionsParams`, `DddQueryDefinition`, `DddEntityInfo`, `ChangeHistory`, `TranslationInfos`, … The `x-ddd-*`
  types describe the extensions; a backend that does not emit them yet is read with the documented defaults.

## 8. Agent skills (`link-skills`)

`pnpm exec ddd-web link-skills` symlinks every skill directory of the installed package into `.claude/skills/`.
Idempotent; an existing symlink is repointed, a real file or directory is never touched. Run it after install (e.g. in
`postinstall`) and commit the symlinks if the app versions its `.claude/skills`.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no <SchemaDefinition schemaRef="…"/> markup in tags[].description` | Spec fetched with `removeSchemaTags=1` — fetch it without |
| `DDD contract … is not supported` | The backend emits a newer contract than this package version: update `@mgamadeus/ddd-web` |
| `no info.x-ddd-contract — assuming a pre-contract DDD spec` | Backend without the contract extensions; works with heuristics |
| `No tag for <endpoint> — no cache tags generated` | Operation without a matching tag: add a tag on the backend controller or an `endpointOverrides` |
| `--schema needs exactly one api` | Combine with `--api <exportName>` |
| `All apis must share one output directory when modelsDir is not set` | Set `modelsDir` |
| `type check failed — previous output restored` | Fix the reported type error (often app code using a renamed hook), or `--skip-tsc` to inspect |
| A list does not refresh after a write | `<stem>Enhanced.ts` not imported; or the write has no tag — see section 3 |
| Every request logs out after a 401 | `refreshPath` wrong, or the refresh response lacks `accessToken` |
| Dates off by the zone offset | DDD date-times are UTC without offset: use `parseDddDateTime` |
| 400 on a filter that looks right | Column kind / FULLTEXT / options: validate with `buildDefinedFilter` when `x-ddd-query` is available |
