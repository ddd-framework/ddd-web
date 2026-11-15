import { describe, expect, it } from 'vitest';
import { dddFetchApiRequestPlugin, type DddFetchApiRequestPluginContext } from '../../src/vite';

const QUERY_MODULE = '/app/node_modules/@reduxjs/toolkit/dist/query/rtk-query.modern.mjs';
const TOOLKIT_CODE = 'function fetchBaseQuery() { const request = new Request(url, config); }';

const makeContext = (modules: Record<string, string>): DddFetchApiRequestPluginContext => ({
  error(message: string): never {
    throw new Error(message);
  },
  getModuleIds: () => Object.keys(modules)[Symbol.iterator]() as IterableIterator<string>,
  getModuleInfo: (moduleId: string) => ({ code: modules[moduleId] ?? null }),
});

describe('dddFetchApiRequestPlugin', () => {
  it('prepends the binding to the toolkit query module on its first line and leaves other modules alone', () => {
    const plugin = dddFetchApiRequestPlugin();
    const context = makeContext({});
    const transformed = plugin.transform.call(context, TOOLKIT_CODE, `${QUERY_MODULE}?v=1`);
    expect(transformed?.code).toBe(`import { FetchApiRequest as Request } from "@mgamadeus/ddd-web/fetch-api-request";${TOOLKIT_CODE}`);
    expect(plugin.transform.call(context, TOOLKIT_CODE, '/app/src/main.ts')).toBeNull();
  });

  it('fails the build when the toolkit no longer constructs a Request', () => {
    const plugin = dddFetchApiRequestPlugin();
    expect(() => plugin.transform.call(makeContext({}), 'export {}', QUERY_MODULE)).toThrow(/constructs no Request/);
  });

  it('checks the built modules at the end: a bound module passes, an unbound one fails', () => {
    const plugin = dddFetchApiRequestPlugin();
    const bound = plugin.transform.call(makeContext({}), TOOLKIT_CODE, QUERY_MODULE)?.code as string;
    expect(() => plugin.buildEnd.call(makeContext({ [QUERY_MODULE]: bound }))).not.toThrow();
    expect(() => plugin.buildEnd.call(makeContext({ [QUERY_MODULE]: TOOLKIT_CODE }))).toThrow(/not bound/);
    expect(() => plugin.buildEnd.call(makeContext({ '/app/src/main.ts': 'x' }))).not.toThrow();
  });
});
