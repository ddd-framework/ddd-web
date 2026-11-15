import type TypeScript from 'typescript';
import type { OpenApiDocument } from './openapi';
import { loadTypeScript } from './typescript';

/** How the generator writes the models of the document's component schemas. Every option is off by default. */
export interface ModelOptions {
  /**
   * `document`: a model is named and placed by its schema name as the document writes it — the last dot segment is
   * the model name, unchanged (`AIConversationMessage`, not `AiConversationMessage`), the segments before it are the
   * folders; a folder that happens to prefix the last segment never splits it (`…Messages.DelegationResults` stays
   * `DelegationResults` beside a `…Messages.Delegation` namespace). `rtk` (default): RTK codegen's names, placed by the
   * namespace registry.
   */
  naming?: 'rtk' | 'document';
  /**
   * `const`: an enum property becomes two exported objects in its model's file, `<Model><Property>` and
   * `<Model><Property>Strict` (`as const`), keyed by the enum values; the property is typed from the Strict object
   * (`(typeof XStrict)[keyof typeof XStrict]`, `| null` when the property is nullable). `union` (default): the inline
   * union of RTK codegen. Needs `naming: 'document'` (the const names start with the document's model name).
   */
  enums?: 'union' | 'const';
  /** `| null` beside a `$ref` whose property is nullable (RTK codegen drops it). Default `false`. */
  nullableRefs?: boolean;
  /**
   * The type of an `id` property the document declares as `string | integer`: `number` or `string`. Default
   * `document` (the union as declared).
   */
  idType?: 'document' | 'number' | 'string';
}

/** The component schema behind one RTK type name. */
export interface DocumentModel {
  /** The schema's key in `components.schemas`, e.g. `DDD.Domain.AI.Entities.Conversations.Messages.AIConversationMessage`. */
  schemaKey: string;
  schema: SchemaObject;
}

type SchemaObject = Record<string, unknown> & {
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  enum?: unknown[];
  oneOf?: SchemaObject[];
  nullable?: boolean;
  $ref?: string;
  type?: string;
};

/** The title RTK codegen names a component schema after (`O(title)` keeps `DddModel12` as it is). */
const titleOfSchema = (index: number): string => `DddModel${index}`;

const isObject = (value: unknown): value is SchemaObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The document RTK codegen reads, with the model options applied, and the component schema behind each RTK type name
 * (empty unless `naming: 'document'`). The document passed in stays unchanged.
 */
export function prepareDocumentForModels(
  doc: OpenApiDocument,
  options: ModelOptions,
): { doc: OpenApiDocument; documentModels: Map<string, DocumentModel> } {
  const documentModels = new Map<string, DocumentModel>();
  const naming = options.naming === 'document';
  const enumConsts = options.enums === 'const';
  if (!naming && !enumConsts && !options.nullableRefs && (options.idType ?? 'document') === 'document') {
    return { doc, documentModels };
  }
  const prepared = structuredClone(doc) as OpenApiDocument;
  const schemas = prepared.components?.schemas ?? {};
  const original = doc.components?.schemas ?? {};
  Object.keys(schemas).forEach((schemaKey, index) => {
    const schema = schemas[schemaKey];
    if (!isObject(schema)) return;
    // RTK codegen names a schema after its title: a title of our own maps the type name back to the schema
    if (naming) {
      schema.title = titleOfSchema(index);
      documentModels.set(titleOfSchema(index), { schemaKey, schema: original[schemaKey] as SchemaObject });
    }
    for (const [propertyName, property] of Object.entries(schema.properties ?? {})) {
      if (!isObject(property)) continue;
      if (options.nullableRefs && typeof property.$ref === 'string' && property.nullable === true) {
        // a `$ref` carries no `nullable` for RTK codegen; inside `allOf` it does
        schema.properties![propertyName] = { allOf: [{ $ref: property.$ref }], nullable: true };
        continue;
      }
      const idType = options.idType ?? 'document';
      if (propertyName === 'id' && idType !== 'document' && isStringOrIntegerUnion(property)) {
        schema.properties![propertyName] = {
          type: idType === 'number' ? 'integer' : 'string',
          ...(isNullable(property) ? { nullable: true } : {}),
        };
      }
    }
  });
  return { doc: prepared, documentModels };
}

