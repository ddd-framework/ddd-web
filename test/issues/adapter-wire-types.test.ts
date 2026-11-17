import { describe, expect, expectTypeOf, it } from 'vitest';
import type { IssuesReporter, IssuesWireAdapter } from '../../src/issues';
import {
  createBrowserIssuesReporter,
  type BrowserIssuesReporterOptions,
} from '../../src/issues/browser';
import { createNodeIssuesReporter, type NodeIssuesReporterOptions } from '../../src/issues/node';
import type { DddClientIssueEvent, DddClientIssuesReportRequestBody } from '../../src/issues/wire';
import { createFakeIssuesClock } from './helpers';

/** Stand-ins for an app's generated models. */
interface AppIssueEvent {
  appMessage: string;
}
interface AppIssuesReportBody {
  appEvents: AppIssueEvent[];
}

const appWire: IssuesWireAdapter<AppIssueEvent, AppIssuesReportBody> = {
  toWireEvent: (event) => ({ appMessage: event.message }),
  toRequestBody: (_context, events) => ({ appEvents: events }),
};

describe('issues adapters: wire types', () => {
  it('default to the DDD wire types, so existing calls compile unchanged', () => {
    expectTypeOf<NodeIssuesReporterOptions['wire']>().toEqualTypeOf<
      IssuesWireAdapter<DddClientIssueEvent, DddClientIssuesReportRequestBody> | undefined
    >();
    expectTypeOf<BrowserIssuesReporterOptions['wire']>().toEqualTypeOf<
      IssuesWireAdapter<DddClientIssueEvent, DddClientIssuesReportRequestBody> | undefined
    >();
    const nodeReporter = createNodeIssuesReporter({ app: 'web', apiBaseUrl: null });
    expectTypeOf(nodeReporter).toEqualTypeOf<IssuesReporter>();
    expectTypeOf(createBrowserIssuesReporter({ app: 'web' })).toEqualTypeOf<IssuesReporter | null>();
  });

  it('follow a custom wire built from other types', async () => {
    expectTypeOf<NodeIssuesReporterOptions<AppIssueEvent, AppIssuesReportBody>['wire']>().toEqualTypeOf<
      IssuesWireAdapter<AppIssueEvent, AppIssuesReportBody> | undefined
    >();
    expectTypeOf<BrowserIssuesReporterOptions<AppIssueEvent, AppIssuesReportBody>['wire']>().toEqualTypeOf<
      IssuesWireAdapter<AppIssueEvent, AppIssuesReportBody> | undefined
    >();
    // Inferred from `wire`; the explicit form pins the types and rejects a wire of other types.
    createBrowserIssuesReporter({ app: 'web', wire: appWire });
    createBrowserIssuesReporter<AppIssueEvent, AppIssuesReportBody>({ app: 'web', wire: appWire });
    // @ts-expect-error a wire of the app's types is no DDD wire
    createNodeIssuesReporter<DddClientIssueEvent, DddClientIssuesReportRequestBody>({ app: 'web', wire: appWire });

    const sentBodies: unknown[] = [];
    const { clock, advance } = createFakeIssuesClock();
    const reporter = createNodeIssuesReporter({
      app: 'web',
      endpoint: 'https://api.example.com/report',
      wire: appWire,
      clock,
      transport: async (request) => {
        sentBodies.push(JSON.parse(request.body));
        return { status: 200 };
      },
    });
    expectTypeOf(reporter).toEqualTypeOf<IssuesReporter>();
    reporter.captureError(new Error('typed'));
    await advance(2_000);
    expect(sentBodies).toEqual([{ appEvents: [{ appMessage: 'typed' }] }]);
  });
});
