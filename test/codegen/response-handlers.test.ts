import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateSdk, SdkGenerationError, silentLogger } from '../../src/codegen/index';
import type { OpenApiDocument } from '../../src/codegen/openapi';
import {
  detectResponseHandlerEndpoints,
  detectResponseKind,
  injectResponseHandlers,
  isFileContentType,
  isTextContentType,
} from '../../src/codegen/response-handlers';
import { apiEntry, createApp, read, readSample, removeApp, SAMPLE_SPEC, writeSpec } from './helpers';

const ok = (...types: string[]) => ({ 200: { content: Object.fromEntries(types.map((type) => [type, {}])) } });
const errorJson = { 400: { content: { 'application/json': {} } } };

describe('content-type detection', () => {
  it('classifies file types', () => {
    for (const type of [
      'application/octet-stream',
      'application/zip',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'APPLICATION/PDF; charset=binary',
      'text/csv',
      'image/png',
      'image/svg+xml',
    ]) {
      expect(isFileContentType(type), type).toBe(true);
    }
    for (const type of ['application/json', 'application/vnd.api+json', 'application/problem+json', 'image/x+json', 'text/html']) {
      expect(isFileContentType(type), type).toBe(false);
    }
    expect(isTextContentType('text/html; charset=utf-8')).toBe(true);
    expect(isTextContentType('application/json')).toBe(false);
  });

  it('derives the response kind from 2xx responses only', () => {
    expect(detectResponseKind({ ...ok('application/zip'), ...errorJson })).toBe('blob');
    expect(detectResponseKind({ ...ok('application/vnd.ms-excel', 'text/csv'), ...errorJson })).toBe('blob');
    expect(detectResponseKind({ ...ok('application/pdf', 'text/plain') })).toBe('blob');
    expect(detectResponseKind({ ...ok('text/html'), ...errorJson })).toBe('text');
    expect(detectResponseKind({ ...ok('application/json'), ...errorJson })).toBe('json');
    // mixed JSON and file: stays JSON (the content negotiation is the caller's business)
    expect(detectResponseKind({ ...ok('application/json', 'application/pdf') })).toBe('json');
    expect(detectResponseKind({ 400: { content: { 'application/pdf': {} } } })).toBe('json');
    expect(detectResponseKind({ 204: {} })).toBe('json');
    expect(detectResponseKind(undefined)).toBe('json');
  });
});

