# Using @mgamadeus/ddd-web in an app

## Contents

1. Configuration (`openapi-config.ts`)
2. Generating the SDK (`ddd-web-sdk`)
3. Generated files and cache tags (3a file downloads, 3b file uploads and upload progress)
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
| `responseHandlers` | Overrides checked before the global ones (first match wins). |
| `invalidation` | Resolver checked before the global one (see section 3). |
| `esmExtensions` | `true` for `moduleResolution: nodenext`: generated relative imports end in `.js`. |
| any other key | Passed to RTK codegen (`argSuffix`, `flattenArg`, `endpointOverrides`, `filterEndpoints`, …). |

**Global options:**

| Option | Meaning |
|---|---|
| `modelsDir` | Model output directory. Default `<dir of the first outputFile>/../models`; without it every api must share one output directory. |
| `skipUpdatePostTwins` | DDD `#[Update]` serves the same route as PATCH and POST; `true` generates only the PATCH hook. With `x-ddd-entity` both must be `upsert` of the same entity; without it summary, parameters, body and responses must be identical. Conflicting annotations never skip. Default `false` (keep it `false` when app code already calls the POST hooks). |
| `sideEffects` | `SideEffectsOverride[]` for specs without `x-ddd-side-effects`: `{ method?, path: string \| RegExp, sideEffects, endpointType? }`. A writing GET becomes a mutation, a reading POST a query; `endpointType: 'mutation'` keeps a reading POST a mutation that invalidates nothing. |
| `responseHandlers` | `ResponseHandlerOverride[]`: `{ method?, path: string \| RegExp, handler: 'blob' \| 'text' \| 'json' }`, same matching as `sideEffects`. Wins over content-type detection — for specs that declare no or the wrong content type (a DDD backend often declares `application/json` for an Excel export). `json` turns a detected handler off. See section 3a. |
| `invalidation` | `(operation: InvalidationOperation) => InvalidationTag[] \| undefined`: overrides the tags a mutation invalidates; `undefined` keeps the default. `broadInvalidation` (exported) restores the 0.2 behaviour. See section 3. |
| `workspace` | `{ envVar, envFiles?, urlKeys?, prompt? }`: resolves a workspace / subdomain value (CLI `--workspace` → env → URL sniffed from `.env` / `.env.local` → TTY prompt) into `process.env[envVar]` before the config is evaluated again. |
| `tsconfig` | tsconfig of the final type check. Default `tsconfig.json` next to the config. |

```ts
export default defineConfig({
  skipUpdatePostTwins: true,
  sideEffects: [
    { method: 'GET', path: /\/books\/\{bookId\}\/generateSummary$/, sideEffects: true }, // writing GET → mutation
    { method: 'POST', path: '/api/admin/library/books/search', sideEffects: false },     // reading POST → query
  ],
  responseHandlers: [
    { method: 'GET', path: /\/export$/, handler: 'blob' },                              // Excel export declared as JSON
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

| Endpoint | With `x-ddd-entity` (authoritative) | Without (identity heuristic) |
|---|---|---|
| query, single (`…/{id}`) | provides `{ type, id }` | provides `{ type, id }` when the path is `/<collection>/{id}` |
| query, list / filter / action suffix | provides `{ type, id: 'LIST' }` | same |
| write with a path identity | upsert / delete with `identity: path:…`: invalidates `{ type, id }` + LIST | a path parameter naming the entity (`{bookId}` for `Books`) or right after its collection segment (`/books/{id}`): invalidates `{ type, id }` + LIST — also with an action suffix (`DELETE /books/{bookId}/cover`, `POST /books/{bookId}/publish`) |
| write with a body identity | upsert with `identity: body:book.id`: invalidates LIST + `{ type, id }` | the request DTO has exactly one property holding an entity of the tag (`{ book: Book }` → `book.id`, or the body is the entity): invalidates LIST + `{ type, id }` |
| write without identity (merge, batch, `action`, a path parameter of another entity) | invalidates LIST + the whole tag | invalidates LIST + the whole tag |
| mutation without side effects | invalidates nothing | invalidates nothing |

A body identity is read with optional chaining and added only while it is set (helper `tagWithId` in the enhanced
file): a create without id invalidates LIST alone, because `{ type, id: undefined }` would hit the whole tag type.
A path parameter that names another entity (`/books/{authorId}/import` under `Books`) is not an identity.

What a write does **not** invalidate: other tag types (writing a book does not refresh authors) and, for a write by
identity, single-entity queries of other ids of the same type. Where a write changes more than its own entity, add an
`invalidation` resolver:

```ts
import { defineConfig, type InvalidationResolver } from '@mgamadeus/ddd-web/codegen';