function isStringOrIntegerUnion(property: SchemaObject): boolean {
  const types = new Set((property.oneOf ?? []).map((variant) => (isObject(variant) ? variant.type : undefined)));
  return types.has('string') && (types.has('integer') || types.has('number'));
}

function isNullable(property: SchemaObject): boolean {
  return property.nullable === true || (property.oneOf ?? []).some((variant) => isObject(variant) && variant.nullable === true);
}

/** Where a model of `naming: 'document'` lives: the schema name's segments before the last, and the last one. */
export function placeDocumentModel(model: DocumentModel): { segments: string[]; leafName: string } {
  const parts = model.schemaKey.split('.');
  return { segments: parts.slice(0, -1), leafName: parts[parts.length - 1]! };
}

/** The RTK type name of a document model and its read/write variant suffix (`DddModel12Read` → `DddModel12`, `Read`). */
export function findDocumentModel(
  rtkName: string,
  documentModels: ReadonlyMap<string, DocumentModel>,
): { model: DocumentModel; suffix: string } | null {
  const match = rtkName.match(/^(DddModel\d+)(Read|Write)?$/);
  const model = match ? documentModels.get(match[1]!) : undefined;
  return model ? { model, suffix: match![2] ?? '' } : null;
}

/** The key an enum value gets in its const object: spaces, `/` and `\` become `_`, an empty value `EMPTY`. */
export function enumKeyOf(value: string): string {
  if (value.trim() === '') return 'EMPTY';
  const key = value.replace(/[ /\\]+/g, '_');
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * The enum const objects of a model and its body with every enum property typed from them (`enums: 'const'`).
 * Covers a property's own `enum` and the `enum` of its array items.
 */
export function applyEnumConsts(body: string, modelName: string, schema: SchemaObject): { body: string; consts: Map<string, string> } {
  const consts = new Map<string, string>();
  const typeTexts = new Map<string, string>();
  for (const [propertyName, property] of Object.entries(schema.properties ?? {})) {
    if (!isObject(property)) continue;
    const isArray = isObject(property.items) && Array.isArray(property.items.enum);
    const values = (isArray ? property.items!.enum : property.enum)?.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
    if (!values || values.length === 0) continue;
    const constName = `${modelName}${propertyName.charAt(0).toUpperCase()}${propertyName.slice(1)}`;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(constName)) continue;
    const members = [...new Set(values.map(String))].map((value) => `  ${enumKeyOf(value)}: ${JSON.stringify(value)},`).join('\n');
    consts.set(constName, `export const ${constName} = {\n${members}\n};\n\nexport const ${constName}Strict = {\n${members}\n} as const;`);
    const memberType = `(typeof ${constName}Strict)[keyof typeof ${constName}Strict]`;
    const nullable = property.nullable === true || (property.enum ?? []).includes(null);
    typeTexts.set(propertyName, `${isArray ? `Array<${memberType}>` : memberType}${nullable ? ' | null' : ''}`);
  }
  return { body: replacePropertyTypes(body, typeTexts), consts };
}

/** The body with the types of the named properties of its first type declaration replaced. */
function replacePropertyTypes(body: string, typeTexts: ReadonlyMap<string, string>): string {
  if (typeTexts.size === 0) return body;
  const ts: typeof TypeScript = loadTypeScript();
  const sourceFile = ts.createSourceFile('model.ts', body, ts.ScriptTarget.Latest, true);
  const declaration = sourceFile.statements.find(
    (statement): statement is TypeScript.TypeAliasDeclaration | TypeScript.InterfaceDeclaration =>
      ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement),
  );
  if (!declaration) return body;
  const members = ts.isInterfaceDeclaration(declaration)
    ? declaration.members
    : ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members
      : ts.isIntersectionTypeNode(declaration.type)
        ? declaration.type.types.flatMap((part) => (ts.isTypeLiteralNode(part) ? [...part.members] : []))
        : [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(sourceFile);
    const text = typeTexts.get(name);
    if (text !== undefined) replacements.push({ start: member.type.getStart(sourceFile), end: member.type.getEnd(), text });
  }
  let result = body;
  for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}
