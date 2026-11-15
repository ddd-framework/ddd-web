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

/** Two models with one name in two folders, an objectType, a dash enum and an enum on an array schema. */
const specForRcDryRun = () => {
  const doc = specWithDocumentNames();
  const schemas = doc.components!.schemas!;
  schemas['App.Domain.Money.Currency'] = { type: 'object', properties: { code: { type: 'string' } } };
  schemas['App.Domain.Common.Currency'] = { type: 'object', properties: { symbol: { type: 'string' } } };
  const message = schemas[`${MESSAGES}.AIConversationMessage`] as { properties: Record<string, unknown> };
  message.properties.price = { $ref: '#/components/schemas/App.Domain.Money.Currency' };
  message.properties.display = { $ref: '#/components/schemas/App.Domain.Common.Currency' };
  message.properties.objectType = { type: 'string', nullable: true };
  message.properties.realtimeModel = { type: 'string', enum: ['gpt-realtime', 'gpt-realtime-mini'] };
  message.properties.platforms = { type: 'array', enum: ['facebook', 'instagram'], items: { type: 'string' } };
  return doc;
};

describe('generateSdk — models for a whole client tree (index, objectType, wide enums)', () => {
  it('exports each schema name in its folder, aliases where it repeats, writes no barrel', async () => {
    const app = createApp();
    apps.push(app);
    await generateSdk({
      cwd: app,
      config: {
        apis: [apiEntry(writeSpec(app, specForRcDryRun()))],
        models: { naming: 'document', enums: 'const', enumPropertyType: 'wide', objectType: 'const', nullableRefs: true, idType: 'number', index: false },
      },
      logger: silentLogger,
    });
    expect(read(app, 'src/models/App/Domain/Money/Currency.ts')).toMatch(/export type Currency\b/);
    expect(read(app, 'src/models/App/Domain/Common/Currency.ts')).toMatch(/export type Currency\b/);
    expect(fs.existsSync(path.join(app, 'src/models/index.ts'))).toBe(false);
    const message = read(app, 'src/models/App/Domain/AI/Entities/Conversations/Messages/AIConversationMessage.ts')
      .replace(/\s+/g, ' ').replace(/< /g, '<').replace(/ >/g, '>').replace(/: \| /g, ': ');
    expect(message).toMatch(/import \{ Currency( as \w+)? \} from "[^"]*Money\/Currency"/);
    expect(message).toMatch(/import \{ Currency as \w+ \} from "[^"]*Common\/Currency"|import \{ Currency as \w+ \} from "[^"]*Money\/Currency"/);
    expect(message).toContain('App_Domain_AI_Entities_Conversations_Messages_AIConversationMessage: "App\\\\Domain\\\\AI\\\\Entities\\\\Conversations\\\\Messages\\\\AIConversationMessage"');
    expect(message).toMatch(/ objectType: \(typeof AIConversationMessageObjectType\)\[keyof typeof AIConversationMessageObjectType\] \| null;/);
    expect(message).toMatch(/status\?: \(typeof AIConversationMessageStatus\)\[keyof typeof AIConversationMessageStatus\] \| null/);
    expect(message).toContain('gptRealtime: "gpt-realtime"');
    expect(message).toContain('gptRealtimeMini: "gpt-realtime-mini"');
    expect(message).toMatch(/platforms\?: Array<\(typeof AIConversationMessagePlatforms\)\[keyof typeof AIConversationMessagePlatforms\]>/);
    expect(read(app, 'src/api/adminApi.ts')).not.toMatch(/from ["']\.\.\/models["']/);
  }, 60_000);
});

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

describe('generateSdk — two documents and models.scope', () => {
  const options = { naming: 'document', enums: 'const', index: false } as const;

  it('takes the enum consts of a shared model from the first-listed document, as its properties', async () => {
    const app = createApp();
    apps.push(app);
    const first = specWithDocumentNames();
    const second = specWithDocumentNames();
    const statusOf = (doc: ReturnType<typeof specWithDocumentNames>) =>
      ((doc.components!.schemas![`${MESSAGES}.AIConversationMessage`] as { properties: Record<string, { enum?: string[] }> }).properties.status!);
    statusOf(second).enum = ['PENDING'];
    await generateSdk({
      cwd: app,
      config: {
        apis: [
          apiEntry(writeSpec(app, first, 'first.json')),
          apiEntry(writeSpec(app, second, 'second.json'), { outputFile: './src/api/clientApi.ts', exportName: 'clientApi' }),
        ],
        models: options,
      },
      logger: silentLogger,
    });
    const message = read(app, 'src/models/App/Domain/AI/Entities/Conversations/Messages/AIConversationMessage.ts');
    expect(message).toContain('CANCEL_REQUESTED: "CANCEL_REQUESTED"');
  }, 90_000);

  it("writes the models of every operation with scope 'all', while the endpoint filter keeps the api file small", async () => {
    const app = createApp();
    apps.push(app);
    await generateSdk({
      cwd: app,
      config: {
        apis: [apiEntry(writeSpec(app, specWithDocumentNames()), { filterEndpoints: [/BooksList/] })],
        models: { ...options, scope: 'all' },
      },
      logger: silentLogger,
    });
    expect(fs.existsSync(path.join(app, 'src/models/App/Domain/AI/Entities/Conversations/Messages/AIConversationMessage.ts'))).toBe(true);
    const api = read(app, 'src/api/adminApi.ts');
    expect(api).not.toMatch(/AiMessages/);
    expect(fs.readdirSync(path.join(app, 'src/models/_endpoints')).some((file) => /AiMessages/.test(file))).toBe(false);
  }, 90_000);
});