describe('response handler overrides', () => {
  const doc: OpenApiDocument = {
    openapi: '3.0.0',
    paths: {
      '/api/admin/reports/export': { get: { responses: ok('application/json') }, post: { responses: ok('application/json') } },
      '/api/admin/reports/archive': { get: { responses: ok('application/zip') } },
      '/api/admin/reports/preview': { get: { responses: ok('text/html') } },
    },
  } as OpenApiDocument;
  const endpoints = [
    { key: 'getExport', method: 'get', path: '/api/admin/reports/export' },
    { key: 'postExport', method: 'post', path: '/api/admin/reports/export' },
    { key: 'getArchive', method: 'get', path: '/api/admin/reports/archive' },
    { key: 'getPreview', method: 'get', path: '/api/admin/reports/preview' },
  ] as Parameters<typeof detectResponseHandlerEndpoints>[1];

  it('detects without overrides', () => {
    expect([...detectResponseHandlerEndpoints(doc, endpoints)]).toEqual([
      ['getArchive', 'blob'],
      ['getPreview', 'text'],
    ]);
  });

  it('lets overrides win over detection, first match first, method optional and case-insensitive', () => {
    const result = detectResponseHandlerEndpoints(doc, endpoints, [
      { method: 'GET', path: /\/export$/g, handler: 'blob' },
      { path: '/api/admin/reports/archive', handler: 'json' },
      { path: /\/reports\//, handler: 'text' },
    ]);
    expect(Object.fromEntries(result)).toEqual({ getExport: 'blob', postExport: 'text', getPreview: 'text' });
  });

  it('injects the handlers and the import only when a blob endpoint exists', () => {
    const source = [
      "import { api } from './baseApi';",
      'const injectedRtkApi = api.injectEndpoints({',
      '  endpoints: (build) => ({',
      '    getArchive: build.query<GetArchiveApiResponse, GetArchiveApiArg>({',
      '      query: (queryArg) => ({',
      '        url: `/api/admin/reports/archive`,',
      '        params: { noCache: queryArg.noCache },',
      '      }),',
      '    }),',
      '    getPreview: build.query<GetPreviewApiResponse, GetPreviewApiArg>({',
      '      query: () => ({ url: `/api/admin/reports/preview` }),',
      '    }),',
      '  }),',
      '});',
    ].join('\n');
    const out = injectResponseHandlers(source, new Map([['getArchive', 'blob'], ['getPreview', 'text']] as const));
    expect(out.startsWith("import { blobResponseHandler } from '@mgamadeus/ddd-web/api';\n")).toBe(true);
    expect(out).toContain('        responseHandler: blobResponseHandler,\n      }),');
    expect(out).toContain('({ url: `/api/admin/reports/preview`, responseHandler: "text" })');
    expect(injectResponseHandlers(source, new Map([['getPreview', 'text']] as const))).not.toContain('blobResponseHandler');
  });
});

describe('injection with wrapped endpoint names', () => {
  const longBlob = 'getApiAdminLibraryBooksByBookIdChaptersByChapterIdAttachmentsArchiveDownload';
  const longText = 'postApiAdminLibraryBooksByBookIdChaptersByChapterIdRenderedPreviewDocument';
  const wrapped = [
    "import { api } from './baseApi';",
    'const injectedRtkApi = api.injectEndpoints({',
    '  endpoints: (build) => ({',
    `    ${longBlob}: build.query<`,
    `      ${longBlob[0]!.toUpperCase()}${longBlob.slice(1)}ApiResponse,`,
    `      ${longBlob[0]!.toUpperCase()}${longBlob.slice(1)}ApiArg`,
    '    >({',
    '      query: (queryArg) => ({',
    '        url: `/api/admin/library/books/${queryArg.bookId}/chapters/${queryArg.chapterId}/attachments/archive`,',
    '        params: { noCache: queryArg.noCache }',
    '      }),',
    '    }),',
    `    ${longText}:`,
    '      build.mutation<',
    `        ${longText[0]!.toUpperCase()}${longText.slice(1)}ApiResponse,`,
    `        ${longText[0]!.toUpperCase()}${longText.slice(1)}ApiArg`,
    '      >({',
    '        query: (queryArg) => ({ url: `/api/admin/preview/${queryArg.bookId}`, method: "POST", }),',
    '      }),',
    '  }),',
    '});',
  ].join('\n');

  it('injects blob and text handlers regardless of line wrapping', () => {
    const out = injectResponseHandlers(wrapped, new Map([[longBlob, 'blob'], [longText, 'text']] as const));
    expect(out.startsWith("import { blobResponseHandler } from '@mgamadeus/ddd-web/api';\n")).toBe(true);
    expect(out).toContain('        params: { noCache: queryArg.noCache },\n        responseHandler: blobResponseHandler,\n      }),');
    expect(out).toContain('method: "POST", responseHandler: "text" })');
  });

  it('fails loudly, listing every endpoint whose handler could not be injected', () => {
    const broken = wrapped.replace('query: (queryArg) => ({ url', 'query: (queryArg) => buildRequest({ url');
    const attempt = () =>
      injectResponseHandlers(broken, new Map([[longBlob, 'blob'], [longText, 'text'], ['getMissingEndpoint', 'blob']] as const));
    expect(attempt).toThrow(SdkGenerationError);
    expect(attempt).toThrow(/2 endpoint\(s\)/);
    expect(attempt).toThrow(new RegExp(`${longText} \\(text\\): \`query\` does not return an object literal`));
    expect(attempt).toThrow(/getMissingEndpoint \(blob\): no `build\.query` \/ `build\.mutation` definition found/);
  });

  it('generates handlers for long, prettier-wrapped endpoint names', async () => {
    const own = createApp();
    apps.push(own);
    const doc = readSample();
    const longPath = '/api/admin/library/books/{bookId}/chapters/{chapterId}/attachments/archive/download';
    const textPath = '/api/admin/library/books/{bookId}/chapters/{chapterId}/rendered/preview/document';
    const params = ['bookId', 'chapterId'].map((name) => ({ name, in: 'path', required: true, schema: { type: 'integer' } }));
    doc.paths![longPath] = {
      get: { tags: doc.paths!['/api/admin/library/books/export']!.get!.tags, parameters: params, responses: { 200: { description: 'archive', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } } } },
    } as never;
    doc.paths![textPath] = {
      get: { tags: doc.paths!['/api/admin/library/books/export']!.get!.tags, parameters: params, responses: { 200: { description: 'html', content: { 'text/html': { schema: { type: 'string' } } } } } },
    } as never;
    const result = await generateSdk({ cwd: own, config: { apis: [apiEntry(writeSpec(own, doc))] }, logger: silentLogger });
    expect(result.typechecked).toBe(true);
    const source = read(own, 'src/api/adminApi.ts');
    // prettier wraps the long names: the key is on its own line, not on the `build.query<` line
    expect(source).toMatch(/\n\s+getApiAdminLibraryBooksByBookIdChapters\w*ArchiveDownload:\s*\n\s+build\.query</);
    const blobBlock = source.slice(source.search(/getApiAdminLibraryBooksByBookIdChapters\w*ArchiveDownload:/));
    expect(blobBlock.slice(0, blobBlock.indexOf('}),'))).toContain('responseHandler: blobResponseHandler');
    const textBlock = source.slice(source.search(/getApiAdminLibraryBooksByBookIdChapters\w*PreviewDocument:/));
    expect(textBlock.slice(0, textBlock.indexOf('}),'))).toContain('responseHandler: "text"');
  }, 60_000);
});

