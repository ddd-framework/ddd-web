---
name: ddd-web-specialist
description: "Use and maintain @mgamadeus/ddd-web, the TS client of mgamadeus/ddd. Covers openapi-config.ts with defineConfig (schemaFile, apiFile, outputFile, modelsDir, skipUpdatePostTwins, sideEffects and responseHandlers overrides, invalidation resolver, baseApiImport, esmExtensions, workspace), the RTK Query SDK from ddd-web-sdk (--api, --schema, --skip-tsc; Enhanced/Tags files, cache tags by entity identity, file downloads via blobResponseHandler), QueryOptions builders (buildQueryOptions, combineFilters, buildInFilter, buildFulltextFilter), createDddBaseQuery (Bearer, shared refresh + retry, shouldRefresh, normalizeDddError), token storage, JWT helpers, contract types (x-ddd-*, DDD date-time, translations), link-skills, maintaining (pnpm, vitest, consumer check, trusted-publishing release, 0.x semver). Use when wiring a frontend to a DDD backend, regenerating the SDK, building filters, fixing token refresh, cache tags or refetch storms, downloading an Excel/ZIP/PDF export, or releasing ddd-web."
metadata:
  author: mgamadeus
  version: "1.2.0"
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
- **File routes** (Excel, ZIP, PDF, …) are generated with `blobResponseHandler` and return
  `DddFileResponse`: `const { blob, filename } = await trigger(args).unwrap(); downloadBlob(blob, filename ?? 'x.xlsx')`.
  When the spec declares JSON for such a route, add a `responseHandlers` override (`handler: 'blob'`) — never
  hand-write a stopgap endpoint.
- **Never build filter strings by concatenation** — use the `query` builders; they escape strings, write lists as JSON
  and group `or` clauses (the backend parser has no precedence).
- **One refresh policy:** pass `shouldRefresh` instead of wrapping the base query; auth endpoints never refresh.
- **The spec must keep its `<SchemaDefinition schemaRef="…"/>` tag markup** — never fetch it with
  `removeSchemaTags=1`; the codegen aborts without it.
- `x-ddd-*` extensions are optional: without them the codegen falls back to HTTP-method, path and request-body
  heuristics. **Cache invalidation is by identity:** a write invalidates `{ type, id }` + LIST (identity from
  `x-ddd-entity`, a `{…Id}` path parameter even with an action suffix, or the request DTO's `<entity>.id`); only a write
  without identity invalidates its whole tag type. Writes that change more than their own entity get an
  `invalidation` resolver in the config (`broadInvalidation` = the 0.2 behaviour). A spec without
  `info.x-ddd-contract` is read as a pre-contract DDD spec (warning); an unsupported contract number aborts.

## References

- [references/consumer.md](references/consumer.md) — every config option, CLI flag, generated file and cache-tag rule;
  the query builders and validators; base query, refresh, errors, downloads; token storage; contract helpers;
  troubleshooting.
- [references/maintaining.md](references/maintaining.md) — repository layout, build and tests, the consumer check, the
  `x-ddd` contract and how it stays in step with `mgamadeus/ddd`, release workflow, versioning.
