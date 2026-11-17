import { describe, expect, it } from 'vitest';
import {
  createIssuesReporter,
  DDD_ISSUES_SERVER_TOKEN_HEADER,
  uiBreadcrumb,
  utf8ByteLength,
  type IssuesReporterOptions,
} from '../../src/issues';
import { createFakeIssuesClock, createRecordingTransport, eventsOf, settle } from './helpers';

const ENDPOINT = 'https://api.example.com/api/public/common/issues/report';

const errorAt = (message: string, file = 'https://app.example.com/assets/index.js') =>
  Object.assign(new Error(message), { stack: `Error: ${message}\n    at render (${file}:1:2)` });

const makeReporter = (
  overrides: Partial<IssuesReporterOptions> & { statuses?: (number | 'network-error')[] } = {},
) => {
  const fakeClock = createFakeIssuesClock();
  const recording = createRecordingTransport(overrides.statuses);
  const reporter = createIssuesReporter({
    runtime: 'browser',
    app: 'web',
    endpoint: () => ENDPOINT,
    transport: recording.transport,
    clock: fakeClock.clock,
    ...overrides,
  });
  return { reporter, ...fakeClock, ...recording };
};

describe('issues reporter', () => {
  it('batches after the flush delay and sends the DDD body with context', async () => {
    const { reporter, advance, sent } = makeReporter({ context: () => ({ release: 'r1', tabId: 't1', locale: 'en' }) });
    reporter.setRoute('/books/[bookId]', 'https://app.example.com/books/1?token=abc');
    reporter.captureError(errorAt('first'), 'error', { tags: { feature: 'books', empty: null } });
    reporter.captureError(errorAt('second'), 'unhandledrejection');
    await advance(1_999);
    expect(sent).toHaveLength(0);
    await advance(1);
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.request).toMatchObject({ url: ENDPOINT, keepalive: true, unloading: false });
    expect(request?.request.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' });
    expect(request?.body.report.client).toEqual({
      runtime: 'browser',
      app: 'web',
      release: 'r1',
      tabId: 't1',
      userAgent: null,
      viewportWidth: null,
      viewportHeight: null,
      locale: 'en',
    });
    const events = eventsOf(request);
    expect(events.map((event) => [event.kind, event.message])).toEqual([
      ['error', 'first'],
      ['unhandledrejection', 'second'],
    ]);
    expect(events[0]).toMatchObject({
      level: 'error',
      url: 'https://app.example.com/books/1?token=[redacted]',
      routePattern: '/books/[bookId]',
      count: 1,
      tags: { elements: [{ key: 'feature', value: 'books' }] },
    });
  });

  it('flushes at once at five queued events and folds repeats into count', async () => {
    const { reporter, sent } = makeReporter();
    reporter.captureError(errorAt('order 41 failed'));
    reporter.captureError(errorAt('order 42 failed'));
    for (let index = 0; index < 4; index++) reporter.captureError(errorAt(`distinct ${'x'.repeat(index + 1)}`));
    await settle();
    expect(sent).toHaveLength(1);
    expect(eventsOf(sent[0])[0]).toMatchObject({ message: 'order 41 failed', count: 2, kind: 'manual' });
  });

  it('redacts the message and drops filtered noise and automated runs', async () => {
    let isAutomated = false;
    const { reporter, advance, sent } = makeReporter({ isAutomated: () => isAutomated });
    reporter.captureError(new Error('ResizeObserver loop limit exceeded'));
    reporter.captureError(new Error('failed for ana@example.com'));
    isAutomated = true;
    reporter.captureError(new Error('real but automated'));
    await advance(2_000);
    expect(eventsOf(sent[0]).map((event) => event.message)).toEqual(['failed for [email]']);
  });

  it('caps per fingerprint and per session in session mode', async () => {
    const { reporter, advance, sent } = makeReporter({ limits: { flushAtEvents: 100 } });
    for (let round = 0; round < 5; round++) {
      reporter.captureError(errorAt('same bug'));
      await advance(2_000);
    }
    expect(sent).toHaveLength(3);
    for (let index = 0; index < 40; index++) reporter.captureError(errorAt(`bug ${'y'.repeat(index + 1)}`));
    await advance(10_000);
    const sentEvents = sent.flatMap((request) => eventsOf(request));
    expect(sentEvents).toHaveLength(25);
  });

  it('retries once after a 5xx and never after a 4xx; stops after three failed sends in session mode', async () => {
    const retrying = makeReporter({ statuses: [503, 200] });
    retrying.reporter.captureError(errorAt('a'));
    await retrying.advance(2_000);
    expect(retrying.sent).toHaveLength(1);
    await retrying.advance(10_000);
    expect(retrying.sent).toHaveLength(2);
    expect(eventsOf(retrying.sent[1])[0]?.message).toBe('a');

    const rejected = makeReporter({ statuses: [400] });
    rejected.reporter.captureError(errorAt('b'));
    await rejected.advance(60_000);
    expect(rejected.sent).toHaveLength(1);

    const failing = makeReporter({ statuses: ['network-error'] });
    failing.reporter.captureError(errorAt('c'));
    await failing.advance(2_000);
    await failing.advance(10_000);
    failing.reporter.captureError(errorAt('d'));
    await failing.advance(2_000);
    expect(failing.sent).toHaveLength(3);
    failing.reporter.captureError(errorAt('e'));
    await failing.advance(60_000);
    expect(failing.sent).toHaveLength(3);
    expect(failing.reporter.getQueuedEventCount()).toBe(0);
  });

  it('uses windowed caps and backoff for node, without breadcrumbs or keepalive', async () => {
    const { reporter, advance, sent } = makeReporter({ runtime: 'node', statuses: [200] });
    reporter.addBreadcrumb(uiBreadcrumb('2026-01-01T00:00:00.000Z', 'x'));
    for (let round = 0; round < 5; round++) {
      reporter.captureError(errorAt('server bug'));
      await advance(2_000);
    }
    expect(sent).toHaveLength(3);
    expect(sent[0]?.request.keepalive).toBe(false);
    expect(eventsOf(sent[0])[0]?.breadcrumbs.elements).toEqual([]);
    await advance(5 * 60_000);
    reporter.captureError(errorAt('server bug'));
    await advance(2_000);
    expect(sent).toHaveLength(4);
  });

  it('backs off exponentially in windowed mode instead of stopping', async () => {
    const { reporter, advance, sent } = makeReporter({ runtime: 'react-native', statuses: ['network-error', 'network-error', 200] });
    reporter.captureError(errorAt('offline'));
    await advance(2_000);
    expect(sent).toHaveLength(1);
    await advance(10_000);
    expect(sent).toHaveLength(2);
    reporter.captureError(errorAt('later'));
    await advance(2_000);
    expect(sent).toHaveLength(2);
    await advance(20_000);
    expect(sent).toHaveLength(3);
    expect(eventsOf(sent[2]).map((event) => event.message)).toEqual(['later']);
  });

  it('attaches breadcrumbs (redacted on add) for the browser and react-native', async () => {
    const { reporter, advance, sent } = makeReporter();
    reporter.addBreadcrumb({
      at: '2026-01-01T00:00:00.000Z',
      category: 'custom',
      message: 'mail ana@example.com',
      url: '/invitations/abc',
      from: null,
      to: null,
      status: null,
    });
    reporter.captureError(errorAt('with trail'));
    await advance(2_000);
    expect(eventsOf(sent[0])[0]?.breadcrumbs.elements).toEqual([
      { at: '2026-01-01T00:00:00.000Z', category: 'custom', message: 'mail [email]', url: '/invitations/[redacted]', from: null, to: null, status: null },
    ]);
  });

  it('sends the bearer and the server token, and goes anonymous when the reader throws', async () => {
    const { reporter, advance, sent } = makeReporter({
      runtime: 'node',
      serverToken: 'server-secret',
      getAuthorization: () => 'access-1',
    });
    reporter.captureError(errorAt('a'));
    await advance(2_000);
    expect(sent[0]?.request.headers).toMatchObject({ Authorization: 'Bearer access-1', [DDD_ISSUES_SERVER_TOKEN_HEADER]: 'server-secret' });
    reporter.setAuthorizationReader(() => {
      throw new Error('store not ready');
    });
    reporter.captureError(errorAt('b'));
    await advance(2_000);
    expect(sent[1]?.request.headers.Authorization).toBeUndefined();
  });

  it('sends nothing without an endpoint and never throws into the caller', async () => {
    const { reporter, advance, sent } = makeReporter({
      endpoint: () => null,
      context: () => {
        throw new Error('no context');
      },
      commonTags: () => {
        throw new Error('no tags');
      },
    });
    expect(() => reporter.captureError(errorAt('x'))).not.toThrow();
    await advance(2_000);
    expect(sent).toHaveLength(0);
    const throwing = makeReporter({
      transport: () => {
        throw new Error('sync throw');
      },
    });
    throwing.reporter.captureError(errorAt('y'));
    await expect(throwing.reporter.flush()).resolves.toBeUndefined();
  });

  it('shrinks an oversized event: breadcrumbs, then frames beyond 10, raw stack, message', async () => {
    const { reporter, advance, sent } = makeReporter({ limits: { eventBytes: 2_500 } });
    for (let index = 0; index < 20; index++) reporter.addBreadcrumb(uiBreadcrumb('2026-01-01T00:00:00.000Z', `click-${index}-${'z'.repeat(80)}`));
    const stack = ['Error: big', ...Array.from({ length: 30 }, (_, index) => `    at f${index} (https://app.example.com/assets/chunk-${index}.js:1:2)`)].join('\n');
    reporter.captureError(Object.assign(new Error('big'), { stack }));
    await advance(2_000);
    const [event] = eventsOf(sent[0]);
    expect(event?.breadcrumbs.elements).toEqual([]);
    expect(event?.frames.elements).toHaveLength(10);
    expect(utf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(2_500);
  });

  it('flushes everything on unload, only the first batch on keepalive', async () => {
    const { reporter, sent } = makeReporter({ limits: { flushAtEvents: 100, eventsPerRequest: 2 } });
    for (let index = 0; index < 5; index++) reporter.captureError(errorAt(`unload ${'u'.repeat(index + 1)}`));
    await reporter.flush({ unloading: true });
    await settle();
    expect(sent.map((request) => request.request.keepalive)).toEqual([true, false, false]);
    expect(sent.every((request) => request.request.unloading)).toBe(true);
    expect(sent.flatMap((request) => eventsOf(request))).toHaveLength(5);
  });

  it('counts UTF-8 bytes', () => {
    expect(utf8ByteLength('aé€😀')).toBe(1 + 2 + 3 + 4);
  });
});
