import * as fs from 'node:fs';
import * as path from 'node:path';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateSdk, silentLogger, type SdkConfig } from '../../src/codegen/index';
import { typecheck } from '../../src/codegen/format';
import { mswPathPattern } from '../../src/codegen/msw-handlers';
import type { OpenApiDocument } from '../../src/codegen/openapi';
import { apiEntry, createApp, read, readSample, removeApp, writeSpec } from './helpers';

/** The sample plus an array response and a no-content operation (path parameters, text and binary are in it). */
function extendedSample(): OpenApiDocument {
  const document = readSample();
  const publish = document.paths!['/api/admin/library/books/{bookId}/publish']!.post!;
  const errors = { 400: publish.responses!['400']!, 500: publish.responses!['500']! };
  document.paths!['/api/admin/library/books/featured'] = {
    get: {
      summary: 'Featured Books',
      tags: publish.tags,
      responses: {
        200: {
          description: '',
          content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/App.Domain.Library.Entities.Books.Book' } } } },
        },
        ...errors,
      },
    },
  };
  document.paths!['/api/admin/library/books/{bookId}/archive'] = {
    post: {
      summary: 'Book Archive',
      tags: publish.tags,
      parameters: [publish.parameters![0]!],
      responses: { 204: { description: 'Archived' }, ...errors },
    },
  };
  return document;
}

/** Mock modules at the given import prefix (`src/mocks`, aliased `@mocks/*`) for every model the handlers import. */
function writeModelMocks(app: string, handlers: string): string[] {
  const written: string[] = [];
  for (const match of handlers.matchAll(/^import \{ ([^}]+) \} from "@mocks\/(.+)\.mock";$/gm)) {
    const modelPath = match[2]!;
    const name = path.basename(modelPath);
    const file = path.join(app, 'src/mocks', `${modelPath}.mock.ts`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const modelImport = path.relative(path.dirname(file), path.join(app, 'src/models', modelPath)).split(path.sep).join('/');
    fs.writeFileSync(file, `import type { ${name} } from '${modelImport}';\nexport const get${name}Mock = (): ${name} => ({ mock: '${name}' }) as unknown as ${name};\n`);
    written.push(modelPath);
  }
  return written;
}

const config = (schemaFile: string, extra: Partial<SdkConfig> = {}): SdkConfig => ({
  apis: [apiEntry(schemaFile)],
  endpoints: { requestBuilders: 'all' },
  mswHandlers: { modelMocks: { importPrefix: '@mocks/' } },
  ...extra,
});