const invalidation: InvalidationResolver = (operation) => {
  // operation: { key, api, method, path, tag, operation?, entity?, sideEffects, pathArgs, bodyArg?, defaultTags }
  if (operation.key === 'postApiAdminLibraryBooksByBookIdPublish') {
    return [...operation.defaultTags, { type: 'Authors', id: 'LIST' }];   // also refresh author lists
  }
  if (operation.path.endsWith('/merge') && operation.tag) return [{ type: operation.tag, id: 'LIST' }, operation.tag];
  return undefined;                                                       // keep the default
};

export default defineConfig({ invalidation, apis: [/* … */] });
```

`InvalidationTag`: `'Books'` = every cached entry of the type; `{ type, id }` = a literal id (`'LIST'`);
`{ type, arg }` = the id read from the endpoint argument by a dotted path (`operation.pathArgs.bookId`,
`` `${operation.bodyArg}.book.id` ``; `''` = the argument itself with `flattenArg`). Resolver tag types are registered in
`addTagTypes` and the tags file. The resolver runs for every generated mutation (also side-effect-free ones, whose
default is `[]`); api-entry resolver first, then the global one; an invalid result aborts the generation.
`invalidation: broadInvalidation` restores the 0.2 output (every write without an `x-ddd-entity` path identity
invalidates LIST + its whole tag type).

**Typed tags in hand-written code.** Build the base api's `tagTypes` from the generated lists, then every
`providesTags` / `invalidatesTags` of an own `injectEndpoints` file and every `baseApi.util.invalidateTags()` is checked
against the generated names — a mistyped tag does not compile instead of silently invalidating nothing:

```ts
import { mergeDddTagTypes } from '@mgamadeus/ddd-web/api';
import { adminApiTagTypes } from './adminApiTags';       // the Tags files import nothing: no import cycle
import { clientApiTagTypes } from './clientApiTags';

