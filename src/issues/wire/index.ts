/**
 * `@mgamadeus/ddd-web/issues/wire` — the wire format of the client-errors endpoint of a mgamadeus/ddd backend
 * (`IssuesLogService::logClientIssue`, value objects `DDD\Domain\Common\Entities\Issues\Client\*`, Core 3.10.0 or
 * newer) and the adapter from the reporter's capture model to it.
 *
 * Collections go out as `{ elements: [...] }`, the shape the generated SDK models of a DDD `ObjectSet` have; the
 * backend hydrates that and a plain array alike. An app that wants its request body type-checked against its own
 * generated models passes its own {@link IssuesWireAdapter} instead.
 */
import type {
  BreadcrumbCategory,
  CapturedIssueContext,
  CapturedIssueEvent,
  IssueKind,
  IssueLevel,
  IssuesRuntime,
  IssuesWireAdapter,
} from '../types';

/** A DDD `ObjectSet` on the wire. */
export interface DddClientIssueSet<TElement> {
  elements: TElement[];
}

/** `ClientIssueFrame` */
export interface DddClientIssueFrame {
  file: string;
  line: number | null;
  column: number | null;
  function: string | null;
  inApp: boolean;
}

/** `ClientIssueBreadcrumb` */
export interface DddClientIssueBreadcrumb {
  at: string;
  category: BreadcrumbCategory;
  message: string;
  url: string | null;
  from: string | null;
  to: string | null;
  status: number | null;
}

/** `ClientIssueTag` */
export interface DddClientIssueTag {
  key: string;
  value: string;
}

/** `ClientIssueEvent` */
export interface DddClientIssueEvent {
  occurredAt: string;
  kind: IssueKind;
  level: IssueLevel;
  name: string;
  message: string;
  frames: DddClientIssueSet<DddClientIssueFrame>;
  rawStack: string | null;
  url: string | null;
  routePattern: string | null;
  requestMethod: string | null;
  httpStatus: number | null;
  breadcrumbs: DddClientIssueSet<DddClientIssueBreadcrumb>;
  tags: DddClientIssueSet<DddClientIssueTag>;
  count: number;
  clientFingerprint: string | null;
}

/** `ClientIssueContext` */
export interface DddClientIssueContext {
  runtime: IssuesRuntime;
  app: string | null;
  release: string | null;
  tabId: string | null;
  userAgent: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  locale: string | null;
}

/** `ClientIssueReport` */
export interface DddClientIssueReport {
  client: DddClientIssueContext;
  events: DddClientIssueSet<DddClientIssueEvent>;
}

/** The request body: the request DTO of the endpoint has one body property `report`. */
export interface DddClientIssuesReportRequestBody {
  report: DddClientIssueReport;
}

/** `ClientIssueIngestResult::DROP_REASON_*` */
export type DddClientIssueDropReason = 'ingest-disabled' | 'ignored-message' | 'ignored-user-agent' | 'too-many-events';

/** `ClientIssueIngestResult`, the endpoint's answer (200 also when the kill switch drops everything). */
export interface DddClientIssueIngestResult {
  accepted: number;
  dropped: number;
  dropReasons: DddClientIssueDropReason[];
}

/**
 * Path of the ingest endpoint below the API origin, as the issues-log guide of mgamadeus/ddd declares it
 * (`#[Post('/public/common/issues/report')]` under the application's `/api` prefix). The application owns the route;
 * pass another URL when it differs.
 */
export const DDD_ISSUES_REPORT_PATH = '/api/public/common/issues/report';

export const toDddClientIssueContext = (context: CapturedIssueContext): DddClientIssueContext => ({
  runtime: context.runtime,
  app: context.app,
  release: context.release,
  tabId: context.tabId,
  userAgent: context.userAgent,
  viewportWidth: context.viewportWidth,
  viewportHeight: context.viewportHeight,
  locale: context.locale,
});

export const toDddClientIssueEvent = (event: CapturedIssueEvent): DddClientIssueEvent => ({
  occurredAt: event.occurredAt,
  kind: event.kind,
  level: event.level,
  name: event.name,
  message: event.message,
  frames: {
    elements: event.frames.map((frame) => ({
      file: frame.file,
      line: frame.line,
      column: frame.column,
      function: frame.function,
      inApp: frame.inApp,
    })),
  },
  rawStack: event.rawStack,
  url: event.url,
  routePattern: event.routePattern,
  requestMethod: event.requestMethod,
  httpStatus: event.httpStatus,
  breadcrumbs: {
    elements: event.breadcrumbs.map((breadcrumb) => ({
      at: breadcrumb.at,
      category: breadcrumb.category,
      message: breadcrumb.message,
      url: breadcrumb.url,
      from: breadcrumb.from,
      to: breadcrumb.to,
      status: breadcrumb.status,
    })),
  },
  tags: { elements: event.tags.map((tag) => ({ key: tag.key, value: tag.value })) },
  count: event.count,
  clientFingerprint: event.clientFingerprint,
});

/** Captured values → `{ report: { client, events: { elements } } }`. */
export const dddIssuesWireAdapter: IssuesWireAdapter<DddClientIssueEvent, DddClientIssuesReportRequestBody> = {
  toWireEvent: toDddClientIssueEvent,
  toRequestBody: (context, events) => ({
    report: { client: toDddClientIssueContext(context), events: { elements: events } },
  }),
};
