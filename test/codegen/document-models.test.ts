import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateSdk, silentLogger } from '../../src/codegen/index';
import { apiEntry, createApp, read, readSample, removeApp, writeSpec } from './helpers';

const apps: string[] = [];
afterEach(() => {
  while (apps.length) removeApp(apps.pop()!);
});

const BOOK = 'App.Domain.Library.Entities.Books.Book';
const MESSAGES = 'App.Domain.AI.Entities.Conversations.Messages';

/** The sample spec with an acronym schema, an enum, a nullable `$ref` and a name a neighbour namespace prefixes. */
const specWithDocumentNames = () => {
  const doc = readSample();
  const schemas = doc.components!.schemas!;
  schemas[`${MESSAGES}.AIConversationMessage`] = {
    type: 'object',
    properties: {
      id: { nullable: true, oneOf: [{ type: 'string' }, { type: 'integer' }] },
      status: { type: 'string', nullable: true, enum: ['PENDING', 'CANCEL_REQUESTED', 'in progress'] },
      channels: { type: 'array', items: { type: 'string', enum: ['MAIL', 'SMS'] } },
      delegationResults: { $ref: `#/components/schemas/${MESSAGES}.DelegationResults` },
      book: { nullable: true, $ref: `#/components/schemas/${BOOK}` },
      lastDelegation: { $ref: `#/components/schemas/${MESSAGES}.Delegation.DelegationResult` },
    },
  };
  schemas[`${MESSAGES}.DelegationResults`] = { type: 'object', properties: { count: { type: 'integer' } } };
  schemas[`${MESSAGES}.Delegation.DelegationResult`] = { type: 'object', properties: { ok: { type: 'boolean' } } };
  doc.tags = [
    ...(doc.tags ?? []),
    ...[`${MESSAGES}.AIConversationMessage`, `${MESSAGES}.DelegationResults`, `${MESSAGES}.Delegation.DelegationResult`].map((key) => ({
      name: key.split('.').pop()!,
      description: `<SchemaDefinition schemaRef="#/components/schemas/${key}" />`,
    })),
  ];
  // one endpoint returns the message, so the models are generated
  doc.paths!['/api/admin/ai/messages/{messageId}'] = {
    get: {
      tags: ['AIConversationMessages'],
      parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/${MESSAGES}.AIConversationMessage` } } } } },
    },
  };
  return doc;
};

describe('generateSdk — models as the document writes them (models option)', () => {
  it('names and places by the schema name, enums as const objects, | null beside a nullable $ref, the id type', async () => {
    const app = createApp();
    apps.push(app);
    const schemaFile = writeSpec(app, specWithDocumentNames());
    await generateSdk({
      cwd: app,
      config: { apis: [apiEntry(schemaFile)], models: { naming: 'document', enums: 'const', nullableRefs: true, idType: 'number' } },
      logger: silentLogger,
    });
    const folder = 'src/models/App/Domain/AI/Entities/Conversations/Messages';
    const message = read(app, `${folder}/AIConversationMessage.ts`).replace(/\s+/g, ' ').replace(/< /g, '<').replace(/ >/g, '>').replace(/: \| /g, ': ');
    expect(message).toMatch(/export type AIConversationMessage\b/);
    expect(message).toMatch(/id\?: number \| null/);
    expect(message).toMatch(/status\?: \(typeof AIConversationMessageStatusStrict\)\[keyof typeof AIConversationMessageStatusStrict\] \| null/);
    expect(message).toMatch(/channels\?: Array<\(typeof AIConversationMessageChannelsStrict\)\[keyof typeof AIConversationMessageChannelsStrict\]>/);
    expect(message).toContain('export const AIConversationMessageStatus = {');
    expect(message).toContain('CANCEL_REQUESTED: "CANCEL_REQUESTED",');
    expect(message).toContain('in_progress: "in progress",');
    expect(message).toMatch(/export const AIConversationMessageStatusStrict = \{[\s\S]*?\} as const;/);
    expect(message).toMatch(/book\?: Book \| null/);
    expect(message).toMatch(/delegationResults\?: DelegationResults;/);
    expect(fs.existsSync(path.join(app, folder, 'DelegationResults.ts'))).toBe(true);
    expect(fs.existsSync(path.join(app, folder, 'Delegation/DelegationResult.ts'))).toBe(true);
    expect(read(app, 'src/models/App/Domain/Library/Entities/Books/Book.ts')).toMatch(/author\?: Author \| null/);
    expect(read(app, 'src/models/index.ts')).toContain('AIConversationMessage');
  }, 60_000);

  it('keeps the RTK output without the option', async () => {
    const app = createApp();
    apps.push(app);
    await generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, specWithDocumentNames()))] }, logger: silentLogger });
    const message = read(app, 'src/models/App/Domain/AI/Entities/Conversations/Messages/AiConversationMessage.ts');
    expect(message).toMatch(/export type AiConversationMessage\b/);
    expect(message).not.toContain('export const');
  }, 60_000);

  it('refuses enum consts without document naming', async () => {
    const app = createApp();
    apps.push(app);
    await expect(
      generateSdk({ cwd: app, config: { apis: [apiEntry(writeSpec(app, specWithDocumentNames()))], models: { enums: 'const' } }, logger: silentLogger }),
    ).rejects.toThrow(/needs models.naming 'document'/);
  });
});
