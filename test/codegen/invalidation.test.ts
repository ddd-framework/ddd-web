import { afterEach, describe, expect, it } from 'vitest';
import { broadInvalidation, generateSdk, silentLogger } from '../../src/codegen/index';
import type { InvalidationOperation, InvalidationResolver } from '../../src/codegen/index';
import { identityBodyPath, identityPathParameter } from '../../src/codegen/enhance';
import type { OpenApiDocument, OpenApiOperation } from '../../src/codegen/openapi';
import { apiEntry, createApp, enhancedEntry, read, readSample, removeApp, SAMPLE_SPEC, writeSpec } from './helpers';

const apps: string[] = [];
const newApp = (): string => {
  const dir = createApp();
  apps.push(dir);
  return dir;
};
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

describe('identityPathParameter', () => {
  it.each([
    ['/api/admin/library/books/{bookId}', 'Books', 'bookId'],
    ['/api/admin/library/books/{bookId}/publish', 'Books', 'bookId'],
    ['/api/admin/library/books/{id}', 'Books', 'id'],
    ['/api/admin/library/books/{slug}', 'Books', 'slug'],
    ['/api/admin/library/books/{uuid}', 'Books', 'uuid'],
    ['/api/admin/library/books/{book_id}/archive', 'Books', 'book_id'],
    ['/api/admin/catalog/categories/{categoryId}/archive', 'Categories', 'categoryId'],
    ['/api/admin/library/shelves/{shelfId}/books/{bookId}', 'Books', 'bookId'],
    ['/api/admin/library/authors/{authorId}/books/{bookId}/remove', 'Authors', 'authorId'],
    ['/api/admin/library/bookClubs/{bookClubId}', 'BookClubs', 'bookClubId'],
  ])('%s (%s) → %s', (path, tag, expected) => {
    expect(identityPathParameter(path, tag)).toBe(expected);
  });

  it.each([
    ['/api/admin/library/books', 'Books'],
    ['/api/admin/library/books/{authorId}/importFromFile', 'Books'],
    ['/api/admin/library/books/byAuthor/{authorId}', 'Books'],
    ['/api/admin/library/loans/book/{bookId}/extend', 'Loans'],
  ])('%s (%s) has no identity', (path, tag) => {
    expect(identityPathParameter(path, tag)).toBeNull();
  });
});

describe('identityBodyPath', () => {
  const entity = (name: string) => ({ $ref: `#/components/schemas/App.Domain.Library.Entities.${name}` });
  const doc = {
    components: {
      schemas: {
        'App.Domain.Library.Entities.Books.Book': { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } } },
        'App.Domain.Library.Entities.Books.Books': { type: 'object', properties: { elements: { type: 'array' } } },
        'App.Domain.Library.Entities.Authors.Author': { type: 'object', properties: { id: { type: 'integer' } } },
        'App.Domain.Library.Entities.Books.BookDraft': { type: 'object', properties: { title: { type: 'string' } } },
        Update: { type: 'object', properties: { book: entity('Books.Book') } },
        UpdateNullable: { type: 'object', properties: { book: { allOf: [entity('Books.Book')], nullable: true } } },
        Merge: { type: 'object', properties: { bookToKeep: entity('Books.Book'), booksToMerge: entity('Books.Books') } },
        Pair: { type: 'object', properties: { left: entity('Books.Book'), right: entity('Books.Book') } },
        WithList: { type: 'object', properties: { book: entity('Books.Book'), more: { type: 'array', items: entity('Books.Book') } } },
        Assign: { type: 'object', properties: { author: entity('Authors.Author') } },
        Draft: { type: 'object', properties: { draft: entity('Books.BookDraft') } },
      },
    },
  } as unknown as OpenApiDocument;
  const lookup = new Map([
    ['books', 'Books'],
    ['authors', 'Authors'],
  ]);
  const operation = (schema: Record<string, unknown>): OpenApiOperation => ({
    requestBody: { content: { 'application/json': { schema } } },
  });
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

  it('reads `<entity>.id` from the request DTO', () => {
    expect(identityBodyPath(doc, operation(ref('Update')), 'Books', lookup)).toBe('book.id');
    expect(identityBodyPath(doc, operation(ref('UpdateNullable')), 'Books', lookup)).toBe('book.id');
  });

  it('reads `id` when the body is the entity itself', () => {
    expect(identityBodyPath(doc, operation(entity('Books.Book')), 'Books', lookup)).toBe('id');
  });

  it('finds no identity when the body carries several entities of the tag, a set or a list', () => {
    expect(identityBodyPath(doc, operation(ref('Merge')), 'Books', lookup)).toBeNull();
    expect(identityBodyPath(doc, operation(ref('Pair')), 'Books', lookup)).toBeNull();
    expect(identityBodyPath(doc, operation(ref('WithList')), 'Books', lookup)).toBeNull();
  });

  it('finds no identity for an entity of another tag or an entity without id', () => {
    expect(identityBodyPath(doc, operation(ref('Assign')), 'Books', lookup)).toBeNull();
    expect(identityBodyPath(doc, operation(ref('Draft')), 'Books', lookup)).toBeNull();
    expect(identityBodyPath(doc, {}, 'Books', lookup)).toBeNull();
  });
});