export const baseApi = createApi({
  baseQuery: dddBaseQuery,
  tagTypes: mergeDddTagTypes([...adminApiTagTypes, ...clientApiTagTypes], ['Session']),   // own tags second
  endpoints: () => ({}),
});
```

An own tag that differs from a generated one only by case (`ProspectActivities` next to the generated
`Prospectactivities`) is a compile error. Never list generated tag names by hand.

## 3a. File downloads and text responses

The response handler of each endpoint follows its 2xx content types:

| 2xx content types | Generated | Result type |
|---|---|---|
| only file types: `application/octet-stream`, `application/zip`, `application/pdf`, `application/vnd.*` (Excel, Word, …), `text/csv`, `image/*`, `audio/*`, `video/*`, `font/*` (never `…json`) — text types may be mixed in | `responseHandler: blobResponseHandler` (imported from `@mgamadeus/ddd-web/api`) | `DddFileResponse` = `{ blob, filename, contentType }` |
| only `text/html`, `text/plain`, `text/xml` | `responseHandler: "text"` | `string` |
| anything else (JSON, mixed JSON and file) | RTK JSON parsing | the RTK type |

A `responseHandlers` override wins over detection. The handler is injected on the syntax tree of the generated api
file, independent of formatting; if it cannot be injected for a detected or overridden endpoint, `ddd-web-sdk` aborts
and lists the endpoints instead of generating a result type the request does not match. Error responses of blob endpoints are still parsed as JSON/text,
so `normalizeDddError` works as usual. Download in a component:

```ts
import { downloadBlob } from '@mgamadeus/ddd-web/api';
import { useLazyGetApiAdminLibraryBooksExportQuery } from './api/adminApi';

const [trigger, { isFetching }] = useLazyGetApiAdminLibraryBooksExportQuery();
const onExport = async () => {
  const { blob, filename } = await trigger({ noCache: true }).unwrap();
  downloadBlob(blob, filename ?? 'books.xlsx');            // filename comes from Content-Disposition, else null
};
```

A `Blob` is not serializable: Redux Toolkit's serializable check warns about it in development. Ignore the path
(`serializableCheck: { ignoredActionPaths: ['payload.blob'], ignoredPaths: [/\.blob$/] }`) or keep the data out of
the cache (`keepUnusedDataFor: 0` via `enhanceEndpoints`). Generated endpoints import the package's `api` entry, so the
app needs `@reduxjs/toolkit` (the `api` peer) installed.

## 3b. File uploads (multipart)

An operation whose request body offers `multipart/form-data` (a request DTO with `Parameter::FILES` properties) gets a
`multipartFiles` argument with one list per file field, and its body is built by `buildDddMultipartBody`:

| Operation accepts | Generated argument | Request |
|---|---|---|
| JSON and multipart | the JSON DTO argument as before + optional `multipartFiles` | JSON while no file is given; with a file `multipart/form-data`: the JSON envelope in the form field `body`, each file as `<field>[]` |
| multipart only | `multipartFiles` (required when the spec requires a file field) instead of RTK's body argument | always multipart |

```ts
const [send] = usePostApiClientChatMessagesMutation();
await send({ chatMessageCreateRequestDto: { chatMessage: { body: 'see attachment' } }, multipartFiles: { attachmentFiles: [file] } }).unwrap();
```

A file part is a `File` / `Blob`, or React Native's `{ uri, name, type }`. Never set a `Content-Type` header for such a
request. With `flattenArg` (the argument is the body itself) no files argument can be added: the generator warns and
the endpoint stays JSON-only. `File` objects in a mutation argument are not serializable — RTK Query's own actions are
exempt from the serializable check, do not copy them into other state.

**Upload with progress.** `fetch` reports no upload progress, so the base query has an `upload()` that sends the same
multipart form through `XMLHttpRequest` with the session of every other request (Bearer, `headers` / `languageCode`
hooks, the shared refresh and one retry). Use it in a `queryFn`, so hooks, cache tags and error handling stay RTK's:

```ts
// dddBaseQuery = createDddBaseQuery({...}), exported next to baseApi
uploadAttachment: build.mutation<AttachmentResponse, { itemId: number; file: File; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal }>({
  queryFn: async ({ itemId, file, onProgress, signal }, api, extraOptions) =>
    (await dddBaseQuery.upload(
      { url: `/api/client/items/${itemId}/attachments`, body: { caption: file.name }, files: { attachmentFiles: [file] }, onProgress, signal },
      api, extraOptions,
    )) as { data: AttachmentResponse } | { error: FetchBaseQueryError },
  invalidatesTags: (_result, _error, { itemId }) => [{ type: 'Items', id: itemId }],
}),
```

`onProgress(loaded, total)` restarts from 0 when the upload is repeated after a refresh. A cancelled upload (`signal`)
ends with an error for which `isDddUploadAborted(error)` is true; other errors have the base query's shape, so
`normalizeDddError` reads them.

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
| `relogin(context)` | re-opens the session when the refresh cannot: `context.reason` is `'no-refresh-token'` (guest, device, impersonation sessions) or `'refresh-rejected'`; return the new tokens (`refreshToken: null` allowed) or `null` to log out |
| `getSessionKey(context)` | key of the current session that survives a token refresh (account id, or a counter raised on login and logout; `null` without a session); needed to bind requests to a session, see below |
| `createUploadRequest()` | the request object of `upload()`; default `new XMLHttpRequest()` |
| `shouldRefresh(error, request)` | default `defaultShouldRefresh`: status 401 and not an auth route (`…/common/auth/…`, `isDddAuthRequest`) |
| `languageCode(context)` | value of the DDD `languageCode` header; `context.type` tells queries from mutations (e.g. editing language on writes, UI language on reads) |
| `headers(headers, context)` | further headers after the Bearer header |
| `debug` | pass page URL flags (`?debug`, `?noCache`, `?xdebug`, `?errorsAsJson`) through to API requests; default off |
| `fetchOptions` | further `fetchBaseQuery` options; the default `paramsSerializer` (`dddParamsSerializer`) drops `null` / `undefined` |

Refresh behaviour: one refresh per session generation, shared by all requests that fail meanwhile; each failed request
is retried once. A request that started before a finished refresh reuses its result; a late 401 after a failed refresh
neither refreshes nor logs out again; a refresh that finishes after a logout or a new login is discarded.

A session without refresh token (a guest with a stored credential, a device login, an impersonation renewed through
another session) recovers through `relogin` — never store a placeholder refresh token to make the refresh run:

```ts
relogin: async ({ reason, baseQuery, api, extraOptions }) => {
  const credential = readGuestCredential();
  if (!credential) return null;                               // → onLogout
  const result = await baseQuery({ url: '/api/public/common/auth/guest', method: 'POST', body: { credential } }, api, extraOptions as {});
  const data = result.data as { accessToken?: string; refreshToken?: string | null } | undefined;
  return data?.accessToken ? { accessToken: data.accessToken, refreshToken: data.refreshToken ?? null } : null;
},
```

**Requests bound to a session.** The Bearer token is read when a request is sent: after the wait for a running
refresh, and again for the retry. A request prepared for account A (an offline queue, an upload, an import) can
therefore leave with the token of account B when the user switched in between; a check before `dispatch()` does not
cover that. Give the base query a `getSessionKey` and bind such requests: a bound request is sent, and retried, only
while its session is the current one. Otherwise it ends with `{ error: { status: 'CUSTOM_ERROR', error:
'DDD_SESSION_CHANGED' } }` (`isDddSessionChanged(error)`) without a network call, a refresh or a logout. Requests that
are not bound behave as before.

```ts
createDddBaseQuery({ /* … */ getSessionKey: ({ getState }) => (getState() as RootState).auth.accountId });

