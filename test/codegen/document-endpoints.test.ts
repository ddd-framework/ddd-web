import { afterEach, describe, expect, it } from 'vitest';
import { buildEndpointNameFromPath, generateSdk, silentLogger } from '../../src/codegen/index';
import { apiEntry, createApp, read, readSample, removeApp, writeSpec } from './helpers';

const apps: string[] = [];
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

describe('buildEndpointNameFromPath (endpoints.naming: path)', () => {
  it.each([
    ['post', '/app/api/client/ai/conversations/{locationId}/purposed/{purposeName}', 'postClientAiConversationsPurposedByPurposeNameByLocationId'],
    ['get', '/app/api/client/ai/conversations/{aiConversationId}/messages/{messageId}/sent-payload', 'getClientAiConversationsMessagesSentPayloadByMessageId'],
    ['get', '/app/api/client/ai/conversations/{locationId}/list', 'getClientAiConversationsListByLocationId'],
    ['post', '/app/api/client/ai/conversations/{aiConversationId}/postMessage', 'postClientAiConversationsPostMessageByAiConversationId'],
    ['get', '/api/client/a2a/agent-card.json', 'getClientA2aAgentCardJson'],
    ['delete', '/api/admin/library/books/{bookId}', 'deleteAdminLibraryBooksByBookId'],
  ])('%s %s → %s', (method, path, name) => {
    expect(buildEndpointNameFromPath(method, path)).toBe(name);
  });
});

describe('generateSdk — endpoints option', () => {
  it('names endpoints by the path rule and sends the body as requestBody', async () => {
    const app = createApp();
    apps.push(app);
    await generateSdk({
      cwd: app,
      config: { apis: [apiEntry(writeSpec(app, readSample()))], endpoints: { naming: 'path', bodyArg: 'requestBody' } },
      logger: silentLogger,
    });
    const api = read(app, 'src/api/adminApi.ts');
    expect(api).toMatch(/getAdminLibraryBooksListBy|getAdminLibraryBooksList:/);
    expect(api).toContain('deleteAdminLibraryBooksByBookId:');
    expect(api).toContain('body: queryArg.requestBody');
    expect(api).not.toMatch(/queryArg\.bookUpdateRequestDto/);
    const argType = read(app, 'src/models/_endpoints/PatchAdminLibraryBooksApiArg.ts');
    expect(argType).toMatch(/requestBody: BookUpdateRequestDto;/);
    expect(read(app, 'src/api/adminApiEnhanced.ts')).toContain('deleteAdminLibraryBooksByBookId');
  }, 60_000);

  it('keeps the built names verbatim (no second camel-casing) and your filters match them', async () => {
    const app = createApp();
    apps.push(app);
    const doc = readSample();
    doc.paths!['/api/admin/library/books/importFromLegacyDB'] = { post: { responses: { '200': { description: 'ok' } } } };
    doc.paths!['/api/admin/a2a/agent-card.json'] = { get: { responses: { '200': { description: 'ok' } } } };
    await generateSdk({
      cwd: app,
      config: {
        apis: [apiEntry(writeSpec(app, doc), { filterEndpoints: (name: string) => name !== 'deleteAdminLibraryBooksByBookId' })],
        endpoints: { naming: 'path' },
      },
      logger: silentLogger,
    });
    const api = read(app, 'src/api/adminApi.ts');
    expect(api).toContain('postAdminLibraryBooksImportFromLegacyDB:');
    expect(api).toContain('getAdminA2aAgentCardJson:');
    expect(api).toContain('usePostAdminLibraryBooksImportFromLegacyDBMutation');
    expect(api).not.toContain('dddEndpoint');
    expect(api).not.toContain('deleteAdminLibraryBooksByBookId:');
  }, 60_000);

  it('moves every request builder into <stem>Requests.ts and lets the endpoints use it', async () => {
    const app = createApp();
    apps.push(app);
    await generateSdk({
      cwd: app,
      config: { apis: [apiEntry(writeSpec(app, readSample()))], endpoints: { naming: 'path', bodyArg: 'requestBody', requestBuilders: true } },
      logger: silentLogger,
    });
    const requests = read(app, 'src/api/adminApiRequests.ts').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/, \)/g, ')');
    expect(requests).toContain('export const adminApiRequests = {');
    expect(requests).toMatch(/getAdminLibraryBooksList: \(queryArg: GetAdminLibraryBooksListApiArg\): string \| FetchArgs => \(\{ url: `\/api\/admin\/library\/books\/list`/);
    expect(requests).toMatch(/import type \{ FetchArgs \} from ["']@reduxjs\/toolkit\/query["']/);
    expect(requests).toContain('body: queryArg.requestBody');
    expect(requests).toMatch(/import \{[^}]*blobResponseHandler[^}]*\} from ["']@mgamadeus\/ddd-web\/api["']/);
    expect(requests).not.toContain('injectEndpoints');
    expect(requests).not.toContain('./baseApi');
    const api = read(app, 'src/api/adminApi.ts').replace(/\s+/g, ' ');
    expect(api).toContain('query: adminApiRequests.getAdminLibraryBooksList');
    expect(api).toMatch(/import \{ adminApiRequests \} from ["']\.\/adminApiRequests["']/);
    expect(api).not.toContain('blobResponseHandler');
    expect(api).not.toContain('queryArg.');
  }, 60_000);

  it('refuses two operations with the same name', async () => {
    const app = createApp();
    apps.push(app);
    const doc = readSample();
    doc.paths!['/api/admin/library/{shelfId}/books/{bookId}/notes'] = { get: { responses: { '200': { description: 'ok' } } } };
    doc.paths!['/api/admin/library/{roomId}/books/{bookId}/notes'] = { get: { responses: { '200': { description: 'ok' } } } };
    await expect(
      generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))], endpoints: { naming: 'path' } }, logger: silentLogger }),
    ).rejects.toThrow(/are both named "getAdminLibraryBooksNotesByBookId"/);
  });
});
