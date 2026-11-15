import { SdkGenerationError } from './log';
import { HTTP_METHODS, type HttpMethod, type OpenApiDocument, type OpenApiOperation } from './openapi';

/** One operation an endpoint name is chosen for. */
export interface EndpointNamingOperation {
  method: HttpMethod;
  /** OpenAPI path, e.g. `/api/client/ai/conversations/{locationId}/list`. */
  path: string;
  operation: OpenApiOperation;
}

/** How the generator names the endpoints and their body argument. Every option is off by default. */
export interface EndpointOptions {
  /**
   * The endpoint names (and so the hook names):
   * - `rtk` (default): RTK codegen's names (the operation's `operationId`, else verb and path).
   * - `path`: a pure function of verb and path — the prefix (`stripPathPrefix`) is cut; every `{param}/` is cut out
   *   and only the LAST one cut is kept; the rest is split on `/ _ - .`, each piece capitalised, the verb in front,
   *   the first letter lowered; `By<LastInner>` is appended; a trailing `{param}` becomes `By<Param>` where it
   *   stands. `POST /api/client/ai/conversations/{locationId}/purposed/{purposeName}` →
   *   `postClientAiConversationsPurposedByPurposeNameByLocationId`.
   * - a function returning the name (a JavaScript identifier) per operation.
   */
  naming?: 'rtk' | 'path' | ((operation: EndpointNamingOperation) => string);
  /** The prefix `naming: 'path'` cuts from a path. Default `/^\/(?:app\/)?api(?=\/)/` (`/api` or `/app/api`). */
  stripPathPrefix?: string | RegExp;
  /**
   * `requestBody`: the request body is the argument's `requestBody` property, whatever its schema is called (a DTO
   * class that moves keeps the name). `rtk` (default): the camel-cased schema name.
   */
  bodyArg?: 'rtk' | 'requestBody';
}

export const REQUEST_BODY_ARG = 'requestBody';

const DEFAULT_STRIP_PATH_PREFIX = /^\/(?:app\/)?api(?=\/)/;

const upperFirst = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** The endpoint name of `naming: 'path'` (see {@link EndpointOptions.naming}). */
export function buildEndpointNameFromPath(method: string, path: string, stripPathPrefix: string | RegExp = DEFAULT_STRIP_PATH_PREFIX): string {
  const stripped =
    typeof stripPathPrefix === 'string' ? (path.startsWith(stripPathPrefix) ? path.slice(stripPathPrefix.length) : path) : path.replace(stripPathPrefix, '');
  let lastInnerParameter: string | null = null;
  const withoutInnerParameters = stripped.replace(/\{([^}]+)\}\//g, (_, parameter: string) => {
    lastInnerParameter = parameter;
    return '';
  });
  const pieces = withoutInnerParameters
    .split(/[/_.-]/)
    .filter((piece) => piece !== '')
    .map(upperFirst)
    .join('');
  const name = `${method.toLowerCase()}${pieces}${lastInnerParameter ? `By${upperFirst(lastInnerParameter)}` : ''}`;
  return name.replace(/\{([^}]+)\}/g, (_, parameter: string) => `By${upperFirst(parameter)}`);
}

/**
 * The document RTK codegen reads, with the endpoint options applied: the chosen name as each operation's
 * `operationId`, and the request body schemas titled `requestBody`. The document passed in stays unchanged. Two
 * operations with the same name are an error naming both.
 */
export function prepareDocumentForEndpoints(doc: OpenApiDocument, options: EndpointOptions): OpenApiDocument {
  const naming = options.naming ?? 'rtk';
  const bodyArg = options.bodyArg ?? 'rtk';
  if (naming === 'rtk' && bodyArg === 'rtk') return doc;
  const prepared = structuredClone(doc) as OpenApiDocument;
  const pathByName = new Map<string, string>();
  for (const [path, item] of Object.entries(prepared.paths ?? {})) {
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      if (naming !== 'rtk') {
        const name =
          naming === 'path' ? buildEndpointNameFromPath(method, path, options.stripPathPrefix) : naming({ method, path, operation });
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
          throw new SdkGenerationError(`endpoints.naming: "${name}" (${method.toUpperCase()} ${path}) is no identifier.`);
        }
        const other = pathByName.get(name);
        if (other !== undefined) {
          throw new SdkGenerationError(`endpoints.naming: ${other} and ${method.toUpperCase()} ${path} are both named "${name}".`);
        }
        pathByName.set(name, `${method.toUpperCase()} ${path}`);
        operation.operationId = name;
      }
      if (bodyArg === REQUEST_BODY_ARG) titleRequestBody(operation);
    }
  }
  return prepared;
}

/** RTK codegen names the body argument after a body schema's title when the schema is no `$ref`. */
function titleRequestBody(operation: OpenApiOperation): void {
  const content = (operation.requestBody as { content?: Record<string, { schema?: Record<string, unknown> }> } | undefined)?.content;
  for (const media of Object.values(content ?? {})) {
    const schema = media?.schema;
    if (!schema) continue;
    media.schema = typeof schema.$ref === 'string' ? { title: REQUEST_BODY_ARG, allOf: [{ $ref: schema.$ref }] } : { ...schema, title: REQUEST_BODY_ARG };
  }
}
