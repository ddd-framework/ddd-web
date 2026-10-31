---
name: ddd-web-specialist
description: "Use and maintain @mgamadeus/ddd-web, the TypeScript client for mgamadeus/ddd backends. Covers install, openapi-config.ts with defineConfig (schemaFile URL or local snapshot, apiFile, outputFile, modelsDir, skipUpdatePostTwins, sideEffects overrides, baseApiImport, esmExtensions, workspace), the RTK Query SDK from ddd-web-sdk (--config, --api, --schema, --skip-tsc; Enhanced/Tags files, cache tags from x-ddd-entity or path heuristics), QueryOptions builders (buildQueryOptions, combineFilters, buildInFilter, buildFulltextFilter, buildDefinedQueryOptions), createDddBaseQuery (Bearer, shared refresh + retry, shouldRefresh, languageCode, normalizeDddError, downloads), token storage and JWT helpers, contract types (x-ddd-*, DDD date-time, translations), link-skills, and maintaining it (pnpm, tsup, vitest, consumer check, staged npm release, 0.x semver). Use when wiring a frontend to a DDD backend, regenerating the SDK, building filters, fixing token refresh or cache tags, or releasing ddd-web."
metadata:
  author: mgamadeus
  version: "1.0.0"
  package: "@mgamadeus/ddd-web"
---

# ddd-web Specialist

`@mgamadeus/ddd-web` is the frontend counterpart of `mgamadeus/ddd` (PHP, Symfony + Doctrine). A DDD backend publishes
one OpenAPI document per API audience (admin, public, client, …) with shared conventions; this package turns them into
frontend code. No UI components, no domain logic — apps bring their own design system and screens.

> Backend patterns (entities, endpoints, QueryOptions, the OpenAPI generator): the `ddd-*` skills of `mgamadeus/ddd`.

## Subpaths

| Import | Runs in | Content |
|---|---|---|
| `@mgamadeus/ddd-web/codegen` | Node only (never in a browser bundle) | `defineConfig`, `generateSdk`, `linkSkills`, `loadSpec` / `validateSpec`; bins `ddd-web-sdk`, `ddd-web` |
| `@mgamadeus/ddd-web/query` | anywhere, no React | QueryOptions builders and definition-driven validators |
| `@mgamadeus/ddd-web/api` | needs `@reduxjs/toolkit` 2 (peer) | `createDddBaseQuery`, `createDddRefresh`, `normalizeDddError`, downloads, `createAuthEndpoints` |
| `@mgamadeus/ddd-web/auth` | anywhere | `TokenStorage` adapters, `decodeJwt`, `isExpired`, SSR-safe storage |
| `@mgamadeus/ddd-web/contract` | types + small helpers | `x-ddd-*` types, error body, DDD date-time, translations, operators |

ESM only, Node ≥ 20. Consumers may use npm or pnpm.

## Quick start

```sh
pnpm add @mgamadeus/ddd-web @reduxjs/toolkit react react-redux
```

```ts
// src/api/baseApi.ts — the one RTK api the generated endpoints are injected into
import { createApi } from '@reduxjs/toolkit/query/react';
import { createDddBaseQuery } from '@mgamadeus/ddd-web/api';

export const baseApi = createApi({
  baseQuery: createDddBaseQuery({
    baseUrl: 'https://api.example.com',
    refreshPath: '/api/admin/common/auth/refresh',
    getTokens: ({ getState }) => (getState() as RootState).auth,
    setTokens: (tokens, { dispatch }) => dispatch(authActions.updateTokens(tokens)),
    onLogout: ({ dispatch }) => dispatch(authActions.logout()),
  }),
  endpoints: () => ({}),
});
```

```ts
// openapi-config.ts (next to package.json)
import { defineConfig } from '@mgamadeus/ddd-web/codegen';

export default defineConfig({
  apis: [{
    schemaFile: 'https://api.example.com/api/admin/documentation/openApi', // or './openapi/admin.json'
    apiFile: './src/api/baseApi.ts', apiImport: 'baseApi',
    outputFile: './src/api/adminApi.ts', exportName: 'adminApi',
    hooks: { queries: true, lazyQueries: true, mutations: true },
  }],
});
```

```sh
pnpm exec ddd-web-sdk           # writes adminApi.ts, adminApiEnhanced.ts, adminApiTags.ts and ../models
pnpm exec ddd-web link-skills   # links this skill into .claude/skills/
```

Import `adminApiEnhanced` once (e.g. in the store setup) and use the hooks from `adminApi`:

```ts
import './api/adminApiEnhanced';
import { useGetApiAdminLibraryBooksListQuery } from './api/adminApi';
import { buildQueryOptions, buildInFilter } from '@mgamadeus/ddd-web/query';

const { data } = useGetApiAdminLibraryBooksListQuery({
  ...buildQueryOptions({ filters: [buildInFilter('status', ['DRAFT', 'PUBLISHED'])], orderBy: 'title asc', top: 20 }),
});
```

## Rules

- **Never edit generated files** (`<stem>.ts`, `<stem>Enhanced.ts`, `<stem>Tags.ts`, the models directory). Change the
  config, an override or the backend, then regenerate. The output is replaced atomically and rolled back when the
  final `tsc --noEmit` fails.
- **Regenerate after every backend change** to a route, DTO or entity the app uses; hook names derive from verb + path
  (`useGetApiAdminLibraryBooksListQuery`), so a renamed route is a renamed hook and shows up as a type error.
- **Never build filter strings by concatenation** — use the `query` builders; they escape strings, write lists as JSON
  and group `or` clauses (the backend parser has no precedence).
- **One refresh policy:** pass `shouldRefresh` instead of wrapping the base query; auth endpoints never refresh.
- **The spec must keep its `<SchemaDefinition schemaRef="…"/>` tag markup** — never fetch it with
  `removeSchemaTags=1`; the codegen aborts without it.
- `x-ddd-*` extensions are optional: without them the codegen falls back to HTTP-method and path heuristics and
  invalidates conservatively. A spec without `info.x-ddd-contract` is read as a pre-contract DDD spec (warning); an
  unsupported contract number aborts.

## References

- [references/consumer.md](references/consumer.md) — every config option, CLI flag, generated file and cache-tag rule;
  the query builders and validators; base query, refresh, errors, downloads; token storage; contract helpers;
  troubleshooting.
- [references/maintaining.md](references/maintaining.md) — repository layout, build and tests, the consumer check, the
  `x-ddd` contract and how it stays in step with `mgamadeus/ddd`, release workflow, versioning.