describe('MSW handlers (default mode, mswHandlers)', () => {
  let app: string;
  let handlers: string;

  beforeAll(async () => {
    app = createApp();
    const tsconfig = JSON.parse(read(app, 'tsconfig.json'));
    tsconfig.compilerOptions.paths = { '@mocks/*': ['./src/mocks/*'] };
    fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify(tsconfig));
    await generateSdk({ cwd: app, config: config(writeSpec(app, extendedSample())), logger: silentLogger, skipTsc: true });
    handlers = read(app, 'src/api/adminApiMocks.ts');
    return () => removeApp(app);
  }, 60_000);

  it('writes <stem>Mocks.ts with one handler factory per operation that has a request builder', async () => {
    await expect(handlers).toMatchFileSnapshot('__snapshots__/adminApiMocks.ts.snap');
    const builders = [...read(app, 'src/api/adminApiRequests.ts').matchAll(/^  (\w+): \(/gm)].map((match) => match[1]);
    const factories = [...handlers.matchAll(/^  (\w+): \(\n?\s*custom\?/gm)].map((match) => match[1]);
    expect(factories).toEqual(builders);
    expect(factories.length).toBeGreaterThan(15);
  });

  it('matches any origin and every path parameter, answers the model mock, an array of the item mock, null without content', () => {
    const entry = (key: string): string => {
      const start = handlers.indexOf(`  ${key}: (`);
      return handlers.slice(start, handlers.indexOf('custom,\n    ),', start)).replace(/\s+/g, ' ');
    };
    expect(entry('getApiAdminLibraryBooksByBookId')).toContain('"get", "*/api/admin/library/books/:bookId", "/api/admin/library/books/{bookId}", "json", 200, () => getBookGetResponseDtoMock(),');
    expect(entry('getApiAdminLibraryBooksFeatured')).toContain('"json", 200, () => [getBookMock()],');
    expect(entry('postApiAdminLibraryBooksByBookIdArchive')).toContain('"post", "*/api/admin/library/books/:bookId/archive", "/api/admin/library/books/{bookId}/archive", "json", 204, () => null,');
    expect(entry('getApiAdminLibraryBooksExport')).toContain('StoryMock<Blob | string | null,');
    expect(entry('getApiAdminLibraryBooksExport')).toContain('"blob", 200, () => null,');
    expect(entry('getApiAdminLibraryBooksByBookIdPreview')).toContain('"text", 200, () => null,');
    expect(handlers).toContain('import { getBookMock } from "@mocks/App/Domain/Library/Entities/Books/Book.mock";');
  });

  it('type-checks against the generated models and model mocks', () => {
    expect(writeModelMocks(app, handlers)).toContain('App/Domain/Library/Entities/Books/Book');
    fs.writeFileSync(
      path.join(app, 'src/story.ts'),
      [
        "import { adminApiMocks, type StoryMock } from './api/adminApiMocks';",
        "import type { Book } from './models/App/Domain/Library/Entities/Books/Book';",
        'export const handlers = [',
        '  adminApiMocks.getApiAdminLibraryBooksFeatured({ response: (params, defaultMock) => [...(defaultMock ?? []), ...(params.noCache ? [] : [])] }),',
        "  adminApiMocks.getApiAdminLibraryBooksByBookId({ status: 404, delay: 'infinite', url: '*/books/:bookId' }),",
        '  adminApiMocks.getApiAdminLibraryBooksExport({ response: new Blob(["x"]) }),',
        '];',
        'export const featured: Partial<StoryMock<Book[], void>> = { response: [] };',
        '// @ts-expect-error a response of the wrong model',
        'adminApiMocks.getApiAdminLibraryBooksFeatured({ response: 5 });',
        '',
      ].join('\n'),
    );
    expect(typecheck(app, path.join(app, 'tsconfig.json'), silentLogger)).toBe(true);
  }, 60_000);
});

describe('mswPathPattern', () => {
  it('turns each path parameter into one MSW segment parameter with a word-character, unique name', () => {
    expect(mswPathPattern('/api/books')).toBe('*/api/books');
    expect(mswPathPattern('/api/accounts/{accountId}/locations/{locationId}')).toBe('*/api/accounts/:accountId/locations/:locationId');
    expect(mswPathPattern('/files/{file-name}.{ext}')).toBe('*/files/:file_name.:ext');
    expect(mswPathPattern('/a/{id}/b/{id}/{1st}')).toBe('*/a/:id/b/:id2/:p1st');
  });
});

describe('MSW handlers at runtime', () => {
  const server = setupServer();
  let app: string;
  let mocks: Record<string, (custom?: Record<string, unknown>) => Parameters<typeof server.use>[0]>;

  beforeAll(async () => {
    app = createApp();
    // a relative import prefix: the generated module runs here without path aliases
    await generateSdk({
      cwd: app,
      config: config(writeSpec(app, extendedSample()), { mswHandlers: { modelMocks: { importPrefix: '../mocks/' } } }),
      logger: silentLogger,
      skipTsc: true,
    });
    const handlers = read(app, 'src/api/adminApiMocks.ts');
    for (const match of handlers.matchAll(/^import \{ ([^}]+) \} from "\.\.\/mocks\/(.+)\.mock";$/gm)) {
      const file = path.join(app, 'src/mocks', `${match[2]}.mock.ts`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `export const ${match[1]} = () => ({ mock: '${path.basename(match[2]!)}' });\n`);
    }
    mocks = (await import(path.join(app, 'src/api/adminApiMocks.ts'))).adminApiMocks;
    server.listen({ onUnhandledRequest: 'error' });
    return () => {
      server.close();
      removeApp(app);
    };
  }, 60_000);
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('answers the default mock, an array, no content and the declared status', async () => {
    // `:bookId` matches one segment: the static path goes before the parameterised one it would also match
    server.use(mocks.getApiAdminLibraryBooksFeatured!(), mocks.getApiAdminLibraryBooksByBookId!(), mocks.postApiAdminLibraryBooksByBookIdArchive!());
    const single = await fetch('https://api.example.com/api/admin/library/books/7?noCache=1');
    expect([single.status, await single.json()]).toEqual([200, { mock: 'BookGetResponseDto' }]);
    const list = await fetch('http://localhost/api/admin/library/books/featured');
    expect(await list.json()).toEqual([{ mock: 'Book' }]);
    const archived = await fetch('https://api.example.com/api/admin/library/books/7/archive', { method: 'POST' });
    expect([archived.status, await archived.text()]).toEqual([204, '']);
  });

  it('matches a path parameter in one segment only', async () => {
    server.use(mocks.getApiAdminLibraryBooksByBookId!());
    const single = await fetch('https://api.example.com/api/admin/library/books/7');
    expect(single.status).toBe(200);
    // with `*` per parameter `/books/*` answered this deeper path too
    await expect(fetch('https://api.example.com/api/admin/library/books/7/preview')).rejects.toThrow();
  });

  it('honours custom response (value or function of params and default mock), status, url and delay', async () => {
    server.use(
      mocks.getApiAdminLibraryBooksByBookId!({
        status: 202,
        delay: 1,
        response: (params: Record<string, string>, defaultMock: unknown) => Promise.resolve({ params, defaultMock }),
      }),
      mocks.getApiAdminLibraryAuthorsList!({ url: '*/custom/authors', response: { custom: true } }),
    );
    const answer = await fetch('https://api.example.com/base/api/admin/library/books/a%2Fb?outputFormat=json');
    expect(answer.status).toBe(202);
    expect(await answer.json()).toEqual({ params: { outputFormat: 'json', bookId: 'a/b' }, defaultMock: { mock: 'BookGetResponseDto' } });
    expect(await (await fetch('https://api.example.com/custom/authors')).json()).toEqual({ custom: true });
  });

  it('answers a file download with null and status 200 unless a body is given', async () => {
    server.use(mocks.getApiAdminLibraryBooksExport!());
    const empty = await fetch('https://api.example.com/api/admin/library/books/export');
    expect([empty.status, await empty.text()]).toEqual([200, '']);
    server.use(mocks.getApiAdminLibraryBooksExport!({ response: new Blob(['xlsx']) }));
    expect(await (await fetch('https://api.example.com/api/admin/library/books/export')).text()).toBe('xlsx');
  });
});

