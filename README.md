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

It contains no UI components and no domain logic; apps bring their own design system and business screens.
Works with the OpenAPI output of current mgamadeus/ddd backends. The `x-ddd-*` extensions (contract version 1) are used
when a backend emits them; without them the generator falls back to path heuristics and prints a warning.

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
pnpm exec ddd-web link-skills    # link the package's agent skills into .claude/skills
```

Subpaths: `@mgamadeus/ddd-web/codegen`, `/query`, `/api`, `/auth`, `/contract`.

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

## Agent skill

The package ships the agent skill `ddd-web-specialist` (consumer guide + maintaining guide). Link it into an app's
`.claude/skills` with `pnpm exec ddd-web link-skills`.

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
