import { afterEach, describe, expect, it } from 'vitest';
import { generateSdk, silentLogger } from '../../src/codegen/index';
import { injectMultipartBodies, readMultipartOperation } from '../../src/codegen/multipart';
import type { OpenApiDocument } from '../../src/codegen/openapi';
import { apiEntry, captureLogger, createApp, read, readSample, removeApp, writeSpec } from './helpers';

const fileList = { type: 'array', items: { type: 'string', format: 'binary' } };
const jsonBody = { 'application/json': { schema: { type: 'object', properties: { caption: { type: 'string' } } } } };
const multipartBody = (required: string[] = []) => ({
  'multipart/form-data': {
    schema: { type: 'object', properties: { attachmentFiles: fileList, body: { type: 'string' } }, ...(required.length ? { required } : {}) },
  },
});
const emptyDoc = { openapi: '3.0.0', paths: {} } as OpenApiDocument;

describe('readMultipartOperation', () => {
  it('reads the file fields, leaving out the JSON envelope field', () => {
    expect(readMultipartOperation(emptyDoc, { content: { ...jsonBody, ...multipartBody() } })).toEqual({
      fields: ['attachmentFiles'],
      required: [],
      multipartOnly: false,
    });
    expect(readMultipartOperation(emptyDoc, { content: multipartBody(['attachmentFiles']) })).toEqual({
      fields: ['attachmentFiles'],
      required: ['attachmentFiles'],
      multipartOnly: true,
    });
  });

  it('returns null without a multipart body or without file fields', () => {
    expect(readMultipartOperation(emptyDoc, { content: jsonBody })).toBeNull();
    expect(readMultipartOperation(emptyDoc, undefined)).toBeNull();
    expect(readMultipartOperation(emptyDoc, { content: { 'multipart/form-data': { schema: { type: 'object', properties: {} } } } })).toBeNull();
  });

  it('follows a schema reference', () => {
    const doc = { ...emptyDoc, components: { schemas: { Upload: { type: 'object', properties: { files: fileList }, required: ['files'] } } } } as OpenApiDocument;
    const body = { content: { 'multipart/form-data': { schema: { $ref: '#/components/schemas/Upload' } } } };
    expect(readMultipartOperation(doc, body)?.required).toEqual(['files']);
  });
});

describe('injectMultipartBodies', () => {
  const source = (bodyExpression: string, argType: string) =>
    [
      'const injectedRtkApi = api.injectEndpoints({',
      '  endpoints: (build) => ({',
      '    postMessage: build.mutation<PostMessageApiResponse, PostMessageApiArg>({',
      `      query: (queryArg) => ({ url: \`/api/messages\`, method: 'POST', body: ${bodyExpression} }),`,
      '    }),',
      '  }),',
      '});',
      `export type PostMessageApiArg = ${argType};`,
    ].join('\n');
  const both = { fields: ['attachmentFiles'], required: [], multipartOnly: false };

  it('wraps the JSON body and adds the optional files argument', () => {
    const logger = captureLogger();
    const out = injectMultipartBodies(source('queryArg.messageDto', '{\n  messageDto: MessageDto;\n}'), new Map([['postMessage', both]]), logger);
    expect(out.injected).toEqual(['postMessage']);
    expect(out.source).toContain('body: buildDddMultipartBody(queryArg.messageDto, queryArg.multipartFiles)');
    expect(out.source).toContain('messageDto: MessageDto;');
    expect(out.source).toMatch(/multipartFiles\?: \{ attachmentFiles\?: readonly \(Blob \| \{ uri: string; name: string; type: string \}\)\[\] \| null \};/);
    expect(logger.warnings).toEqual([]);
  });

  it('replaces the body argument of a multipart-only operation', () => {
    const only = { fields: ['files'], required: ['files'], multipartOnly: true };
    const out = injectMultipartBodies(source('queryArg.body', '{\n  noCache?: boolean;\n  body: {\n    files: UploadedFile[];\n  };\n}'), new Map([['postMessage', only]]), captureLogger());
    expect(out.source).toContain('body: buildDddMultipartBody(undefined, queryArg.multipartFiles)');
    expect(out.source).not.toContain('UploadedFile');
    expect(out.source).toContain('noCache?: boolean;');
    expect(out.source).toMatch(/multipartFiles: \{ files: readonly \(Blob \| [^)]+\)\[\] \};/);
  });

  it('leaves a flattened argument alone and says so', () => {
    const logger = captureLogger();
    const flattened = injectMultipartBodies(source('queryArg', 'MessageDto'), new Map([['postMessage', both]]), logger);
    expect(flattened.injected).toEqual([]);
    expect(flattened.source).toContain('body: queryArg }');
    expect(logger.warnings.join('\n')).toMatch(/postMessage: multipart body not generated/);
  });
});

const apps: string[] = [];
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

describe('generated multipart endpoints', () => {
  it('generates files arguments that type-check, for JSON + multipart and multipart-only operations', async () => {
    const app = createApp();
    apps.push(app);
    const doc = readSample();
    const tags = doc.paths!['/api/admin/library/books/export']!.get!.tags;
    const ok = { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } };
    doc.paths!['/api/admin/library/books/{bookId}/notes'] = {
      post: {
        tags,
        parameters: [{ name: 'bookId', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { ...jsonBody, ...multipartBody() } },
        responses: ok,
      },
    } as never;
    doc.paths!['/api/admin/library/books/bulk-upload'] = {
      post: { tags, requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { files: fileList }, required: ['files'] } } } }, responses: ok },
    } as never;
    const logger = captureLogger();
    const result = await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger });
    expect(result.typechecked).toBe(true);
    expect(logger.infos.join('\n')).toContain('2 multipart endpoint(s)');
    const api = read(app, 'src/api/adminApi.ts');
    expect(api).toMatch(/import \{ buildDddMultipartBody \} from ["']@mgamadeus\/ddd-web\/api["']/);
    expect(api.replace(/\s+/g, ' ')).toMatch(/body: buildDddMultipartBody\( ?queryArg\.body, queryArg\.multipartFiles,? ?\)/);
    expect(api.replace(/\s+/g, ' ')).toMatch(/body: buildDddMultipartBody\( ?undefined, queryArg\.multipartFiles,? ?\)/);
    const notesArg = read(app, 'src/models/_endpoints/PostApiAdminLibraryBooksByBookIdNotesApiArg.ts');
    expect(notesArg).toMatch(/multipartFiles\?: \{/);
    expect(notesArg).toContain('bookId: number');
    const uploadArg = read(app, 'src/models/_endpoints/PostApiAdminLibraryBooksBulkUploadApiArg.ts');
    expect(uploadArg).toMatch(/multipartFiles: \{/);
    expect(uploadArg).not.toMatch(/\bbody\b\s*:/);
  }, 60_000);

  it('adds no multipart import to an api without multipart operations', async () => {
    const app = createApp();
    apps.push(app);
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, readSample()))] }, logger: silentLogger, skipTsc: true });
    expect(read(app, 'src/api/adminApi.ts')).not.toContain('buildDddMultipartBody');
  }, 60_000);
});
