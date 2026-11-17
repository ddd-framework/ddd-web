import { ISSUES_LIMITS } from './limits';
import { truncate } from './normalize';
import { type IssuesRedactor, redactText, redactUrl } from './redact';
import type { BreadcrumbCategory, CapturedBreadcrumb } from './types';

/**
 * What happened before an error, newest last. Builders only: every string is capped and redacted here, so a caller
 * cannot add an unredacted URL (the reporter applies its own redactor again on add). Never bodies, never input values,
 * never the visible text of a clicked element.
 */

export interface BreadcrumbTrail {
  add: (breadcrumb: CapturedBreadcrumb) => void;
  /** A copy, oldest first */
  snapshot: () => CapturedBreadcrumb[];
}

/** Keeps the newest `limit` breadcrumbs. */
export const createBreadcrumbTrail = (limit: number = ISSUES_LIMITS.breadcrumbsPerEvent): BreadcrumbTrail => {
  const breadcrumbs: CapturedBreadcrumb[] = [];
  return {
    add: (breadcrumb) => {
      breadcrumbs.push(breadcrumb);
      while (breadcrumbs.length > limit) breadcrumbs.shift();
    },
    snapshot: () => breadcrumbs.slice(),
  };
};

const DEFAULT_BREADCRUMB_REDACTOR: IssuesRedactor = { redactUrl, redactText };

/** Caps and redacts every string of a breadcrumb. */
export const sanitizeBreadcrumb = (
  breadcrumb: CapturedBreadcrumb,
  redactor: IssuesRedactor = DEFAULT_BREADCRUMB_REDACTOR,
): CapturedBreadcrumb => {
  const sanitizeUrl = (url: string | null | undefined): string | null =>
    url ? truncate(redactor.redactUrl(url), ISSUES_LIMITS.breadcrumbUrlLength) : null;
  return {
    at: breadcrumb.at,
    category: breadcrumb.category,
    message: truncate(redactor.redactText(breadcrumb.message), ISSUES_LIMITS.breadcrumbMessageLength),
    url: sanitizeUrl(breadcrumb.url),
    from: sanitizeUrl(breadcrumb.from),
    to: sanitizeUrl(breadcrumb.to),
    status: typeof breadcrumb.status === 'number' ? breadcrumb.status : null,
  };
};

type BreadcrumbFields = Partial<Pick<CapturedBreadcrumb, 'url' | 'from' | 'to' | 'status'>>;

const buildBreadcrumb = (
  at: string,
  category: BreadcrumbCategory,
  message: string,
  fields: BreadcrumbFields = {},
): CapturedBreadcrumb =>
  sanitizeBreadcrumb({
    at,
    category,
    message,
    url: fields.url ?? null,
    from: fields.from ?? null,
    to: fields.to ?? null,
    status: fields.status ?? null,
  });

/** A route change; `from` / `to` are route patterns or paths. */
export const navigationBreadcrumb = (at: string, from: string | null, to: string): CapturedBreadcrumb =>
  buildBreadcrumb(at, 'navigation', `${from ?? '(start)'} → ${to}`, { from, to });

/** A failed request: status ≥ 400, or `network-error` when it never got an answer. */
export const fetchBreadcrumb = (
  at: string,
  method: string,
  url: string,
  outcome: number | 'network-error',
): CapturedBreadcrumb =>
  buildBreadcrumb(at, 'fetch', `${method.toUpperCase()} ${outcome}`, {
    url,
    status: outcome === 'network-error' ? null : outcome,
  });

/** `console.error`: its first argument only. */
export const consoleBreadcrumb = (at: string, message: string): CapturedBreadcrumb =>
  buildBreadcrumb(at, 'console', message);

/**
 * A click: the element's `data-issues-action` id, else its tag and role. Never its text or `aria-label`, which can
 * hold an e-mail or a name.
 */
export const uiBreadcrumb = (at: string, action: string): CapturedBreadcrumb => buildBreadcrumb(at, 'ui', action);

/** Anything else the app wants on the trail. */
export const customBreadcrumb = (at: string, message: string, fields: BreadcrumbFields = {}): CapturedBreadcrumb =>
  buildBreadcrumb(at, 'custom', message, fields);
