// Installed-package type test: imports every public subpath and uses a few exports with their declared types.
// Compiled against the packed tarball with `moduleResolution: bundler` and `nodenext` (see run.sh).
import { createDddBaseQuery, getErrorMessage, type DddBaseQuery, type DddNormalizedError } from '@mgamadeus/ddd-web/api';
import { createMemoryTokenStorage, isExpired, type DddTokens, type TokenStorage } from '@mgamadeus/ddd-web/auth';
import { defineConfig, type GenerateSdkOptions, type SdkConfig } from '@mgamadeus/ddd-web/codegen';
import { FetchApiRequest, isFetchApiRequest } from '@mgamadeus/ddd-web/fetch-api-request';
import { dddFetchApiRequestPlugin, type DddFetchApiRequestPlugin } from '@mgamadeus/ddd-web/vite';
import { hasSideEffects, parseDddDateTime, type DddEntityInfo, type FilterOperator } from '@mgamadeus/ddd-web/contract';
import { buildInFilter, buildQueryOptions, combineFilters, type QueryOptionsParams } from '@mgamadeus/ddd-web/query';
import { createIssuesReporter, createIssuesRouteTracker, type IssuesReporter, type IssuesTransport } from '@mgamadeus/ddd-web/issues';
import { captureRenderError, createBrowserIssuesReporter, installBrowserIssueCapture } from '@mgamadeus/ddd-web/issues/browser';
import { createNodeIssuesReporter, createServerRequestErrorHandler } from '@mgamadeus/ddd-web/issues/node';
import { DDD_ISSUES_REPORT_PATH, dddIssuesWireAdapter, type DddClientIssueIngestResult } from '@mgamadeus/ddd-web/issues/wire';
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

const fetchApiRequestPlugin: DddFetchApiRequestPlugin = dddFetchApiRequestPlugin();
const fetchApiRequestIsGenuine: boolean = isFetchApiRequest(new FetchApiRequest('https://api.test/x'));
void fetchApiRequestPlugin;
void fetchApiRequestIsGenuine;

const issuesTransport: IssuesTransport = async () => ({ status: 200 });
const mobileIssuesReporter: IssuesReporter = createIssuesReporter({
  runtime: 'react-native',
  app: 'mobile',
  endpoint: () => `https://api.example.com${DDD_ISSUES_REPORT_PATH}`,
  transport: issuesTransport,
  wire: dddIssuesWireAdapter,
});
createIssuesRouteTracker(mobileIssuesReporter).trackRoute('/books/1', { bookId: '1' });
const browserIssuesReporter: IssuesReporter | null = createBrowserIssuesReporter({ app: 'web', release: () => 'web-1' });
if (browserIssuesReporter) installBrowserIssueCapture(browserIssuesReporter);
captureRenderError(browserIssuesReporter, new Error('render'));
const serverIssuesReporter: IssuesReporter = createNodeIssuesReporter({ app: 'web', apiBaseUrl: 'https://api.example.com', serverToken: 's' });
const onRequestError = createServerRequestErrorHandler(() => serverIssuesReporter);
const ingestResult: DddClientIssueIngestResult = { accepted: 1, dropped: 0, dropReasons: [] };
void onRequestError;
void ingestResult;
