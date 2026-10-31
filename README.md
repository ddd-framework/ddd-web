# @mgamadeus/ddd-web

> **Status: pre-release.** 0.0.1 only reserved the package name; 0.1.0 is the first usable version.

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
Requires a backend on mgamadeus/ddd with OpenAPI contract version ≥ 1 (shipped with the `x-ddd-*` extensions).

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

## Development

pnpm only (version pinned in `package.json` → `packageManager`; enable with `corepack enable`).

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## License

MIT
