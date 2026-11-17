/**
 * Client-side redaction of everything a report carries as free text: the page URL, breadcrumb URLs and messages, the
 * error message, the raw stack and tag values. The backend redacts again (mgamadeus/ddd `IssuesLogRedactor` and the
 * client rules of `logClientIssue`); this pass keeps credentials from leaving the device at all.
 */

/** One rule by value, applied to text and URLs alike. */
export interface IssuesRedactionRule {
  pattern: RegExp;
  replacement: string;
}

export interface IssuesRedactor {
  /** For a URL (page, request, navigation from / to). */
  redactUrl: (url: string) => string;
  /** For free text (error message, breadcrumb message); URLs inside it get the token rules too. */
  redactText: (text: string) => string;
}

export interface IssuesRedactorOptions {
  /**
   * Path segments whose NEXT segment is the credential (an invitation, a password reset):
   * `/invitations/abc` → `/invitations/[redacted]`. A segment may contain `/` (`r/confirm`). Default
   * {@link DEFAULT_ISSUES_TOKEN_PATH_SEGMENTS}, the backend's default `redactPathSegments`.
   */
  tokenPathSegments?: readonly string[];
  /** Applied after the built-in rules, e.g. a national phone-number format. */
  additionalRules?: readonly IssuesRedactionRule[];
}

/** The backend's default `redactPathSegments` (`Common.Issues`). */
export const DEFAULT_ISSUES_TOKEN_PATH_SEGMENTS: readonly string[] = Object.freeze([
  'invitations',
  'claim-account',
  'verify-email',
  'reset-password',
]);

/** Any query parameter whose name contains `token`. */
const TOKEN_QUERY_PARAMETER = /([?&][^=&#]*token[^=&#]*)=[^&#]*/gi;

/** Rules by value. Order matters: a bearer and a JWT go before the generic rules. */
export const ISSUES_REDACTION_RULES: readonly IssuesRedactionRule[] = Object.freeze([
  // An Authorization header value copied into a message.
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [redacted]' },
  // A JWT anywhere (access tokens, custom tokens of an identity provider).
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, replacement: '[jwt]' },
  // E-mail addresses.
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replacement: '[email]' },
  // UUIDs: a public link's id is often its credential (`/api/public/bookings/<uuid>/cancel`).
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '[uuid]' },
  // International phone numbers (+44 20 7946 0958).
  { pattern: /\+\d[\d\s().-]{6,}\d/g, replacement: '[phone]' },
]);

/** Path segments that are long hex ids (signed links, opaque tokens); ids of 15 hex digits or fewer stay. */
const LONG_HEX_PATH_SEGMENT = /\/[0-9a-f]{16,}(?=[/?#]|$)/gi;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const createIssuesRedactor = (options: IssuesRedactorOptions = {}): IssuesRedactor => {
  const tokenPathSegments = (options.tokenPathSegments ?? DEFAULT_ISSUES_TOKEN_PATH_SEGMENTS)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment !== '');
  const tokenRouteSegment =
    tokenPathSegments.length > 0
      ? new RegExp(`/(${tokenPathSegments.map(escapeRegExp).join('|')})/[^/?#]+`, 'g')
      : null;
  const valueRules = [...ISSUES_REDACTION_RULES, ...(options.additionalRules ?? [])];

  const redactTokens = (value: string): string => {
    const withoutTokenSegments = tokenRouteSegment ? value.replace(tokenRouteSegment, '/$1/[redacted]') : value;
    return withoutTokenSegments.replace(TOKEN_QUERY_PARAMETER, '$1=[redacted]');
  };
  const applyValueRules = (value: string): string =>
    valueRules.reduce((redacted, rule) => redacted.replace(rule.pattern, rule.replacement), value);

  return {
    redactUrl: (url) => applyValueRules(redactTokens(url)).replace(LONG_HEX_PATH_SEGMENT, '/[id]'),
    redactText: (text) => applyValueRules(redactTokens(text)),
  };
};

const defaultIssuesRedactor = createIssuesRedactor();

/** {@link IssuesRedactor.redactUrl} with the default rules. */
export const redactUrl = (url: string): string => defaultIssuesRedactor.redactUrl(url);

/** {@link IssuesRedactor.redactText} with the default rules. */
export const redactText = (text: string): string => defaultIssuesRedactor.redactText(text);
