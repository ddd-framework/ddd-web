import * as fs from 'node:fs';
import * as path from 'node:path';
import { createJiti } from 'jiti';
import type { HttpMethod } from './openapi';

/** Selects operations by HTTP method (optional, case-insensitive) and path (exact string or RegExp). */
export interface OperationMatcher {
  method?: Uppercase<HttpMethod> | HttpMethod;
  path: string | RegExp;
}

/**
 * Classifies operations by whether they change server state, for specs that do not carry
 * `x-ddd-side-effects` yet. Matches on HTTP method and path (exact string or RegExp).
 */
export interface SideEffectsOverride extends OperationMatcher {
  sideEffects: boolean;
  /**
   * Force the generated hook kind. Default: a writing GET becomes a mutation, a reading POST becomes a
   * query. `'mutation'` keeps a reading POST a mutation (hook name unchanged) that invalidates nothing.
   */
  endpointType?: 'query' | 'mutation';
}

/**
 * Sets how an endpoint reads its successful response, for specs whose declared content type is missing or wrong
 * (e.g. an Excel export declared as `application/json`). Wins over content-type detection.
 * - `blob`: `responseHandler: blobResponseHandler`, result type `DddFileResponse` (`{ blob, filename, contentType }`)
 * - `text`: `responseHandler: "text"`, result type `string`
 * - `json`: RTK's JSON parsing, no handler (also turns off a detected `text` / `blob`)
 */
export interface ResponseHandlerOverride extends OperationMatcher {
  handler: 'blob' | 'text' | 'json';
}

export interface HooksOptions {
  queries: boolean;
  lazyQueries: boolean;
  mutations: boolean;
}

/** One generated API (one OpenAPI document, typically one audience). */
export interface SdkApiConfig {
  /** Spec source: http(s) URL or local file path (relative to the config file). */
  schemaFile: string;
  /**
   * Module that exports the RTK base api: a path relative to the config file (e.g. `./src/api/baseApi.ts`)
   * or a bare module specifier used verbatim.
   */
  apiFile: string;
  /** Named export of the base api in `apiFile`. Default `api`. */
  apiImport?: string;
  /** Generated endpoints file, e.g. `./src/api/adminApi.ts`. Tags and enhanced files are written next to it. */
  outputFile: string;
  /** Name used for `--api` selection; also passed to RTK codegen. Default: stem of `outputFile`. */
  exportName?: string;
  hooks?: boolean | HooksOptions;
  /** Prefix stripped from operation tags (e.g. `admin`). Default: stem of `outputFile` without `Api`. */
  audience?: string;
  /**
   * Import specifier of the base api used by the `<stem>Enhanced.ts` file.
   * Default: `apiFile` relative to the output directory (e.g. `./baseApi`).
   */
  baseApiImport?: string;
  /** Overrides `SdkConfig.skipUpdatePostTwins` for this api. */
  skipUpdatePostTwins?: boolean;
  /** Added after the global `sideEffects`; the first match wins, so entries here are checked first. RegExp flags `g` / `y` are ignored for matching. */
  sideEffects?: SideEffectsOverride[];
  /** Added after the global `responseHandlers`; the first match wins, so entries here are checked first. */
  responseHandlers?: ResponseHandlerOverride[];
  /** Any further RTK codegen option (`argSuffix`, `flattenArg`, `endpointOverrides`, `filterEndpoints`, …). */
  [rtkOption: string]: unknown;
}

/** Optional resolution of a workspace/subdomain value that the config reads from an env variable. */
export interface WorkspaceOptions {
  /** Env variable the config file reads, e.g. `DEV_WORKSPACE`. */
  envVar: string;
  /** Files sniffed for a URL whose first host label is the workspace. Default `['.env', '.env.local']`. */
  envFiles?: string[];
  /** Keys looked up in those files. Default: common `*_API_URL` keys. */
  urlKeys?: string[];
  /** Ask on a TTY when nothing else resolves it. Never asks without a TTY. Default `true`. */
  prompt?: boolean;
}

export interface SdkConfig {
  apis: SdkApiConfig[];
  /** Directory of generated model files. Default `<dir of first outputFile>/../models`. */
  modelsDir?: string;
  /**
   * Skip the POST twin of an upsert (DDD `#[Update]` serves POST and PATCH): only the PATCH is generated. With
   * `x-ddd-entity` both must be `upsert` of the same entity; without it summary, parameters, request body and
   * responses must be identical. Conflicting annotations never skip. Default `false`.
   */
  skipUpdatePostTwins?: boolean;
  sideEffects?: SideEffectsOverride[];
  /**
   * Response handler per operation, overriding content-type detection (binary 2xx → `blob`, text-only 2xx → `text`).
   * First match wins.
   */
  responseHandlers?: ResponseHandlerOverride[];
  workspace?: WorkspaceOptions;
  /** tsconfig used for the final type check. Default `tsconfig.json` next to the config file. */
  tsconfig?: string;
}

