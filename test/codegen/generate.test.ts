import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateSdk, SdkGenerationError, silentLogger } from '../../src/codegen/index';
import {
  apiEntry,
  captureLogger,
  createApp,
  enhancedEntry,
  hookNames,
  read,
  readSample,
  removeApp,
  SAMPLE_SPEC,
  writeSpec,
} from './helpers';

const apps: string[] = [];
const newApp = (): string => {
  const dir = createApp();
  apps.push(dir);
  return dir;
};
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

describe('generateSdk on the sample spec', () => {
  let app: string;
  let api: string;
  let enhanced: string;

  beforeAll(async () => {
    app = createApp();
    await generateSdk({
      cwd: app,
      config: { apis: [apiEntry(SAMPLE_SPEC)] },
      logger: silentLogger,
    });
    api = read(app, 'src/api/adminApi.ts');
    enhanced = read(app, 'src/api/adminApiEnhanced.ts');
    return () => removeApp(app);
  }, 60_000);

  it('writes the api files next to the output file and models into ../models', () => {
    for (const file of [
      'src/api/adminApi.ts',
      'src/api/adminApiTags.ts',
      'src/api/adminApiEnhanced.ts',
      'src/models/index.ts',
      'src/models/App/Domain/Library/Entities/Books/Book.ts',
      'src/models/App/Presentation/Api/Admin/Library/Dtos/Books/BookUpdateRequestDto.ts',
      'src/models/DDD/Domain/Base/Entities/ChangeHistory/ChangeHistory.ts',
      'src/models/_endpoints/GetApiAdminLibraryBooksListApiArg.ts',
    ]) {
      expect(fs.existsSync(path.join(app, file)), file).toBe(true);
    }
    expect(api).toMatch(/from ['"]\.\.\/models['"]/);
    expect(read(app, 'src/models/index.ts')).not.toContain('Presentation');
  });

  it('derives hook names from verb and path', () => {
    const hooks = hookNames(api);
    expect(hooks).toEqual(
      expect.arrayContaining([
        'useGetApiAdminLibraryBooksListQuery',
        'useLazyGetApiAdminLibraryBooksListQuery',
        'useGetApiAdminLibraryBooksByBookIdQuery',
        'useDeleteApiAdminLibraryBooksByBookIdMutation',
        'usePatchApiAdminLibraryBooksMutation',
        'usePostApiAdminLibraryBooksMutation',
        'usePostApiAdminLibraryBooksByBookIdPublishMutation',
      ]),
    );
    expect(new Set(hooks).size).toBe(hooks.length);
  });

  it('turns x-ddd-side-effects into the hook kind', () => {
    const hooks = hookNames(api);
    expect(hooks).toContain('useGetApiAdminLibraryBooksByBookIdGenerateSummaryMutation');
    expect(hooks).not.toContain('useGetApiAdminLibraryBooksByBookIdGenerateSummaryQuery');
    expect(api).toMatch(/getApiAdminLibraryBooksByBookIdGenerateSummary: build\.mutation</);
    expect(hooks).toContain('usePostApiAdminLibraryBooksSearchQuery');
    expect(api).toMatch(/postApiAdminLibraryBooksSearch: build\.query</);
    // without extension or override: default behaviour
    expect(hooks).toContain('usePostApiAdminLibraryAuthorsPreviewMutation');
  });

  it('derives cache tags from x-ddd-entity', () => {
    expect(enhancedEntry(enhanced, 'getApiAdminLibraryBooksList')).toContain(`id: "LIST"`);
    expect(enhancedEntry(enhanced, 'getApiAdminLibraryBooksByBookId')).toContain('id: arg.bookId');
    const upsert = enhancedEntry(enhanced, 'patchApiAdminLibraryBooks');
    expect(upsert).toContain('invalidatesTags');
    expect(upsert).toContain(`{ type: "Books" as const, id: "LIST" }`);
    expect(upsert).toContain(`{ type: "Books" as const }`);
    const deletion = enhancedEntry(enhanced, 'deleteApiAdminLibraryBooksByBookId');
    expect(deletion).toContain('id: arg.bookId');
    expect(deletion).toContain(`id: "LIST"`);
    // writing GET → mutation that invalidates
    expect(enhancedEntry(enhanced, 'getApiAdminLibraryBooksByBookIdGenerateSummary')).toContain('invalidatesTags');
    // reading POST → query that provides
    expect(enhancedEntry(enhanced, 'postApiAdminLibraryBooksSearch')).toContain('providesTags');
  });

  it('keeps the URL heuristic without x-ddd-entity', () => {
    expect(enhancedEntry(enhanced, 'getApiAdminLibraryAuthorsByAuthorId')).toContain('id: arg.authorId');
    expect(enhancedEntry(enhanced, 'getApiAdminLibraryAuthorsList')).toContain(`id: "LIST"`);
    expect(enhancedEntry(enhanced, 'postApiAdminLibraryBooksByBookIdPublish')).toContain(`invalidatesTags: [{ type: "Books" as const, id: "LIST" }]`);
  });

  it('writes the tag types file', () => {
    const tags = read(app, 'src/api/adminApiTags.ts');
    expect(tags).toContain('export const adminApiTagTypes = ["Authors", "Books"] as const;');
    expect(tags).toContain('export type AdminApiTagType');
    expect(enhanced).toContain(`import { baseApi } from "./baseApi";`);
    expect(enhanced).toContain(`import "./adminApi";`);
  });

  it('uses a text response handler for text-only responses', () => {
    const block = api.slice(api.indexOf('getApiAdminLibraryBooksByBookIdPreview:'));
    expect(block.slice(0, block.indexOf('}),'))).toContain('responseHandler: "text"');
    expect(read(app, 'src/models/_endpoints/GetApiAdminLibraryBooksByBookIdPreviewApiResponse.ts')).toContain('string');
  });

  it('generates code that type-checks', async () => {
    await expect(
      generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipPrettier: true }),
    ).resolves.toMatchObject({ typechecked: true });
  }, 60_000);
});

