// Installed-package type test: imports every public subpath and uses a few exports with their declared types.
// Compiled against the packed tarball with `moduleResolution: bundler` and `nodenext` (see run.sh).
import { createDddBaseQuery, getErrorMessage, type DddBaseQuery, type DddNormalizedError } from '@mgamadeus/ddd-web/api';
import { createMemoryTokenStorage, isExpired, type DddTokens, type TokenStorage } from '@mgamadeus/ddd-web/auth';
import { defineConfig, type GenerateSdkOptions, type SdkConfig } from '@mgamadeus/ddd-web/codegen';
import { hasSideEffects, parseDddDateTime, type DddEntityInfo, type FilterOperator } from '@mgamadeus/ddd-web/contract';
import { buildInFilter, buildQueryOptions, combineFilters, type QueryOptionsParams } from '@mgamadeus/ddd-web/query';
import manifest from '@mgamadeus/ddd-web/package.json' with { type: 'json' };

const storage: TokenStorage = createMemoryTokenStorage({ accessToken: 'a', refreshToken: 'r' });
const tokens: DddTokens = storage.read();
const baseQuery: DddBaseQuery = createDddBaseQuery({
  baseUrl: 'https://api.example.com',
  refreshPath: '/api/admin/common/auth/refresh',
  getTokens: () => tokens,
  setTokens: (next) => storage.write(next),
  onLogout: () => storage.clear(),
});
const normalized: DddNormalizedError = { status: 400, message: getErrorMessage('x'), validationErrors: null, details: [], body: null };
const config: SdkConfig = defineConfig({ apis: [{ schemaFile: './spec.json', apiFile: './baseApi.ts', outputFile: './api.ts' }] });
const options: GenerateSdkOptions = { config, skipTsc: true };
const entity: DddEntityInfo = { schema: 'App.Domain.Library.Entities.Books.Book', action: 'get', derived: true };
const operator: FilterOperator = 'in';
const params: QueryOptionsParams = buildQueryOptions({ filters: combineFilters(buildInFilter('id', [1, 2])) });
const write: boolean = hasSideEffects('POST');
const expired: boolean = isExpired(null);
const version: string = manifest.version;

export const used = [baseQuery, normalized, options, entity, operator, params, write, expired, parseDddDateTime('2026-01-01'), version];
