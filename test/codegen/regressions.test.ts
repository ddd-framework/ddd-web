import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSdk, silentLogger } from '../../src/codegen/index';
import type { OpenApiDocument } from '../../src/codegen/openapi';
import { apiEntry, captureLogger, createApp, enhancedEntry, hookNames, read, readSample, removeApp, SAMPLE_SPEC, writeSpec } from './helpers';

const apps: string[] = [];
const newApp = (): string => {
  const dir = createApp();
  apps.push(dir);
  return dir;
};
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

type Schema = { type?: string; properties?: Record<string, unknown>; required?: string[] };
const schemas = (doc: OpenApiDocument) => doc.components!.schemas as Record<string, Schema>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const schemaTag = (name: string) => ({ name: name.split('.').pop()!, description: `<SchemaDefinition schemaRef="#/components/schemas/${name}" />` });

describe('codegen regressions', () => {
  it('keeps the side-effect classification next to a user endpointOverride without type', async () => {
    const app = newApp();
    await generateSdk({
      cwd: app,
      config: { apis: [apiEntry(SAMPLE_SPEC, { endpointOverrides: [{ pattern: /.*/, parameterFilter: (name: string) => name !== 'outputFormat' }] })] },
      logger: silentLogger,
      skipTsc: true,
    });
    const api = read(app, 'src/api/adminApi.ts');
    const enhanced = read(app, 'src/api/adminApiEnhanced.ts');
    expect(api).toMatch(/getApiAdminLibraryBooksByBookIdGenerateSummary: build\.mutation</);
    expect(api).toMatch(/postApiAdminLibraryBooksSearch: build\.query</);
    expect(api).not.toContain('outputFormat');
    expect(enhancedEntry(enhanced, 'getApiAdminLibraryBooksByBookIdGenerateSummary')).toContain('invalidatesTags');
  }, 60_000);

  it('lets a user endpointOverride with an explicit type win', async () => {
    const app = newApp();
    await generateSdk({
      cwd: app,
      config: { apis: [apiEntry(SAMPLE_SPEC, { endpointOverrides: [{ pattern: 'postApiAdminLibraryBooksSearch', type: 'mutation' }] })] },
      logger: silentLogger,
      skipTsc: true,
    });
    expect(read(app, 'src/api/adminApi.ts')).toMatch(/postApiAdminLibraryBooksSearch: build\.mutation</);
  }, 60_000);

  it('encodes path parameters by default and leaves them alone with encodePathParams: false', async () => {
    const app = newApp();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipTsc: true });
    const encoded = read(app, 'src/api/adminApi.ts');
    expect(encoded).toContain('encodeURIComponent(String(queryArg.bookId))');
    expect(encoded).not.toMatch(/\$\{queryArg\.bookId\}/);

    const plainApp = newApp();
    await generateSdk({
      cwd: plainApp,
      config: { apis: [apiEntry(SAMPLE_SPEC, { encodePathParams: false })] },
      logger: silentLogger,
      skipTsc: true,
    });
    const plain = read(plainApp, 'src/api/adminApi.ts');
    expect(plain).toMatch(/\$\{queryArg\.bookId\}/);
    expect(plain).not.toContain('encodeURIComponent(String(queryArg.bookId))');
  }, 60_000);

  for (const [option, accessor] of [
    ['encodePathParams', 'arg.bookId'],
    ['flattenArg', 'arg'],
  ] as const) {
    it(`keeps entity tags and side effects with ${option}`, async () => {
      const app = newApp();
      const doc = readSample();
      if (option === 'flattenArg') {
        // flattenArg applies to endpoints with exactly one argument: keep only the path parameters
        for (const item of Object.values(doc.paths!)) {
          for (const operation of Object.values(item!)) {
            const candidate = operation as { parameters?: Array<{ in?: string }> };
            if (Array.isArray(candidate.parameters)) candidate.parameters = candidate.parameters.filter((p) => p.in === 'path');
          }
        }
      }
      await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc), { [option]: true })] }, logger: silentLogger });
      if (option === 'flattenArg') expect(read(app, 'src/api/adminApi.ts')).toContain('${encodeURIComponent(String(queryArg))}');
      else expect(read(app, 'src/api/adminApi.ts')).toContain('encodeURIComponent(String(queryArg.bookId))');
      const enhanced = read(app, 'src/api/adminApiEnhanced.ts');
      expect(enhancedEntry(enhanced, 'getApiAdminLibraryBooksByBookId')).toContain(`id: ${accessor} }`);
      const deletion = enhancedEntry(enhanced, 'deleteApiAdminLibraryBooksByBookId');
      expect(deletion).toContain(`id: ${accessor} }`);
      expect(deletion).toContain('id: "LIST"');
      expect(enhancedEntry(enhanced, 'getApiAdminLibraryBooksByBookIdGenerateSummary')).toContain('invalidatesTags');
      expect(enhancedEntry(enhanced, 'getApiAdminLibraryAuthorsByAuthorId')).toContain(`id: ${accessor.replace('bookId', 'authorId')} }`);
    }, 60_000);
  }

  it('invalidates by identity for writes without x-ddd-entity, the whole tag only without identity', async () => {
    const app = newApp();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipTsc: true });
    const enhanced = read(app, 'src/api/adminApiEnhanced.ts');
    const wholeType = /\{ type: "(Authors|Books)" as const \}/;
    for (const key of ['postApiAdminLibraryAuthors', 'patchApiAdminLibraryAuthors', 'postApiAdminLibraryBooksByBookIdPublish', 'deleteApiAdminLibraryAuthorsByAuthorId', 'deleteApiAdminLibraryAuthorsByAuthorIdPortrait']) {
      const entry = enhancedEntry(enhanced, key);
      expect(entry, key).toContain('id: "LIST"');
      expect(entry, key).not.toMatch(wholeType);
    }
    expect(enhancedEntry(enhanced, 'postApiAdminLibraryAuthorsMerge')).toMatch(wholeType);
  }, 60_000);

  it('places two models with the same leaf name in different namespaces into separate files', async () => {
    const app = newApp();
    const doc = readSample();
    const bookItem = 'App.Domain.Library.Entities.Books.Item';
    const authorItem = 'App.Domain.Library.Entities.Authors.Item';
    schemas(doc)[bookItem] = { type: 'object', properties: { isbn: { type: 'string' } }, required: ['isbn'] };
    schemas(doc)[authorItem] = { type: 'object', properties: { award: { type: 'string' } }, required: ['award'] };
    schemas(doc)['App.Domain.Library.Entities.Books.Book']!.properties!.item = ref(bookItem);
    schemas(doc)['App.Domain.Library.Entities.Authors.Author']!.properties!.item = ref(authorItem);
    doc.tags!.push(schemaTag(bookItem), schemaTag(authorItem));
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger: silentLogger });
    const books = read(app, 'src/models/App/Domain/Library/Entities/Books/Item.ts');
    const authors = read(app, 'src/models/App/Domain/Library/Entities/Authors/Item.ts');
    expect(books).toContain('isbn');
    expect(books).not.toContain('award');
    expect(authors).toContain('award');
    expect(authors).not.toContain('isbn');
    const bookName = books.match(/export type (\w+)/)![1]!;
    const authorName = authors.match(/export type (\w+)/)![1]!;
    expect(bookName).not.toBe(authorName);
    expect(read(app, 'src/models/App/Domain/Library/Entities/Books/Book.ts')).toContain(`item?: ${bookName}`);
    expect(read(app, 'src/models/App/Domain/Library/Entities/Authors/Author.ts')).toContain(`item?: ${authorName}`);
    const barrel = read(app, 'src/models/index.ts');
    expect(barrel).toContain('Entities/Books/Item');
    expect(barrel).toContain('Entities/Authors/Item');
  }, 60_000);

  it('keeps fields contributed by another api when regenerating one api with --api', async () => {
    const app = newApp();
    const other = readSample();
    schemas(other)['App.Domain.Library.Entities.Books.Book']!.properties!.otherApiOnly = { type: 'string' };
    const config = {
      apis: [
        apiEntry(SAMPLE_SPEC),
        apiEntry(writeSpec(app, other, 'other.json'), { outputFile: './src/api/otherApi.ts', exportName: 'otherApi', audience: 'admin' }),
      ],
    };
    const bookModel = 'src/models/App/Domain/Library/Entities/Books/Book.ts';
    await generateSdk({ cwd: app, config, logger: silentLogger, skipTsc: true });
    expect(read(app, bookModel)).toContain('otherApiOnly');
    await generateSdk({ cwd: app, config, api: 'adminApi', logger: silentLogger, skipTsc: true });
    expect(read(app, bookModel)).toContain('otherApiOnly');
  }, 60_000);

  it('writes .js import specifiers everywhere with esmExtensions (NodeNext type check)', async () => {
    const app = newApp();
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module' }));
    const tsconfig = JSON.parse(read(app, 'tsconfig.json'));
    tsconfig.compilerOptions.module = 'NodeNext';
    tsconfig.compilerOptions.moduleResolution = 'NodeNext';
    fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify(tsconfig));
    const result = await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC, { esmExtensions: true })] }, logger: silentLogger });
    expect(result.typechecked).toBe(true);
    expect(read(app, 'src/api/adminApi.ts')).toMatch(/from ["']\.\.\/models\/index\.js["']/);
    expect(read(app, 'src/models/index.ts')).toMatch(/\.js["'];/);
    expect(read(app, 'src/models/App/Domain/Library/Entities/Books/Book.ts')).toMatch(/Author\.js["']/);
  }, 60_000);

  it('types only text responses as string', async () => {
    const app = newApp();
    const doc = readSample();
    // a JSON endpoint whose 200 schema is an empty object must stay an object type
    doc.paths!['/api/admin/library/authors/preview']!.post!.responses = {
      200: { description: '', content: { 'application/json': { schema: { type: 'object', properties: {} } } } },
    };
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger: silentLogger, skipTsc: true });
    expect(read(app, 'src/models/_endpoints/PostApiAdminLibraryAuthorsPreviewApiResponse.ts')).toMatch(/status 200\s*\*\/\s*\{\s*\}/);
    expect(read(app, 'src/models/_endpoints/GetApiAdminLibraryBooksByBookIdPreviewApiResponse.ts')).toMatch(/\bstring\b/);
  }, 60_000);

  it('resolves $ref path parameters instead of adding a string duplicate', async () => {
    const app = newApp();
    const doc = readSample();
    doc.components!.parameters = { BookId: { name: 'bookId', in: 'path', required: true, schema: { type: 'integer' } } };
    const publish = doc.paths!['/api/admin/library/books/{bookId}/publish']!.post!;
    publish.parameters = [{ $ref: '#/components/parameters/BookId' }, ...(publish.parameters as Array<{ in: string }>).filter((p) => p.in !== 'path')];
    const logger = captureLogger();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger, skipTsc: true });
    expect(logger.warnings.filter((warning) => warning.includes('not declared'))).toEqual([]);
    expect(read(app, 'src/models/_endpoints/PostApiAdminLibraryBooksByBookIdPublishApiArg.ts')).toMatch(/bookId: number/);
    expect(hookNames(read(app, 'src/api/adminApi.ts'))).toContain('usePostApiAdminLibraryBooksByBookIdPublishMutation');
  }, 60_000);
});
