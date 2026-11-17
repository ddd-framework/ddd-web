/**
 * `@mgamadeus/ddd-web/issues` — the platform-free core of the client issues reporter: errors of a browser, a Node
 * server or a React Native app go to the client-errors endpoint of a mgamadeus/ddd backend
 * (`IssuesLogService::logClientIssue`, Core 3.10.0 or newer) and land in its issues log.
 *
 * No DOM, no framework, no Node-only API, and no global is read at import time: the module loads in a browser, in
 * Node and in React Native alike. The platform adapters are separate entries (`/issues/browser`, `/issues/node`); the
 * wire format is `/issues/wire`.
 */
export {
  consoleBreadcrumb,
  createBreadcrumbTrail,
  customBreadcrumb,
  fetchBreadcrumb,
  navigationBreadcrumb,
  sanitizeBreadcrumb,
  uiBreadcrumb,
  type BreadcrumbTrail,
} from './breadcrumbs';
export { findIssueDropRule, ISSUE_DROP_RULES, type IssueDropCandidate, type IssueDropRule } from './filters';
export { buildClientFingerprint, normaliseIssueMessage } from './fingerprint';
export {
  ISSUES_LIMITS,
  mergeIssuesLimits,
  type IssuesLimits,
  type IssuesLimitsOverrides,
  type IssuesSessionLimits,
  type IssuesWindowedLimits,
} from './limits';
export { isForeignFile, normalizeError, parseStack, truncate, type InAppFileTest, type NormalizedError } from './normalize';
export {
  createIssuesRedactor,
  DEFAULT_ISSUES_TOKEN_PATH_SEGMENTS,
  ISSUES_REDACTION_RULES,
  redactText,
  redactUrl,
  type IssuesRedactionRule,
  type IssuesRedactor,
  type IssuesRedactorOptions,
} from './redact';
export {
  createIssuesReporter,
  createPlatformIssuesClock,
  DDD_ISSUES_SERVER_TOKEN_HEADER,
  utf8ByteLength,
  type IssuesClock,
  type IssuesContextValues,
  type IssuesRateLimitMode,
  type IssuesReporter,
  type IssuesReporterOptions,
} from './reporter';
export {
  buildRoutePattern,
  createIssuesRouteTracker,
  type IssuesRouteParams,
  type IssuesRouteTarget,
  type IssuesRouteTracker,
} from './route-pattern';
export { createFetchIssuesTransport, type FetchIssuesTransportOptions, type IssuesFetchFunction } from './transport';
export type * from './types';
