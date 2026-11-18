# @mgamadeus/ddd-web

> 0.x: a minor release may contain breaking changes, a patch never does — see CHANGELOG.md.

`@mgamadeus/ddd-web` is the frontend counterpart of [mgamadeus/ddd](https://packagist.org/packages/mgamadeus/ddd),
a PHP framework for domain-driven applications on top of Symfony and Doctrine, distributed via Composer/Packagist.
Every mgamadeus/ddd backend publishes an OpenAPI document per API audience (e.g. admin, partner, public, client) with a
shared set of conventions: entity schemas named after their PHP classes, OData-inspired QueryOptions, translatable
properties, change history, a uniform error format and JWT login with stateless refresh tokens. This package turns
those conventions into frontend code:

- **codegen**: a CLI that reads the backend's OpenAPI document (including the `x-ddd-*` extensions) and generates a
  typed RTK Query SDK: endpoints, React hooks, models and cache tags
- **query**: builders for DDD QueryOptions (`filters`, `orderBy`, `expand`, `select`, `top`/`skip`, fulltext),
  matching the backend's validation rules
- **api**: a base query for RTK Query with bearer auth, token refresh with a single retry, DDD error normalisation and
  file downloads
- **auth**: token-pair utilities and a pluggable storage adapter
- **contract**: TypeScript types for the DDD wire format
- **issues**: a client-errors reporter for browsers, Node servers and React Native apps that sends to the backend's
  issues log

It contains no UI components and no domain logic; apps bring their own design system and business screens.
Works with the OpenAPI output of current mgamadeus/ddd backends. The `x-ddd-*` extensions (contract version 1) are used
when a backend emits them; without them the generator falls back to path and request-body heuristics and prints a
warning.

## Usage

```sh
pnpm add @mgamadeus/ddd-web @reduxjs/toolkit
```

```ts
// openapi-config.ts
import { defineConfig } from '@mgamadeus/ddd-web/codegen';

export default defineConfig({
  apis: [{
    schemaFile: 'https://api.example.com/api/admin/documentation/openApi', // or a local snapshot file
    apiFile: './src/api/baseApi.ts', apiImport: 'baseApi',
    outputFile: './src/api/adminApi.ts', exportName: 'adminApi',
    hooks: { queries: true, lazyQueries: true, mutations: true },
  }],
});
```

```sh
pnpm exec ddd-web-sdk            # generate the SDK
pnpm exec ddd-web link-skills    # link the agent skills of all DDD packages into .claude/skills
```

Subpaths: `@mgamadeus/ddd-web/codegen`, `/query`, `/api`, `/auth`, `/contract`, `/fetch-api-request`, `/vite`
(pages whose global `Request` is not the Fetch API's, e.g. MooTools or Prototype: `dddFetchApiRequestPlugin()`) and
`/issues`, `/issues/browser`, `/issues/node`, `/issues/wire` (client errors, below).

### File downloads

Endpoints whose 2xx responses are files (`application/octet-stream`, `application/zip`, `application/pdf`,
`application/vnd.*` such as Excel, `text/csv`, `image/*`, …) are generated with `blobResponseHandler` and return a
`DddFileResponse` (`{ blob, filename, contentType }`); text-only responses get `responseHandler: "text"`.

```ts
import { downloadBlob } from '@mgamadeus/ddd-web/api';

const [trigger] = useLazyGetApiAdminLibraryBooksExportQuery();
const { blob, filename } = await trigger({}).unwrap();
downloadBlob(blob, filename ?? 'books.xlsx');
```

When a spec declares no or the wrong content type (e.g. `application/json` for an Excel export route), set the handler
in the config; overrides win over detection, the first match wins:

```ts
export default defineConfig({
  responseHandlers: [{ method: 'GET', path: /\/export$/, handler: 'blob' }], // 'blob' | 'text' | 'json'
  apis: [/* … each entry may have its own responseHandlers, checked first */],
});
```

### File uploads

Operations with a `multipart/form-data` request body get a `multipartFiles` argument; with a file the request is sent
as multipart (JSON envelope in the form field `body`), without one as JSON:

```ts
await send({ messageCreateRequestDto: { message: { body: 'see attachment' } }, multipartFiles: { attachmentFiles: [file] } }).unwrap();
```

For upload progress and cancel, `createDddBaseQuery(...)` returns a base query with `upload()` (XMLHttpRequest with the
same Bearer, headers, refresh and retry) to call from a `queryFn`:

```ts
queryFn: ({ file, onProgress }, api, extraOptions) =>
  dddBaseQuery.upload({ url: '/api/client/files', files: { files: [file] }, onProgress }, api, extraOptions),
```

`upload()` also sends a form you built (`formData`) or a JSON `body` with upload progress, and downloads with
`responseType: 'blob'` and `onDownloadProgress`.

### Sessions without refresh token

`relogin` re-opens a guest, device or impersonation session when there is no refresh token or it was rejected:

```ts
createDddBaseQuery({ /* … */ relogin: async ({ reason, baseQuery, api, extraOptions }) => reopenGuestSession(baseQuery, api, extraOptions) });
```

### Requests bound to a session

A request prepared for one account must not leave with another account's token after an account switch (the token is
read when the request is sent, after a running refresh, and again for the retry):

```ts
createDddBaseQuery({ /* … */ getSessionKey: ({ getState }) => (getState() as RootState).auth.accountId });

query: ({ accountId, draft }) => withDddExpectedSessionKey({ url: '/api/client/drafts', method: 'POST', body: { draft } }, accountId),
```

A bound request whose session is no longer the current one is not sent: `isDddSessionChanged(result.error)`. Uploads
take `expectedSessionKey`; `extraOptions: { bindToSession: true }` binds an endpoint's requests to the session they
start in.

### Typed cache tags

```ts
import { mergeDddTagTypes } from '@mgamadeus/ddd-web/api';
tagTypes: mergeDddTagTypes([...adminApiTagTypes], ['Session']), // hand-written endpoints are checked against the generated names
```

### Cache invalidation

Each mutation invalidates the entity it writes plus the lists of its tag type (`{ type, id }` + `{ type, id: 'LIST' }`).
The identity comes from `x-ddd-entity` when present, else from a path parameter naming the entity (`{bookId}`, also
`/books/{bookId}/publish`) or from the request DTO's entity property (`book.id`; a create without id invalidates LIST
only). Only a write without identity invalidates its whole tag type. To change the tags of single endpoints, add a
resolver; returning `undefined` keeps the default:

