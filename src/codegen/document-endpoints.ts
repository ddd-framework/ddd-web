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
  /**
   * `true`: the request builder of every endpoint (its `query`) goes into `<stem>Requests.ts` next to the api file, as
   * `export const <stem>Requests = { <endpoint>: (queryArg: <Arg>) => ({ url, params, body, … }) }`, and the endpoint
   * uses it (`query: <stem>Requests.<endpoint>`). A bundle that only builds requests imports that module without the
   * endpoint injection. `'all'`: the module holds the builder of EVERY operation of the document (and their argument
   * types are written), while the api file injects only what `filterEndpoints` keeps. Default `false`.
   */
  requestBuilders?: boolean | 'all';
  /**
   * `drop` (default): parameters `in: cookie` leave the endpoints — a browser sends its cookies itself, and RTK Query's
   * `FetchArgs` has no field for them (a builder with `cookies` fails the type check). `keep`: as RTK codegen writes them.
   */
  cookieParameters?: 'drop' | 'keep';
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
export function prepareDocumentForEndpoints(
  doc: OpenApiDocument,
  options: EndpointOptions,
): { doc: OpenApiDocument; endpointNamesByPlaceholder: Map<string, string> } {
  const naming = options.naming ?? 'rtk';
  const bodyArg = options.bodyArg ?? 'rtk';
  const dropsCookieParameters = (options.cookieParameters ?? 'drop') === 'drop';
  const endpointNamesByPlaceholder = new Map<string, string>();
  if (naming === 'rtk' && bodyArg === 'rtk' && !(dropsCookieParameters && hasCookieParameters(doc))) {
    return { doc, endpointNamesByPlaceholder };
  }
  const prepared = structuredClone(doc) as OpenApiDocument;
  if (dropsCookieParameters) dropCookieParameters(prepared);
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
        // RTK codegen camel-cases an operationId again (`…LegacyDB` → `…LegacyDb`): a placeholder it keeps as it is
        // goes in, and the name replaces it in the generated code ({@link restoreEndpointNames})
        const placeholder = `dddEndpoint${endpointNamesByPlaceholder.size}`;
        endpointNamesByPlaceholder.set(placeholder, name);
        operation.operationId = placeholder;
      }
      if (bodyArg === REQUEST_BODY_ARG) titleRequestBody(operation);
    }
  }
  return { doc: prepared, endpointNamesByPlaceholder };
}

/**
 * The generated code and the operation of each endpoint with the endpoint names in place of their placeholders: the
 * endpoint key (`dddEndpoint3`), and capitalised inside identifiers (`useDddEndpoint3Query`, `DddEndpoint3ApiArg`).
 */
export function restoreEndpointNames<Location>(
  code: string,
  locations: Map<string, Location>,
  endpointNamesByPlaceholder: ReadonlyMap<string, string>,
): { code: string; locations: Map<string, Location> } {
  if (endpointNamesByPlaceholder.size === 0) return { code, locations };
  const restore = (text: string): string =>
    text.replace(/(d|D)ddEndpoint(\d+)(?!\d)/g, (match, first: string, number: string) => {
      const name = endpointNamesByPlaceholder.get(`dddEndpoint${number}`);
      if (name === undefined) return match;
      return first === 'D' ? upperFirst(name) : name;
    });
  const restoredLocations = new Map<string, Location>();
  for (const [key, location] of locations) restoredLocations.set(restore(key), location);
  return { code: restore(code), locations: restoredLocations };
}

const isCookieParameter = (parameter: unknown, doc: OpenApiDocument): boolean => {
  const resolved = resolveParameter(parameter, doc);
  return typeof resolved === 'object' && resolved !== null && (resolved as { in?: unknown }).in === 'cookie';
};

/** A parameter, or the component parameter its `$ref` points to. */
function resolveParameter(parameter: unknown, doc: OpenApiDocument): unknown {
  const ref = (parameter as { $ref?: unknown } | null)?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/components/parameters/')) return parameter;
  return (doc.components?.parameters as Record<string, unknown> | undefined)?.[ref.slice('#/components/parameters/'.length)];
}

/** Whether a path item or an operation of the document declares a cookie parameter. */
function hasCookieParameters(doc: OpenApiDocument): boolean {
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item) continue;
    const lists = [item.parameters, ...HTTP_METHODS.map((method) => item[method]?.parameters)];
    if (lists.some((list) => Array.isArray(list) && list.some((parameter) => isCookieParameter(parameter, doc)))) return true;
  }
  return false;
}

/** Removes every cookie parameter of the path items and operations (the document is a copy). */
function dropCookieParameters(doc: OpenApiDocument): void {
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item) continue;
    if (Array.isArray(item.parameters)) item.parameters = item.parameters.filter((parameter) => !isCookieParameter(parameter, doc));
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation && Array.isArray(operation.parameters)) {
        operation.parameters = operation.parameters.filter((parameter) => !isCookieParameter(parameter, doc));
      }
    }
  }
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
