import { describe, expect, it } from 'vitest';
import { ISSUES_LIMITS, mergeIssuesLimits } from '../../src/issues';

describe('issues limits', () => {
  it('match the backend caps of the client-errors contract', () => {
    expect(ISSUES_LIMITS).toMatchObject({
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
      tagsPerEvent: 10,
      tagLength: 64,
      requestMethodLength: 16,
      clientFingerprintLength: 128,
      eventsPerRequest: 10,
    });
    expect(ISSUES_LIMITS.requestBytes).toBeLessThan(64 * 1024);
  });

  it('are frozen and merge overrides field by field', () => {
    expect(Object.isFrozen(ISSUES_LIMITS)).toBe(true);
    expect(Object.isFrozen(ISSUES_LIMITS.session)).toBe(true);
    const merged = mergeIssuesLimits({ flushDelayMs: 50, session: { eventsPerSession: 5 }, windowed: { eventsPerMinute: 1 } });
    expect(merged.flushDelayMs).toBe(50);
    expect(merged.session).toEqual({ ...ISSUES_LIMITS.session, eventsPerSession: 5 });
    expect(merged.windowed).toEqual({ ...ISSUES_LIMITS.windowed, eventsPerMinute: 1 });
    expect(mergeIssuesLimits()).toEqual(ISSUES_LIMITS);
  });
});