// The session the caller prepared the request for (strictest form): the key is part of the endpoint's argument.
saveDraft: build.mutation<void, { accountId: number; draft: Draft }>({
  query: ({ accountId, draft }) =>
    withDddExpectedSessionKey({ url: '/api/client/drafts', method: 'POST', body: { draft } }, accountId),
}),

// An upload:
dddBaseQuery.upload({ url, files, expectedSessionKey: accountId }, api, extraOptions);

// The session that is current when the request starts (also for generated endpoints, through enhanceEndpoints):
api.enhanceEndpoints({ endpoints: { postClientDrafts: { extraOptions: { bindToSession: true } } } });
```

- The key must survive a token refresh: an account id or an app-side counter, never the access token (a refresh of
  the same session would block the retry).
- `withDddExpectedSessionKey` carries the key in the header `x-ddd-expected-session-key`; the base query removes it
  before sending. A `queryFn` can pass `{ expectedSessionKey }` as `extraOptions` instead.
- Treat `DDD_SESSION_CHANGED` like "not sent": a queued item stays queued for its own account.

It runs inside the shared refresh, so concurrent failures trigger it once.

```ts
// also refresh on 403, except business refusals
shouldRefresh: (error, request) =>
  (error.status === 401 || error.status === 403) && !isBusinessRefusal(error) && !isDddAuthRequest(request),
```

Errors: `normalizeDddError(error)` → `{ status, message, validationErrors, details, body }` from an RTK error, a thrown
`Error` or a raw body (`error` key first, then a text body); `getErrorMessage`, `getErrorStatus` for UI code. A
response that is not JSON (an HTML error page, a PHP fatal, a proxy 502 — RTK's `PARSING_ERROR`) counts as an HTTP
error: `status` is the HTTP status, the message `Server error (HTTP 500)` / `Request failed (HTTP 404)`, never the
`SyntaxError` text or the body (kept in `body`). `FETCH_ERROR` / `TIMEOUT_ERROR` read `The server could not be
reached` / `The request timed out`. Translate them with the third argument:
`getErrorMessage(error, t('Request failed'), { serverError: (status) => t('Server error (%s)', status), networkError: t('Offline') })`
(`DddErrorMessages`, defaults `DEFAULT_ERROR_MESSAGES`).
Downloads (generated endpoints get `blobResponseHandler` automatically, see 3a): `createDownloadResponseHandler(fallbackName)` as an endpoint's `responseHandler` saves the blob
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
| A screen shows stale data after a write that changes more than its own entity | Writes invalidate by identity since 0.3 — add an `invalidation` resolver for that endpoint (section 3), or `broadInvalidation` for the 0.2 behaviour |
| After an account switch a queued request was stored under the new account | Bind it to its session: `getSessionKey` + `withDddExpectedSessionKey` (section 5) |
| `a request is bound to a session, pass getSessionKey` | The base query has no `getSessionKey` option |
| A guest / device session logs out at the first 401 | It has no refresh token: pass `relogin` (section 5) |
| `multipart body not generated (…flattenArg…)` | The endpoint's argument is the body itself; drop `flattenArg` for it or send the files with `upload()` |
| An invalidation of a hand-written endpoint does nothing | Tag name in another case than the generated one: build `tagTypes` with `mergeDddTagTypes` (section 3) |
| A route is not in the deployed spec yet | Point `schemaFile` (or `--schema`) at a local spec file or the local backend and regenerate; no hand-written stopgap endpoint |
| Every request logs out after a 401 | `refreshPath` wrong, or the refresh response lacks `accessToken` |
| Dates off by the zone offset | DDD date-times are UTC without offset: use `parseDddDateTime` |
| 400 on a filter that looks right | Column kind / FULLTEXT / options: validate with `buildDefinedFilter` when `x-ddd-query` is available |