```ts
import { defineConfig } from '@mgamadeus/ddd-web/codegen';

export default defineConfig({
  invalidation: (operation) =>
    operation.path.endsWith('/merge') && operation.tag
      ? [{ type: operation.tag, id: 'LIST' }, operation.tag]   // 'Books' = every cached entry of the type
      : undefined,
  // or `invalidation: broadInvalidation` (also exported from /codegen): the 0.2 behaviour, writes invalidate their whole tag type
  apis: [/* … each entry may have its own invalidation, checked first */],
});
```

### Client errors

`@mgamadeus/ddd-web/issues` reports the errors of a browser, the app's Node server or a React Native app to the
client-errors endpoint of a mgamadeus/ddd backend (`IssuesLogService::logClientIssue`, Core 3.10.0 or newer; the
application declares the route, by default `POST /api/public/common/issues/report`). The core has no DOM, framework
or Node dependency; the platform adapters are separate entries.

```ts
// browser, before hydration
import {
  createBrowserIssuesReporter,
  createBrowserIssuesRouteTracker,
  installBrowserIssueCapture,
} from '@mgamadeus/ddd-web/issues/browser';

const issuesReporter = createBrowserIssuesReporter({
  app: 'web',
  endpoint: 'https://api.example.com/api/public/common/issues/report',
  release: () => document.documentElement.dataset.release ?? null,
  getAuthorization: () => tokenStorage.read().accessToken,
});
if (issuesReporter) installBrowserIssueCapture(issuesReporter); // uncaught errors, rejections, breadcrumbs, unload flush
const issuesRouteTracker = issuesReporter && createBrowserIssuesRouteTracker(issuesReporter);

// on every route change: the route PATTERN names the issue on the backend
issuesRouteTracker?.trackRoute(pathname, params); // → /books/[bookId]
```

