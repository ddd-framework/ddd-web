/**
 * Every limit of the issues reporter in one place. The backend enforces its own caps again (mgamadeus/ddd
 * `ClientIssueReportNormalizer`); these keep a broken page from flooding the endpoint and keep requests small. The field
 * caps equal the backend's.
 */

/** Caps of a reporter that lives for one page session: per session, a hard stop after repeated failed sends. */
export interface IssuesSessionLimits {
  sendsPerFingerprint: number;
  eventsPerSession: number;
  failedSendsBeforeStop: number;
}

/** Caps of a long-lived reporter (a server, a mobile app): windows and an exponential backoff instead of a stop. */
export interface IssuesWindowedLimits {
  sendsPerFingerprintPerWindow: number;
  fingerprintWindowMs: number;
  eventsPerMinute: number;
  backoffStartMs: number;
  backoffMaxMs: number;
}

export interface IssuesLimits {
  /** Field caps per event (characters) */
  nameLength: number;
  messageLength: number;
  framesPerEvent: number;
  fileLength: number;
  functionLength: number;
  rawStackLength: number;
  urlLength: number;
  routePatternLength: number;
  breadcrumbsPerEvent: number;
  breadcrumbMessageLength: number;
  breadcrumbUrlLength: number;
  tagsPerEvent: number;
  tagLength: number;
  requestMethodLength: number;
  clientFingerprintLength: number;
  /** Batching */
  flushDelayMs: number;
  flushAtEvents: number;
  /** The backend drops every event beyond 10 per request (`too-many-events`). */
  eventsPerRequest: number;
  /** Serialized UTF-8 per request; under the browser's 64 KiB keepalive budget */
  requestBytes: number;
  /** Serialized UTF-8 per event, before it is queued (the backend's file sink takes 16 KB per client event) */
  eventBytes: number;
  /** One retry on a network error or a 5xx, never on a 4xx */
  retryDelayMs: number;
  /** Events waiting to be sent; the oldest go first beyond it (a backend that is down for long) */
  queuedEvents: number;
  session: IssuesSessionLimits;
  windowed: IssuesWindowedLimits;
}

export type IssuesLimitsOverrides = Partial<Omit<IssuesLimits, 'session' | 'windowed'>> & {
  session?: Partial<IssuesSessionLimits>;
  windowed?: Partial<IssuesWindowedLimits>;
};

export const ISSUES_LIMITS: Readonly<IssuesLimits> = Object.freeze({
  nameLength: 128,
  messageLength: 1024,
  framesPerEvent: 30,
  fileLength: 512,
  functionLength: 128,
  rawStackLength: 4096,
  urlLength: 1024,
  routePatternLength: 256,
  breadcrumbsPerEvent: 20,
  breadcrumbMessageLength: 256,
  breadcrumbUrlLength: 1024,
  tagsPerEvent: 10,
  tagLength: 64,
  requestMethodLength: 16,
  clientFingerprintLength: 128,

  flushDelayMs: 2_000,
  flushAtEvents: 5,
  eventsPerRequest: 10,
  requestBytes: 48 * 1024,
  eventBytes: 16 * 1024,
  retryDelayMs: 10_000,
  queuedEvents: 50,

  session: Object.freeze({
    sendsPerFingerprint: 3,
    eventsPerSession: 25,
    failedSendsBeforeStop: 3,
  }),

  windowed: Object.freeze({
    sendsPerFingerprintPerWindow: 3,
    fingerprintWindowMs: 5 * 60_000,
    eventsPerMinute: 60,
    backoffStartMs: 10_000,
    backoffMaxMs: 5 * 60_000,
  }),
});

/** The default limits with the given ones on top (the nested `session` / `windowed` caps merged field by field). */
export const mergeIssuesLimits = (overrides: IssuesLimitsOverrides = {}): IssuesLimits => ({
  ...ISSUES_LIMITS,
  ...overrides,
  session: { ...ISSUES_LIMITS.session, ...overrides.session },
  windowed: { ...ISSUES_LIMITS.windowed, ...overrides.windowed },
});
