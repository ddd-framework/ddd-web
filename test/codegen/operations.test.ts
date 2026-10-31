import { describe, expect, it } from 'vitest';
import { hasSideEffects, type DddEntityInfo } from '../../src/contract';
import { HTTP_METHODS, type DddEntityExtension, type OpenApiDocument } from '../../src/codegen/openapi';
import { indexOperations } from '../../src/codegen/operations';

// The codegen's tolerant input type derives from the contract type: a contract value is always accepted.
const contractEntity: DddEntityInfo = { schema: 'App.Domain.X.Entities.Items.Item', action: 'upsert', derived: true };
const asInput: DddEntityExtension = contractEntity;

const op = (extra: Record<string, unknown> = {}) => ({ summary: 'Upsert item', responses: { 200: {} }, ...extra });

describe('indexOperations', () => {
  it('uses the contract default for side effects on every HTTP method', () => {
    const item = Object.fromEntries(HTTP_METHODS.map((method) => [method, op()]));
    const index = indexOperations({ paths: { '/x': item } } as OpenApiDocument, [], false);
    for (const method of HTTP_METHODS) {
      expect(index.byKey.get(`${method.toUpperCase()} /x`)!.sideEffects, method).toBe(hasSideEffects(method));
    }
    expect(index.byKey.get('OPTIONS /x')!.sideEffects).toBe(false);
    expect(asInput.schema).toBe(contractEntity.schema);
  });

  it('matches RegExp overrides with g / y flags statelessly', () => {
    const doc = { paths: { '/a': { get: op() }, '/b': { get: op() }, '/c': { get: op() } } } as unknown as OpenApiDocument;
    for (const flags of ['g', 'y', 'gy']) {
      const index = indexOperations(doc, [{ path: new RegExp('^/', flags), sideEffects: true }], false);
      expect(['/a', '/b', '/c'].map((path) => index.byKey.get(`GET ${path}`)!.sideEffects), flags).toEqual([true, true, true]);
    }
  });

  describe('skipUpdatePostTwins', () => {
    const body = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } };
    const doc = (post: Record<string, unknown>, patch: Record<string, unknown>) =>
      ({ paths: { '/items': { post: op(post), patch: op(patch) } } }) as unknown as OpenApiDocument;
    const skipped = (document: OpenApiDocument) => indexOperations(document, [], true).skippedTwins.has('POST /items');
    const entity = (action: string) => ({ 'x-ddd-entity': { schema: 'App.Domain.X.Entities.Items.Item', action } });

    it('skips an unannotated POST identical to the PATCH', () => {
      expect(skipped(doc({ requestBody: body }, { requestBody: body }))).toBe(true);
    });

    it('keeps an unannotated POST whose request, parameters or responses differ', () => {
      expect(skipped(doc({ requestBody: body }, {}))).toBe(false);
      expect(skipped(doc({ parameters: [{ name: 'dry', in: 'query' }] }, {}))).toBe(false);
      expect(skipped(doc({ responses: { 201: {} } }, {}))).toBe(false);
    });

    it('keeps a POST annotated as action next to an upsert PATCH with the same summary', () => {
      expect(skipped(doc({ ...entity('action'), requestBody: body }, { ...entity('upsert'), requestBody: body }))).toBe(false);
    });

    it('skips a POST annotated as upsert of the same entity', () => {
      expect(skipped(doc({ ...entity('upsert') }, { ...entity('upsert') }))).toBe(true);
    });

    it('keeps the POST when the side-effect classification differs', () => {
      expect(skipped(doc({ 'x-ddd-side-effects': false }, {}))).toBe(false);
    });
  });
});
