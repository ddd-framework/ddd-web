import type TypeScript from 'typescript';
import type { EndpointInfo } from './endpoints';
import type { Logger } from './log';
import type { OpenApiDocument } from './openapi';
import { listOperations, operationKey } from './openapi';
import { DDD_WEB_API_IMPORT, isBuildCall, propertyName, queryReturnObject } from './response-handlers';
import { loadTypeScript } from './typescript';

/** Name of the endpoint argument that carries the file parts. */
export const MULTIPART_FILES_ARG = 'multipartFiles';

/** Form field of the JSON envelope in a DDD multipart request; never a file field. */
const BODY_FIELD = 'body';

const FILE_PART_TYPE = '(Blob | { uri: string; name: string; type: string })';

/** The multipart side of one operation. */
export interface MultipartOperation {
  /** Form fields that carry files. */
  fields: string[];
  /** File fields the operation requires. */
  required: string[];
  /** True when the operation accepts no JSON body next to the multipart one. */
  multipartOnly: boolean;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

function resolveRef(doc: OpenApiDocument, value: unknown): JsonObject | undefined {
  let current = value;
  for (let depth = 0; depth < 5 && isObject(current) && typeof current.$ref === 'string'; depth++) {
    const segments = current.$ref.replace(/^#\//, '').split('/');
    let target: unknown = doc;
    for (const segment of segments) target = isObject(target) ? target[segment.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    current = target;
  }
  return isObject(current) ? current : undefined;
}

const isJsonMediaType = (type: string): boolean => /(^|\/|\+)json$/.test(type.split(';')[0]!.trim().toLowerCase());

/** The file fields of an operation's `multipart/form-data` request body, or `null` when it has none. */
export function readMultipartOperation(doc: OpenApiDocument, requestBody: unknown): MultipartOperation | null {
  const content = resolveRef(doc, requestBody)?.content;
  if (!isObject(content)) return null;
  const multipartKey = Object.keys(content).find((type) => type.split(';')[0]!.trim().toLowerCase() === 'multipart/form-data');
  if (!multipartKey || !isObject(content[multipartKey])) return null;
  const schema = resolveRef(doc, (content[multipartKey] as JsonObject).schema);
  const properties = isObject(schema?.properties) ? schema.properties : {};
  const fields = Object.keys(properties).filter((name) => name !== BODY_FIELD);
  if (fields.length === 0) return null;
  const requiredList = Array.isArray(schema?.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [];
  return {
    fields,
    required: fields.filter((name) => requiredList.includes(name)),
    multipartOnly: !Object.keys(content).some(isJsonMediaType),
  };
}

/** Multipart operations per generated endpoint key. */
export function detectMultipartEndpoints(doc: OpenApiDocument, endpoints: EndpointInfo[]): Map<string, MultipartOperation> {
  const byOperation = new Map<string, MultipartOperation>();
  for (const { method, path, operation } of listOperations(doc)) {
    const multipart = readMultipartOperation(doc, operation.requestBody);
    if (multipart) byOperation.set(operationKey(method, path), multipart);
  }
  const keys = new Map<string, MultipartOperation>();
  if (byOperation.size === 0) return keys;
  for (const endpoint of endpoints) {
    const multipart = byOperation.get(operationKey(endpoint.method, endpoint.path));
    if (multipart) keys.set(endpoint.key, multipart);
  }
  return keys;
}

const quoteKey = (name: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));

function filesMember(multipart: MultipartOperation): string {
  const members = multipart.fields
    .map((field) => {
      const required = multipart.multipartOnly && multipart.required.includes(field);
      return `${quoteKey(field)}${required ? '' : '?'}: readonly ${FILE_PART_TYPE}[]${required ? '' : ' | null'}`;
    })
    .join('; ');
  const required = multipart.multipartOnly && multipart.required.length > 0;
  const doc = multipart.multipartOnly
    ? '/** File parts of the multipart request. */'
    : '/** File parts: with at least one file the request is sent as multipart/form-data (JSON envelope in the field `body`), else as JSON. */';
  return `${doc}\n  ${MULTIPART_FILES_ARG}${required ? '' : '?'}: { ${members} };`;
}

export interface MultipartInjection {
  source: string;
  /** Endpoint keys whose body was rewritten. */
  injected: string[];
}

/**
 * Makes the endpoints of multipart operations send files: the endpoint argument gets `multipartFiles` (one list per
 * file field) and the request body becomes `buildDddMultipartBody(<json body>, queryArg.multipartFiles)`. An
 * operation that accepts JSON and multipart keeps sending JSON while no file is given; a multipart-only operation
 * loses the body argument RTK codegen derived from the multipart schema.
 *
 * Runs on the RTK output while its types are still inline. An endpoint whose argument is not an object of named
 * members (`flattenArg`) is left as it is, with a warning.
 */
export function injectMultipartBodies(source: string, endpoints: ReadonlyMap<string, MultipartOperation>, logger: Logger): MultipartInjection {
  if (endpoints.size === 0) return { source, injected: [] };
  const ts = loadTypeScript();
  const file = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const typeAliases = new Map<string, TypeScript.TypeAliasDeclaration>();
  for (const statement of file.statements) if (ts.isTypeAliasDeclaration(statement)) typeAliases.set(statement.name.text, statement);

  const edits: { start: number; end: number; text: string }[] = [];
  const injected: string[] = [];
  const skip = (key: string, reason: string): void => logger.warn(`  ${key}: multipart body not generated (${reason}) — the endpoint sends JSON only.`);

  const visit = (node: TypeScript.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(ts, node.name);
      const multipart = key === undefined ? undefined : endpoints.get(key);
      if (key !== undefined && multipart && isBuildCall(ts, node.initializer)) {
        const call = node.initializer;
        const returned = queryReturnObject(ts, call);
        if (typeof returned === 'string') return skip(key, returned);
        const definition = call.arguments[0] as TypeScript.ObjectLiteralExpression;
        const query = definition.properties.find((property) => property.name !== undefined && propertyName(ts, property.name) === 'query');
        const fn = query && ts.isPropertyAssignment(query) ? query.initializer : undefined;
        const parameter = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.parameters[0] : undefined;
        if (!parameter || !ts.isIdentifier(parameter.name)) return skip(key, 'the endpoint takes no argument');
        const argName = parameter.name.text;

        const argTypeNode = call.typeArguments?.[1];
        const alias =
          argTypeNode && ts.isTypeReferenceNode(argTypeNode) && ts.isIdentifier(argTypeNode.typeName)
            ? typeAliases.get(argTypeNode.typeName.text)
            : undefined;
        if (!alias || !ts.isTypeLiteralNode(alias.type)) return skip(key, 'its argument type is not an object type (flattenArg?)');
        const literal = alias.type;
        const memberName = (member: TypeScript.TypeElement): string | undefined =>
          member.name ? propertyName(ts, member.name) : undefined;
        if (literal.members.some((member) => memberName(member) === MULTIPART_FILES_ARG)) {
          return skip(key, `the argument already has a member "${MULTIPART_FILES_ARG}"`);
        }

        const body = returned.properties.find((property) => property.name !== undefined && propertyName(ts, property.name) === 'body');
        let jsonBody = 'undefined';
        if (body) {
          if (!ts.isPropertyAssignment(body)) return skip(key, 'unexpected `body` member');
          const text = body.initializer.getText(file);
          if (text === argName) return skip(key, 'the argument is the request body itself (flattenArg)');
          if (multipart.multipartOnly) {
            // RTK codegen typed this member from the multipart schema; the files replace it.
            const accessor = new RegExp(`^${argName}\\.([A-Za-z_$][A-Za-z0-9_$]*)$`).exec(text)?.[1];
            const member = accessor ? literal.members.find((candidate) => memberName(candidate) === accessor) : undefined;
            if (member) edits.push({ start: member.getFullStart(), end: member.getEnd(), text: '' });
          } else {
            jsonBody = text;
          }
          edits.push({
            start: body.initializer.getStart(file),
            end: body.initializer.getEnd(),
            text: `buildDddMultipartBody(${jsonBody}, ${argName}.${MULTIPART_FILES_ARG})`,
          });
        } else {
          const close = returned.end - 1;
          const separator = returned.properties.length > 0 && !returned.properties.hasTrailingComma ? ', ' : ' ';
          edits.push({ start: close, end: close, text: `${separator}body: buildDddMultipartBody(undefined, ${argName}.${MULTIPART_FILES_ARG}) ` });
        }
        const close = literal.end - 1;
        edits.push({ start: close, end: close, text: `\n  ${filesMember(multipart)}\n` });
        injected.push(key);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  let result = source;
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return { source: result, injected };
}

/** Import line of the multipart helper, for an api file with injected multipart bodies. */
export const MULTIPART_IMPORT = `import { buildDddMultipartBody } from '${DDD_WEB_API_IMPORT}';`;