describe('generateSdk options', () => {
  it('skips POST twins of PATCH upserts with skipUpdatePostTwins', async () => {
    const app = newApp();
    await generateSdk({
      cwd: app,
      config: { skipUpdatePostTwins: true, apis: [apiEntry(SAMPLE_SPEC)] },
      logger: silentLogger,
      skipTsc: true,
    });
    const hooks = hookNames(read(app, 'src/api/adminApi.ts'));
    expect(hooks).toContain('usePatchApiAdminLibraryBooksMutation');
    expect(hooks).not.toContain('usePostApiAdminLibraryBooksMutation');
    expect(hooks).not.toContain('usePostApiAdminLibraryAuthorsMutation');
    expect(hooks).toContain('usePostApiAdminLibraryBooksByBookIdPublishMutation');
  }, 60_000);

  it('applies side-effect overrides from the config', async () => {
    const app = newApp();
    await generateSdk({
      cwd: app,
      config: {
        sideEffects: [{ method: 'POST', path: /\/preview$/, sideEffects: false }],
        apis: [
          apiEntry(SAMPLE_SPEC, { outputFile: './src/api/adminApi.ts' }),
          apiEntry(SAMPLE_SPEC, {
            outputFile: './src/api/legacyApi.ts',
            exportName: 'legacyApi',
            audience: 'admin',
            sideEffects: [{ method: 'POST', path: /\/preview$/, sideEffects: false, endpointType: 'mutation' }],
          }),
        ],
      },
      logger: silentLogger,
      skipTsc: true,
    });
    expect(hookNames(read(app, 'src/api/adminApi.ts'))).toContain('usePostApiAdminLibraryAuthorsPreviewQuery');
    // forced mutation keeps the hook name and invalidates nothing
    expect(hookNames(read(app, 'src/api/legacyApi.ts'))).toContain('usePostApiAdminLibraryAuthorsPreviewMutation');
    expect(enhancedEntry(read(app, 'src/api/legacyApiEnhanced.ts'), 'postApiAdminLibraryAuthorsPreview')).toContain(
      'invalidatesTags: []',
    );
  }, 60_000);

  it('regenerates a single api with --api and keeps the others', async () => {
    const app = newApp();
    const config = {
      apis: [apiEntry(SAMPLE_SPEC), apiEntry(SAMPLE_SPEC, { outputFile: './src/api/otherApi.ts', exportName: 'otherApi', audience: 'admin' })],
    };
    await generateSdk({ cwd: app, config, logger: silentLogger, skipTsc: true });
    const before = read(app, 'src/api/adminApi.ts');
    fs.writeFileSync(path.join(app, 'src/api/otherApi.ts'), '// stale\n');
    const result = await generateSdk({ cwd: app, config, api: 'otherApi', logger: silentLogger });
    expect(result.apis).toEqual(['otherApi']);
    expect(read(app, 'src/api/otherApi.ts')).toContain('useGetApiAdminLibraryBooksListQuery');
    expect(read(app, 'src/api/adminApi.ts')).toBe(before);
    expect(fs.existsSync(path.join(app, 'src/models/App/Domain/Library/Entities/Books/Book.ts'))).toBe(true);
    expect(result.typechecked).toBe(true);
  }, 60_000);

  it('uses a configured base api import for the enhanced file', async () => {
    const app = newApp();
    await generateSdk({
      cwd: app,
      config: { apis: [apiEntry(SAMPLE_SPEC, { baseApiImport: '@/api/baseApi' })] },
      logger: silentLogger,
      skipTsc: true,
      skipPrettier: true,
    });
    expect(read(app, 'src/api/adminApiEnhanced.ts')).toContain(`import { baseApi } from '@/api/baseApi';`);
  }, 60_000);
});

