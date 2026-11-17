import type { IssuesClock, IssuesTransportRequest } from '../../src/issues';
import type { DddClientIssuesReportRequestBody } from '../../src/issues/wire';

/** A clock whose time and timers move only when the test advances it. */
export const createFakeIssuesClock = (startMs = Date.UTC(2026, 0, 1)) => {
  let currentMs = startMs;
  let nextHandle = 1;
  const timers = new Map<number, { dueMs: number; callback: () => void }>();
  const clock: IssuesClock = {
    now: () => currentMs,
    setTimeout: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { dueMs: currentMs + delayMs, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = async (milliseconds: number) => {
    const targetMs = currentMs + milliseconds;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.dueMs <= targetMs).sort((a, b) => a[1].dueMs - b[1].dueMs)[0];
      if (!due) break;
      timers.delete(due[0]);
      currentMs = due[1].dueMs;
      due[1].callback();
      await settle();
    }
    currentMs = targetMs;
    await settle();
  };
  return { clock, advance, pendingTimerCount: () => timers.size };
};

/** Lets queued promise callbacks run. */
export const settle = async () => {
  for (let round = 0; round < 10; round++) await Promise.resolve();
};

export interface SentIssuesRequest {
  request: IssuesTransportRequest;
  body: DddClientIssuesReportRequestBody;
}

/** A transport that records every request and answers with the given statuses in turn (the last one repeats). */
export const createRecordingTransport = (statuses: (number | 'network-error')[] = [200]) => {
  const sent: SentIssuesRequest[] = [];
  let call = 0;
  const transport = async (request: IssuesTransportRequest) => {
    sent.push({ request, body: JSON.parse(request.body) as DddClientIssuesReportRequestBody });
    const outcome = statuses[Math.min(call, statuses.length - 1)] ?? 200;
    call++;
    if (outcome === 'network-error') throw new TypeError('Failed to fetch');
    return { status: outcome };
  };
  return { transport, sent };
};

export const eventsOf = (sentRequest: SentIssuesRequest | undefined) => sentRequest?.body.report.events.elements ?? [];