```ts
// Node server (e.g. Next.js instrumentation.ts)
import { createNodeIssuesReporter, createServerRequestErrorHandler } from '@mgamadeus/ddd-web/issues/node';

const serverIssuesReporter = createNodeIssuesReporter({
  app: 'web',
  apiBaseUrl: process.env.API_INTERNAL_URL, // + the default report path; or `endpoint` = the full URL (wins)
  serverToken: process.env.ISSUES_INGEST_SERVER_TOKEN, // the backend files these as WEB_SERVER
});
export const onRequestError = createServerRequestErrorHandler(() => serverIssuesReporter);
```

Both adapters are generic over the wire types like the core: a `wire` built from your generated models
(`createNodeIssuesReporter({ …, wire: appIssuesWire })`) types the event and the body with them; without it the
DDD defaults apply.

React Native and other runtimes use `createIssuesReporter` from `/issues` with `createFetchIssuesTransport()`.
Everything is redacted on the device (tokens in paths and queries, e-mails, bearer / JWT tokens, UUIDs, phone numbers),
known noise is dropped, repeats are folded into `count`, and caps, batching, retry and backoff keep a broken page from
flooding the endpoint. Details: the agent skill, `references/consumer.md` › Client errors.

## Agent skills (`link-skills`)

The package ships the agent skill `ddd-web-specialist` (consumer guide + maintaining guide). `ddd-web link-skills`
links it — and the skills of every other DDD package installed through npm or Composer — into the repository's
`.claude/skills`:

```sh
ddd-web link-skills [--check] [--dry-run] [--quiet] [--root <dir>]
```

```json
{ "scripts": { "postinstall": "ddd-web link-skills" } }
```

Programmatic: `runSkillLinks({ cwd, root, check, dryRun, quiet, logger })` from `/codegen` returns a report with
`exitCode`, `skills`, `lines` and `problems`; `linkSkills()` (one result per skill) stays for existing callers.

### Vendor skill links — behaviour (shared by `ddd-link-skills` and `ddd-web link-skills`)

DDD packages ship agent skills at `<package>/.claude/skills/<name>/SKILL.md`. `ddd-link-skills` (Composer package
`mgamadeus/ddd`) and `ddd-web link-skills` (npm package `@mgamadeus/ddd-web`) generate and maintain the links to them.
Both behave identically, print the same lines and read and write the same manifest, so a Composer hook and an npm
postinstall never fight; either one alone links everything.

1. **Root**: the nearest ancestor of the working directory (itself included) that contains `.git` (folder or file),
   else the nearest that contains `.claude` (never the home folder), else the working directory. `--root <dir>` or the
   env variable `DDD_SKILLS_ROOT` override it. The install may run in a subfolder (Composer in `app/`, npm in `web/`).
2. **Discovery**: every `vendor/mgamadeus/*` and `node_modules/@mgamadeus/*` whose `vendor/` / `node_modules/` folder
   lies at most three levels below the root (`vendor/`, `app/vendor/`, `apps/admin/node_modules/`); other `vendor/`,
   `node_modules/` and dot folders are not searched, symlinked folders are not followed. A skill is a folder with a
   `SKILL.md`. Order: skill path, byte order. The same name from two packages is a clash: the first is kept and the
   clash reported. The same package installed twice (two Composer roots) is not a clash.
3. **Primary folder** `<root>/.claude/skills`, created when missing. When `.claude` or `.claude/skills` is a symlink
   (for example to `.codex`), the links go into its real location, once.
4. **Mirrors** `<root>/.agents/skills` and `<root>/.codex/skills` (Codex): the layout is detected, never changed. A
   missing mirror is not created; a mirror (or its parent) that resolves to the primary folder gets nothing; a mirror
   that is a real folder gets one link per skill, `../../.claude/skills/<name>`, pointing to the primary entry.