export function defineConfig(config: SdkConfig): SdkConfig {
  return config;
}

export interface LoadedConfig {
  config: SdkConfig;
  configPath: string;
  rootDir: string;
}

/**
 * Loads `openapi-config.ts` (or .js/.mjs/.cjs) with jiti. Accepts `export default defineConfig({...})`
 * or a named `export const apis = [...]` (plain RTK codegen entries).
 */
export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const absolute = path.resolve(configPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Config file not found: ${absolute}`);
  }
  // A fresh instance per load: the config may read env variables at evaluation time.
  const jiti = createJiti(absolute, { moduleCache: false, fsCache: false });
  const mod = (await jiti.import(absolute)) as Record<string, unknown>;
  const config = normalizeConfigModule(mod, absolute);
  return { config, configPath: absolute, rootDir: path.dirname(absolute) };
}

function normalizeConfigModule(mod: Record<string, unknown>, configPath: string): SdkConfig {
  const candidate = (mod.default ?? mod.config ?? mod) as Record<string, unknown> | unknown[];
  if (Array.isArray(candidate)) return { apis: candidate as SdkApiConfig[] };
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.apis)) {
    return candidate as unknown as SdkConfig;
  }
  if (Array.isArray(mod.apis)) return { apis: mod.apis as SdkApiConfig[] };
  throw new Error(
    `${configPath} must export a config (\`export default defineConfig({ apis: [...] })\`) or \`export const apis = [...]\`.`,
  );
}

export interface ResolvedApi {
  config: SdkApiConfig;
  /** Stem of the output file, e.g. `adminApi`. */
  stem: string;
  exportName: string;
  audience: string;
  schemaSource: string;
  outputFile: string;
  apiFile: string;
  outputDir: string;
  skipUpdatePostTwins: boolean;
  sideEffects: SideEffectsOverride[];
  responseHandlers: ResponseHandlerOverride[];
}

export function resolveApis(loaded: LoadedConfig): ResolvedApi[] {
  const { config, rootDir } = loaded;
  if (!Array.isArray(config.apis) || config.apis.length === 0) {
    throw new Error(`No apis configured in ${loaded.configPath}.`);
  }
  return config.apis.map((entry, index) => {
    for (const key of ['schemaFile', 'apiFile', 'outputFile'] as const) {
      if (typeof entry[key] !== 'string' || entry[key] === '') {
        throw new Error(`apis[${index}].${key} must be a non-empty string.`);
      }
    }
    const outputFile = path.resolve(rootDir, entry.outputFile);
    const stem = path.basename(outputFile).replace(/\.[cm]?[jt]sx?$/, '');
    return {
      config: entry,
      stem,
      exportName: typeof entry.exportName === 'string' ? entry.exportName : stem,
      audience: entry.audience ?? stem.replace(/Api$/, ''),
      schemaSource: isUrl(entry.schemaFile) ? entry.schemaFile : path.resolve(rootDir, entry.schemaFile),
      outputFile,
      apiFile: isPathLike(entry.apiFile) ? path.resolve(rootDir, entry.apiFile) : entry.apiFile,
      outputDir: path.dirname(outputFile),
      skipUpdatePostTwins: entry.skipUpdatePostTwins ?? config.skipUpdatePostTwins ?? false,
      sideEffects: [...(entry.sideEffects ?? []), ...(config.sideEffects ?? [])],
      responseHandlers: [...(entry.responseHandlers ?? []), ...(config.responseHandlers ?? [])],
    };
  });
}

export function resolveModelsDir(loaded: LoadedConfig, apis: ResolvedApi[]): string {
  if (loaded.config.modelsDir) return path.resolve(loaded.rootDir, loaded.config.modelsDir);
  const first = apis[0];
  if (!first) throw new Error('No apis configured.');
  for (const api of apis) {
    if (api.outputDir !== first.outputDir) {
      throw new Error(
        `All apis must share one output directory when modelsDir is not set (got ${api.outputFile} next to ${first.outputFile}).`,
      );
    }
  }
  return path.resolve(first.outputDir, '..', 'models');
}

/** Relative or absolute file path (as opposed to a bare module specifier such as `@/api/baseApi`). */
export function isPathLike(value: string): boolean {
  return value.startsWith('.') || path.isAbsolute(value);
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