describe('spec validation', () => {
  it('aborts on a spec without SchemaDefinition tag markup', async () => {
    const app = newApp();
    const doc = readSample();
    doc.tags = doc.tags!.map((tag) => ({ name: tag.name, description: `${tag.name} operations` }));
    const promise = generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger: silentLogger });
    await expect(promise).rejects.toBeInstanceOf(SdkGenerationError);
    await expect(promise).rejects.toThrow(/removeSchemaTags/);
    expect(fs.existsSync(path.join(app, 'src/api/adminApi.ts'))).toBe(false);
  });

  it('aborts on an unsupported contract version', async () => {
    const app = newApp();
    const doc = readSample();
    doc.info!['x-ddd-contract'] = { contract: 99, ddd: '9.0.0' };
    await expect(
      generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger: silentLogger }),
    ).rejects.toThrow(/contract 99 is not supported/);
  });

  it('warns once and continues when the contract version is absent', async () => {
    const app = newApp();
    const doc = readSample();
    delete doc.info!['x-ddd-contract'];
    const logger = captureLogger();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger, skipTsc: true, skipPrettier: true });
    expect(logger.warnings.filter((warning) => warning.includes('x-ddd-contract'))).toHaveLength(1);
    expect(fs.existsSync(path.join(app, 'src/api/adminApi.ts'))).toBe(true);
  }, 60_000);

  it('declares undeclared path parameters instead of failing', async () => {
    const app = newApp();
    const doc = readSample();
    const publish = doc.paths!['/api/admin/library/books/{bookId}/publish']!.post!;
    publish.parameters = (publish.parameters as Array<{ in: string }>).filter((parameter) => parameter.in !== 'path');
    const logger = captureLogger();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc))] }, logger, skipTsc: true, skipPrettier: true });
    expect(logger.warnings.some((warning) => warning.includes('bookId not declared'))).toBe(true);
    expect(read(app, 'src/api/adminApi.ts')).toContain('postApiAdminLibraryBooksByBookIdPublish');
  }, 60_000);
});

describe('atomic replace', () => {
  const snapshot = (dir: string): Map<string, string> => {
    const result = new Map<string, string>();
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else result.set(path.relative(dir, full), fs.readFileSync(full, 'utf-8'));
      }
    };
    walk(path.join(dir, 'src'));
    return result;
  };

  it('leaves the previous output intact when generation fails', async () => {
    const app = newApp();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipTsc: true });
    const before = snapshot(app);

    const broken = readSample();
    broken.paths!['/api/admin/library/books/list']!.get!.responses = {
      200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Does.Not.Exist' } } } },
    };
    await expect(
      generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, broken))] }, logger: silentLogger, skipTsc: true }),
    ).rejects.toThrow();
    expect(snapshot(app)).toEqual(before);
    expect(fs.readdirSync(app).filter((name) => name.startsWith('.ddd-web-sdk-'))).toEqual([]);
  }, 60_000);

  it('restores the previous output when the type check fails', async () => {
    const app = newApp();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipTsc: true });
    fs.writeFileSync(
      path.join(app, 'src', 'consumer.ts'),
      "import { useGetApiAdminLibraryAuthorsListQuery } from './api/adminApi';\nexport const hook = useGetApiAdminLibraryAuthorsListQuery;\n",
    );
    const before = snapshot(app);

    const reduced = readSample();
    delete reduced.paths!['/api/admin/library/authors/list'];
    await expect(
      generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, reduced))] }, logger: silentLogger }),
    ).rejects.toThrow(/Type check failed/);
    expect(snapshot(app)).toEqual(before);
    expect(fs.readdirSync(app).filter((name) => name.startsWith('.ddd-web-sdk-'))).toEqual([]);
  }, 60_000);

  it('removes models that are no longer generated', async () => {
    const app = newApp();
    await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipTsc: true });
    const stale = path.join(app, 'src/models/App/Domain/Old/Stale.ts');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'export type Stale = {};\n');
    await generateSdk({ cwd: app, config: { apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipTsc: true });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(app, 'src/api/baseApi.ts'))).toBe(true);
  }, 60_000);
});