const apps: string[] = [];
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

const block = (source: string, key: string): string => {
  const start = source.indexOf(`${key}:`);
  return start < 0 ? '' : source.slice(start, source.indexOf('}),', start));
};

describe('generated file endpoints', () => {
  let app: string;
  let api: string;

  beforeAll(async () => {
    app = createApp();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger });
    api = read(app, 'src/api/adminApi.ts');
    return () => removeApp(app);
  }, 60_000);

  it('uses blobResponseHandler with DddFileResponse for a detected binary response', () => {
    expect(api).toMatch(/import \{ blobResponseHandler \} from ["']@mgamadeus\/ddd-web\/api["']/);
    expect(block(api, 'getApiAdminLibraryBooksExport')).toContain('responseHandler: blobResponseHandler');
    const model = read(app, 'src/models/_endpoints/GetApiAdminLibraryBooksExportApiResponse.ts');
    expect(model).toMatch(/import type \{ DddFileResponse \} from ["']@mgamadeus\/ddd-web\/api["']/);
    expect(model).toMatch(/export type GetApiAdminLibraryBooksExportApiResponse = DddFileResponse;/);
  });

  it('keeps a JSON-declared export route on JSON without an override', () => {
    expect(block(api, 'getApiAdminLibraryAuthorsExport')).not.toContain('responseHandler');
    expect(block(api, 'getApiAdminLibraryBooksList')).not.toContain('responseHandler');
  });

  it('applies config overrides (api entry before global) and type-checks', async () => {
    const own = createApp();
    apps.push(own);
    const result = await generateSdk({
      cwd: own,
      config: {
        responseHandlers: [{ path: /\/export$/, handler: 'text' }],
        apis: [
          apiEntry(SAMPLE_SPEC, {
            responseHandlers: [
              { method: 'get', path: '/api/admin/library/authors/export', handler: 'blob' },
              { path: '/api/admin/library/books/{bookId}/preview', handler: 'json' },
            ],
          }),
        ],
      },
      logger: silentLogger,
    });
    expect(result.typechecked).toBe(true);
    const source = read(own, 'src/api/adminApi.ts');
    expect(block(source, 'getApiAdminLibraryAuthorsExport')).toContain('responseHandler: blobResponseHandler');
    expect(read(own, 'src/models/_endpoints/GetApiAdminLibraryAuthorsExportApiResponse.ts')).toContain('= DddFileResponse;');
    // global override applies where the api entry has none
    expect(block(source, 'getApiAdminLibraryBooksExport')).toContain('responseHandler: "text"');
    expect(read(own, 'src/models/_endpoints/GetApiAdminLibraryBooksExportApiResponse.ts')).toMatch(/= string;/);
    // json override turns off the detected text handler
    expect(block(source, 'getApiAdminLibraryBooksByBookIdPreview')).not.toContain('responseHandler');
  }, 60_000);

  it('adds no package import to an api without file endpoints', async () => {
    const own = createApp();
    apps.push(own);
    const doc = readSample();
    delete doc.paths!['/api/admin/library/books/export'];
    await generateSdk({ cwd: own, config: { apis: [apiEntry(writeSpec(own, doc))] }, logger: silentLogger, skipTsc: true });
    expect(read(own, 'src/api/adminApi.ts')).not.toContain('@mgamadeus/ddd-web/api');
  }, 60_000);
});