describe('MSW handlers with an endpoint filter', () => {
  it('covers every operation with a request builder (requestBuilders all), not only the filtered endpoints', async () => {
    const app = createApp();
    try {
      const spec = writeSpec(app, extendedSample());
      await generateSdk({
        cwd: app,
        config: {
          ...config(spec),
          apis: [apiEntry(spec, { filterEndpoints: (name: string) => name === 'getApiAdminLibraryBooksList' })],
          models: { naming: 'document', enums: 'const', index: false, scope: 'all' },
        },
        logger: silentLogger,
        skipTsc: true,
      });
      expect(read(app, 'src/api/adminApi.ts')).not.toContain('getApiAdminLibraryAuthorsList');
      const handlers = read(app, 'src/api/adminApiMocks.ts');
      expect(handlers).toContain('  getApiAdminLibraryAuthorsList: (');
      expect(handlers).toContain('from "../models/_endpoints/GetApiAdminLibraryAuthorsListApiResponse"');
      expect(handlers).toContain('() => [getBookMock()]');
    } finally {
      removeApp(app);
    }
  }, 60_000);
});

describe('MSW handlers off', () => {
  it('writes no handlers file without mswHandlers, or with mswHandlers false on the api', async () => {
    const app = createApp();
    try {
      const spec = writeSpec(app, extendedSample());
      await generateSdk({ cwd: app, config: { apis: [apiEntry(spec)] }, logger: silentLogger, skipTsc: true });
      expect(fs.existsSync(path.join(app, 'src/api/adminApiMocks.ts'))).toBe(false);
      await generateSdk({
        cwd: app,
        config: { apis: [apiEntry(spec, { mswHandlers: false })], mswHandlers: {} },
        logger: silentLogger,
        skipTsc: true,
      });
      expect(fs.existsSync(path.join(app, 'src/api/adminApiMocks.ts'))).toBe(false);
      // api-level options alone enable them; without model mocks every default answer is null
      await generateSdk({
        cwd: app,
        config: { apis: [apiEntry(spec, { mswHandlers: { outputFile: './src/mocks/handlers.ts', exportName: 'libraryMocks' } })] },
        logger: silentLogger,
      });
      const handlers = read(app, 'src/mocks/handlers.ts');
      expect(handlers).toContain('export const libraryMocks = {');
      expect(handlers).not.toMatch(/get\w+Mock\(\)/);
      expect(handlers).toContain('from "../models"');
    } finally {
      removeApp(app);
    }
  }, 60_000);
});
