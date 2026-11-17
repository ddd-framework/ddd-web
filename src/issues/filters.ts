import type { CapturedFrame } from './types';

/**
 * What the client never reports: noise that is not a failure of the app, or not actionable per event. The backend
 * drops the chunk-load, `Script error.` and `ResizeObserver loop` patterns again (`clientIgnorePatterns`); dropping
 * here saves the request.
 */

export interface IssueDropCandidate {
  name: string;
  message: string;
  frames: readonly CapturedFrame[];
  /** The page runs under automation (Playwright / WebDriver: `navigator.webdriver`) */
  automated: boolean;
}

export interface IssueDropRule {
  id: string;
  matches: (candidate: IssueDropCandidate) => boolean;
}

const messageMatches =
  (pattern: RegExp) =>
  (candidate: IssueDropCandidate): boolean =>
    pattern.test(candidate.message) || pattern.test(candidate.name);

export const ISSUE_DROP_RULES: readonly IssueDropRule[] = Object.freeze([
  // A tab opened before a deploy asks for chunks the new deploy no longer has.
  { id: 'chunk-load', matches: (candidate: IssueDropCandidate) => candidate.name === 'ChunkLoadError' },
  { id: 'chunk-load', matches: messageMatches(/Loading (CSS )?chunk [\w-]+ failed/) },
  { id: 'chunk-load', matches: messageMatches(/Failed to fetch dynamically imported module/) },
  { id: 'chunk-load', matches: messageMatches(/Importing a module script failed/) },
  // Browser noise: the observer could not deliver every notification in one frame.
  { id: 'resize-observer', matches: messageMatches(/ResizeObserver loop/) },
  // An error in a cross-origin script: the browser hides everything, nothing to act on.
  { id: 'opaque-script-error', matches: (candidate: IssueDropCandidate) => /^Script error\.?$/.test(candidate.message.trim()) },
  // Thrown by a browser extension injected into the page.
  {
    id: 'extension',
    matches: (candidate: IssueDropCandidate) =>
      /^(chrome-extension|moz-extension|safari-(web-)?extension):/.test(candidate.frames[0]?.file ?? ''),
  },
  // Wallet extensions and in-app wallet browsers touch `window.ethereum` on every page.
  { id: 'wallet-extension', matches: messageMatches(/\bwindow\.ethereum\b/) },
  // A request the app cancelled itself (navigation, unmount, an aborted query).
  { id: 'aborted', matches: (candidate: IssueDropCandidate) => candidate.name === 'AbortError' },
  // End-to-end runs under automation stay silent.
  { id: 'automated-browser', matches: (candidate: IssueDropCandidate) => candidate.automated },
]);

/** The id of the first rule that drops the candidate, or null when it is reported. */
export const findIssueDropRule = (
  candidate: IssueDropCandidate,
  rules: readonly IssueDropRule[] = ISSUE_DROP_RULES,
): string | null => rules.find((rule) => rule.matches(candidate))?.id ?? null;