5. **Links**: relative targets from the link's real folder to the skill folder, for example
   `../../app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist`. Idempotent; a link into a DDD vendor area
   with another target is repointed. A real file or folder, or a symlink that points elsewhere, is never touched: it
   is reported as a clash with the app's own skill.
6. **Cleanup**: broken symlinks in the primary folder and the mirrors whose target lies in a `vendor/mgamadeus/` or
   `node_modules/@mgamadeus/` path are deleted (skill no longer shipped, package removed), and so are mirror links to
   primary entries that were removed. Only symlinks; app skills and real folders stay.
7. **Manifest** `<primary>/.ddd-skills.json` (format below), rewritten only when its content changes. An entry whose
   link still resolves but whose package was not found by this run (another install tree) is kept.
8. **Git**: a managed block in `<primary>/.gitignore` and in each real mirror folder's `.gitignore` lists the generated
   link names (and, in the primary, the manifest); everything outside the block stays. Nothing is removed from git:
   generated links that git still tracks are reported with the exact `git rm --cached -- …` command.
9. **`--check`**: changes nothing and exits 1, with a list, on missing links, stale targets, broken DDD links, an
   outdated manifest or gitignore block, clashes, generated paths still tracked, and edited vendor skills (same package
   version as in the manifest, different SKILL.md hash; a normal run warns and keeps the recorded hash, so the check
   keeps failing until the package is reinstalled). `--dry-run` prints what would change; `--quiet` prints only
   warnings and problems.
10. **Output and exit code**: one line per change, prefixed `[ddd-skills]`. A normal run always exits 0 (clashes and
    tracked links are warnings), except on an unexpected error writing the folder (exit 1).

Manifest:

```json
{
    "format": 1,
    "skills": {
        "ddd-entity-specialist": {
            "package": "mgamadeus/ddd",
            "version": "3.36.0",
            "source": "app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist",
            "target": "../../app/vendor/mgamadeus/ddd/.claude/skills/ddd-entity-specialist",
            "sha256": "<sha256 of SKILL.md>",
            "mirrors": [".agents/skills"]
        }
    }
}
```

`version` comes from `vendor/composer/installed.json` (else the package's `composer.json`) or the package's
`package.json`; `source` is relative to the root. Both tools write it byte-identically (4-space JSON, names sorted,
trailing newline).

Gitignore block:

```gitignore
# ddd-skills:start
# Generated by ddd-link-skills / ddd-web link-skills; rewritten on every install.
/.ddd-skills.json
/ddd-entity-specialist
# ddd-skills:end
```

### App-side setup

For an app whose Composer root is `app/` and whose frontend is `web/`:

1. `app/composer.json`, alongside the existing scripts:
   ```json
   "scripts": {
       "post-install-cmd": ["@php vendor/bin/ddd-link-skills", "..."],
       "post-update-cmd": ["@php vendor/bin/ddd-link-skills", "..."]
   }
   ```
2. `web/package.json`: `"postinstall": "ddd-web link-skills"` (an app that installs with `ignore-scripts` relies on
   the Composer hook, which links the npm skills too).
3. Run the install once, then untrack the formerly hand-made links the tool reports
   (`git rm --cached -- .claude/skills/ddd-entity-specialist …`) and commit together with the new `.gitignore` blocks.
4. CI or session start: `php app/vendor/bin/ddd-link-skills --check` (or `pnpm --dir web exec ddd-web link-skills
   --check`).

## Development

pnpm only (version pinned in `package.json` → `packageManager`; enable with `corepack enable`).

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm pack && test/consumer/run.sh mgamadeus-ddd-web-*.tgz pnpm /tmp/ddd-web-consumer   # installed-package check
```

Releases: push a tag `vX.Y.Z` matching `package.json`; the release workflow verifies the package and publishes it on
npm (trusted publishing with provenance).

## License

MIT
