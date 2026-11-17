import { describe, expect, it } from 'vitest';
import { findIssueDropRule, ISSUE_DROP_RULES, type IssueDropCandidate } from '../../src/issues';

const candidate = (name: string, message: string, overrides: Partial<IssueDropCandidate> = {}): IssueDropCandidate => ({
  name,
  message,
  frames: [],
  automated: false,
  ...overrides,
});

describe('issues filters', () => {
  it.each([
    ['chunk-load', candidate('ChunkLoadError', 'x')],
    ['chunk-load', candidate('Error', 'Loading chunk 123 failed.')],
    ['chunk-load', candidate('Error', 'Loading CSS chunk app-main failed')],
    ['chunk-load', candidate('TypeError', 'Failed to fetch dynamically imported module: https://x.test/a.js')],
    ['chunk-load', candidate('TypeError', 'Importing a module script failed.')],
    ['resize-observer', candidate('Error', 'ResizeObserver loop completed with undelivered notifications.')],
    ['opaque-script-error', candidate('Error', 'Script error.')],
    ['opaque-script-error', candidate('Error', ' Script error ')],
    [
      'extension',
      candidate('TypeError', 'x', {
        frames: [{ file: 'safari-web-extension://abc/c.js', line: 1, column: 1, function: null, inApp: false }],
      }),
    ],
    ['wallet-extension', candidate('TypeError', 'window.ethereum.selectedAddress = undefined')],
    ['aborted', candidate('AbortError', 'The user aborted a request.')],
    ['automated-browser', candidate('TypeError', 'real bug', { automated: true })],
  ])('drops %s', (ruleId, dropCandidate) => {
    expect(findIssueDropRule(dropCandidate)).toBe(ruleId);
  });

  it('reports everything else', () => {
    expect(findIssueDropRule(candidate('TypeError', "Cannot read properties of undefined (reading 'id')"))).toBeNull();
    expect(findIssueDropRule(candidate('Error', 'Script error in module x'))).toBeNull();
  });

  it('takes the app own rule list', () => {
    const rules = [...ISSUE_DROP_RULES, { id: 'maintenance', matches: (c: IssueDropCandidate) => c.message.includes('maintenance') }];
    expect(findIssueDropRule(candidate('Error', 'in maintenance'), rules)).toBe('maintenance');
    expect(findIssueDropRule(candidate('ChunkLoadError', 'x'), [])).toBeNull();
  });
});