describe('broadInvalidation', () => {
  const base: InvalidationOperation = {
    key: 'k',
    api: 'adminApi',
    method: 'POST',
    path: '/x',
    tag: 'Books',
    sideEffects: true,
    pathArgs: {},
    defaultTags: [],
  };

  it('invalidates LIST + the whole tag type like 0.2', () => {
    expect(broadInvalidation(base)).toEqual([{ type: 'Books', id: 'LIST' }, 'Books']);
    expect(broadInvalidation({ ...base, entity: { schema: 'S', action: 'upsert', identity: 'body:book.id' } })).toEqual([
      { type: 'Books', id: 'LIST' },
      'Books',
    ]);
  });

  it('keeps the default for path identities from x-ddd-entity, side-effect-free mutations and untagged endpoints', () => {
    expect(broadInvalidation({ ...base, entity: { schema: 'S', action: 'delete', identity: 'path:bookId' } })).toBeUndefined();
    expect(broadInvalidation({ ...base, sideEffects: false })).toBeUndefined();
    expect(broadInvalidation({ ...base, tag: null })).toBeUndefined();
  });
});

describe('invalidation resolver', () => {
  it('overrides the generated tags, undefined keeps the default, the api entry resolver wins', async () => {
    const app = newApp();
    const seen: InvalidationOperation[] = [];
    const global: InvalidationResolver = (operation) => {
      seen.push(operation);
      if (operation.key === 'postApiAdminLibraryAuthorsMerge') return [{ type: 'Authors', id: 'LIST' }, { type: 'Books', id: 'LIST' }];
      if (operation.key === 'patchApiAdminLibraryAuthors') return ['Authors'];
      return undefined;
    };
    const perApi: InvalidationResolver = (operation) =>
      operation.key === 'patchApiAdminLibraryAuthors' ? [{ type: 'Authors', arg: operation.pathArgs.authorId ?? 'appPresentationApiAdminLibraryDtosAuthorsAuthorUpdateRequestDto.author.id' }, { type: 'AuthorStats', id: 'LIST' }] : undefined;
    await generateSdk({
      cwd: app,
      config: { invalidation: global, apis: [apiEntry(SAMPLE_SPEC, { invalidation: perApi })] },
      logger: silentLogger,
    });
    const enhanced = read(app, 'src/api/adminApiEnhanced.ts');
    expect(enhancedEntry(enhanced, 'postApiAdminLibraryAuthorsMerge')).toContain(
      `invalidatesTags: [ { type: "Authors" as const, id: "LIST" }, { type: "Books" as const, id: "LIST" }, ]`,
    );
    const patch = enhancedEntry(enhanced, 'patchApiAdminLibraryAuthors');
    expect(patch).toContain('tagWithId(');
    expect(patch).toContain(`{ type: "AuthorStats" as const, id: "LIST" }`);
    // a tag type introduced by the resolver is registered
    expect(enhanced).toMatch(/addTagTypes: \[[^\]]*"AuthorStats"/);
    expect(read(app, 'src/api/adminApiTags.ts')).toContain('"AuthorStats"');
    // undefined keeps the default
    expect(enhancedEntry(enhanced, 'deleteApiAdminLibraryAuthorsByAuthorIdPortrait')).toContain('id: arg.authorId }');

    const merge = seen.find((operation) => operation.key === 'postApiAdminLibraryAuthorsMerge')!;
    expect(merge).toMatchObject({ api: 'adminApi', method: 'POST', path: '/api/admin/library/authors/merge', tag: 'Authors', sideEffects: true });
    expect(merge.defaultTags).toEqual([{ type: 'Authors', id: 'LIST' }, 'Authors']);
    expect(merge.bodyArg).toBe('appPresentationApiAdminLibraryDtosAuthorsAuthorMergeRequestDto');
    const portrait = seen.find((operation) => operation.key === 'deleteApiAdminLibraryAuthorsByAuthorIdPortrait')!;
    expect(portrait.pathArgs).toEqual({ authorId: 'authorId' });
    expect(portrait.defaultTags).toEqual([{ type: 'Authors', arg: 'authorId' }, { type: 'Authors', id: 'LIST' }]);
    // only mutations reach the resolver
    expect(seen.some((operation) => operation.key === 'getApiAdminLibraryAuthorsList')).toBe(false);
  }, 60_000);

  it('restores the 0.2 output with broadInvalidation', async () => {
    const app = newApp();
    await generateSdk({ cwd: app, config: { invalidation: broadInvalidation, apis: [apiEntry(SAMPLE_SPEC)] }, logger: silentLogger, skipTsc: true });
    const enhanced = read(app, 'src/api/adminApiEnhanced.ts');
    const broad = `invalidatesTags: [ { type: "Authors" as const, id: "LIST" }, { type: "Authors" as const }, ]`;
    for (const key of ['postApiAdminLibraryAuthors', 'patchApiAdminLibraryAuthors', 'deleteApiAdminLibraryAuthorsByAuthorId', 'deleteApiAdminLibraryAuthorsByAuthorIdPortrait']) {
      expect(enhancedEntry(enhanced, key), key).toContain(broad);
    }
    // x-ddd-entity path identities stay narrow, as in 0.2
    expect(enhancedEntry(enhanced, 'deleteApiAdminLibraryBooksByBookId')).toContain('id: arg.bookId }');
    expect(enhanced).not.toContain('tagWithId');
  }, 60_000);

  it('aborts on an invalid resolver result', async () => {
    const app = newApp();
    await expect(
      generateSdk({
        cwd: app,
        config: { invalidation: () => [{ type: 'Books', arg: 'not a path' }], apis: [apiEntry(SAMPLE_SPEC)] },
        logger: silentLogger,
        skipTsc: true,
      }),
    ).rejects.toThrow(/needs either an id .* or an arg/);
  }, 60_000);

  it('reads a body identity from the argument itself with flattenArg', async () => {
    const app = newApp();
    const doc = readSample();
    // body-only upsert: flattenArg makes the argument the body
    for (const method of ['patch', 'post'] as const) {
      const operation = doc.paths!['/api/admin/library/authors']![method]!;
      operation.parameters = [];
    }
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, doc), { flattenArg: true })] }, logger: silentLogger });
    const patch = enhancedEntry(read(app, 'src/api/adminApiEnhanced.ts'), 'patchApiAdminLibraryAuthors');
    expect(patch).toContain('arg?.author?.id');
  }, 60_000);
});
