import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isUrl,
  loadConfig,
  resolveApis,
  resolveModelsDir,
  type LoadedConfig,
  type ResolvedApi,
  type SdkConfig,
  type SdkGeneratorMode,
} from './config';
import { generateDelegatedSdk } from './delegated-sdk';
import { prepareDocumentForEndpoints, restoreEndpointNames } from './document-endpoints';
import { prepareDocumentForModels } from './document-models';
import { buildEnhancedEndpoints } from './enhance';
import { splitRequestBuilders } from './request-builders';
import { parseApiEndpoints } from './endpoints';
import { OutputFiles } from './files';
import { formatFiles, typecheck } from './format';
import { consoleLogger, SdkGenerationError, type Logger } from './log';
import { extractModels } from './models';
import { detectMultipartEndpoints, injectMultipartBodies, MULTIPART_IMPORT } from './multipart';
import type { OpenApiDocument } from './openapi';
import { indexOperations } from './operations';
import { commitOutput } from './output';
import { buildRegistry } from './registry';
import { repairMissingPathParameters } from './repair';
import { detectResponseHandlerEndpoints, injectResponseHandlers } from './response-handlers';
import { findPrettierConfigFile, relativeImport, runRtkCodegen } from './rtk';
import { loadSpec, validateSpec } from './spec';
import { collectOperationTags, renderTagsFile } from './tags';
import { resolveWorkspace } from './workspace';

export interface GenerateSdkOptions {
  /** Config file path (default `openapi-config.ts`, relative to `cwd`) or an inline config. */
  config?: string | SdkConfig;
  /** Override the config's SDK generator mode for this run. */
  mode?: SdkGeneratorMode;
  /** Base directory for a relative config path and for an inline config's relative paths. Default `process.cwd()`. */
  cwd?: string;
  /** Generate only the api with this `exportName` (or output file stem). */
  api?: string;
  /** Spec source (URL or file) replacing `schemaFile`; requires a single selected api. */
  schema?: string;
  /** Workspace value for `config.workspace.envVar`. */
  workspace?: string;
  skipPrettier?: boolean;
  skipTsc?: boolean;
  logger?: Logger;
}

export interface GenerateSdkResult {
  apis: string[];
  /** Absolute paths of all written files. */
  files: string[];
  modelsDir: string;
  /** Model directories for each selected API in an opt-in mode. */
  modelsByApi?: Record<string, string>;
  typechecked: boolean;
}

async function load(options: GenerateSdkOptions, cwd: string): Promise<LoadedConfig> {
  if (options.config && typeof options.config === 'object') {
    return { config: options.config, configPath: path.join(cwd, '<inline config>'), rootDir: cwd };
  }
  return loadConfig(path.resolve(cwd, options.config ?? 'openapi-config.ts'));
}

function selectApis(all: ResolvedApi[], options: GenerateSdkOptions): ResolvedApi[] {
  let selected = all;
  if (options.api) {
    selected = all.filter((api) => api.exportName === options.api || api.stem === options.api);
    if (selected.length === 0) {
      throw new SdkGenerationError(`No api "${options.api}" in the config (have: ${all.map((api) => api.exportName).join(', ')}).`);
    }
  }
  if (options.schema) {
    if (selected.length !== 1) throw new SdkGenerationError('--schema needs exactly one api (use --api).');
    const schemaSource = isUrl(options.schema) ? options.schema : path.resolve(options.cwd ?? process.cwd(), options.schema);
    selected = [{ ...selected[0]!, schemaSource }];
  }
  return selected;
}

export async function generateSdk(options: GenerateSdkOptions = {}): Promise<GenerateSdkResult> {
  const logger = options.logger ?? consoleLogger;
  const cwd = path.resolve(options.cwd ?? process.cwd());

  let loaded = await load(options, cwd);
  if (loaded.config.workspace) {
    const value = await resolveWorkspace(loaded.rootDir, loaded.config.workspace, options.workspace, logger);
    // The config may build its URLs from the env variable at evaluation time.
    if (value && typeof options.config !== 'object') loaded = await loadConfig(loaded.configPath);
  }

  const allApis = resolveApis(loaded);
  const apis = selectApis(allApis, options);
  const mode = options.mode ?? loaded.config.generator?.mode ?? 'default';
  if (mode === 'future' || mode === 'legacy') {
    return generateDelegatedSdk(mode, loaded, allApis, apis, options, logger);
  }
  if (mode !== 'default') throw new SdkGenerationError('SDK generator mode must be default, future, or legacy.');
  const modelsDir = resolveModelsDir(loaded, allApis);
  const partial = apis.length < allApis.length;
  logger.info(`${apis.length} api(s): ${apis.map((api) => api.exportName).join(', ')}${partial ? ' (partial run)' : ''}`);

  // Models are shared between apis. A partial run therefore still reads every configured spec and rebuilds the
  // shared models from all of them (in config order, as a full run does); only the selected apis' files are written.
  const selected = new Set(apis.map((api) => api.stem));
  const pipeline: Array<{ api: ResolvedApi; write: boolean }> = allApis.map((api) => ({
    api: apis.find((candidate) => candidate.stem === api.stem) ?? api,
    write: selected.has(api.stem),
  }));

  // Each spec is loaded once and handed to every step.
  const specCache = new Map<string, Promise<OpenApiDocument>>();
  const loadOnce = (api: ResolvedApi): Promise<OpenApiDocument> => {
    if (!specCache.has(api.schemaSource)) {
      logger.info(`loading ${api.schemaSource}`);
      specCache.set(api.schemaSource, loadSpec(api.schemaSource));
    }
    return specCache.get(api.schemaSource)!;
  };
  const loadedSpecs = await Promise.all(
    pipeline.map(async ({ api, write }) => {
      if (write) return loadOnce(api);
      try {
        return await loadOnce(api);
      } catch (error) {
        logger.warn(
          `${api.exportName}: spec not loadable (${(error as Error).message}) — its models are kept from the previous ` +
            'output; models it shares with the selected apis may lose its fields until a full run.',
        );
        return null;
      }
    }),
  );
  const steps = pipeline
    .map((step, i) => ({ ...step, doc: loadedSpecs[i] }))
    .filter((step): step is { api: ResolvedApi; write: boolean; doc: OpenApiDocument } => step.doc !== null);
  steps.forEach(({ api, doc }) => validateSpec(doc, api.schemaSource, logger));

  const registry = buildRegistry(
    steps.map((step) => step.doc),
    logger,
  );
  logger.info(`registry: ${registry.length} namespaces`);

  const files = new OutputFiles();
  // Only needed when a contributing spec could not be loaded: its models stay as they are on disk.
  if (steps.length < pipeline.length) files.seedFromDisk(modelsDir);
  const prettierConfigFile = await findPrettierConfigFile(loaded.rootDir);
  const constsByFile = new Map<string, Map<string, string>>();
  const uniqueNameByPath = new Map<string, string>();
  const specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-web-spec-'));

  try {
    for (const [i, { api, write, doc: rawDoc }] of steps.entries()) {
      const doc = repairMissingPathParameters(rawDoc, logger);
      logger.info(`── ${api.stem} (${i + 1}/${steps.length})${write ? '' : ' (models only)'}`);
      const index = indexOperations(doc, api.sideEffects, api.skipUpdatePostTwins);
      if (index.skippedTwins.size > 0) logger.info(`  skipping ${index.skippedTwins.size} POST twin(s) of PATCH upserts`);

      const modelOptions = loaded.config.models ?? {};
      const prepared = prepareDocumentForModels(doc, modelOptions);
      const preparedEndpoints = prepareDocumentForEndpoints(prepared.doc, loaded.config.endpoints ?? {});
      const endpointOptions = loaded.config.endpoints ?? {};
      const esm = api.config.esmExtensions === true;
      const extractOptions = {
        apiFilePath: api.outputFile,
        modelsDir,
        registry,
        files,
        logger,
        esm,
        documentModels: prepared.documentModels,
        enumConsts: modelOptions.enums === 'const',
        constsByFile,
        modelOptions,
        writeIndex: modelOptions.index !== false,
        uniqueNameByPath,
      };
      const endpointNameOf = (rtkName: string): string => preparedEndpoints.endpointNamesByPlaceholder.get(rtkName) ?? rtkName;
      /**
       * One RTK codegen pass over the document, turned into the api source as it is written: multipart bodies, models
       * extracted (`modelsOnly`: the endpoint argument and response types are left out), response handlers.
       */
      const runPass = async (passApi: typeof api, specName: string, modelsOnly: boolean) => {
        const generated = await runRtkCodegen(passApi, preparedEndpoints.doc, index, path.join(specDir, specName), prettierConfigFile, endpointNameOf);
        const rtk = restoreEndpointNames(generated.code, generated.locations, preparedEndpoints.endpointNamesByPlaceholder);
        const endpoints = parseApiEndpoints(rtk.code, logger, rtk.locations);
        const handlerEndpoints = detectResponseHandlerEndpoints(doc, endpoints, api.responseHandlers);
        const responseKinds = new Map<string, 'text' | 'blob'>();
        for (const endpoint of endpoints) {
          const kind = handlerEndpoints.get(endpoint.key);
          if (kind && endpoint.responseType) responseKinds.set(endpoint.responseType, kind);
        }
        const multipart = injectMultipartBodies(rtk.code, detectMultipartEndpoints(doc, endpoints), logger);
        const apiSource = extractModels({ ...extractOptions, apiSource: multipart.source, responseKinds, modelsOnly });
        const withHandlers = injectResponseHandlers(apiSource, handlerEndpoints);
        const finalApiSource = multipart.injected.length > 0 ? `${MULTIPART_IMPORT}\n${withHandlers}` : withHandlers;
        return { endpoints, handlerEndpoints, multipartCount: multipart.injected.length, finalApiSource };
      };
      // models.scope 'all' and endpoints.requestBuilders 'all': a pass over every operation, also those the endpoint
      // filter leaves out of the api file — for the models, and (builders 'all') for the request builders and their
      // argument types
      const buildersOfAllOperations = endpointOptions.requestBuilders === 'all' && api.config.filterEndpoints !== undefined;
      let requestsSourceOfAllOperations: string | null = null;
      if ((modelOptions.scope === 'all' || buildersOfAllOperations) && api.config.filterEndpoints !== undefined) {
        const unfiltered = await runPass({ ...api, config: { ...api.config, filterEndpoints: undefined } }, `${i}-all.json`, !buildersOfAllOperations);
        if (buildersOfAllOperations) {
          const requestsStem = `${api.stem}Requests`;
          requestsSourceOfAllOperations = splitRequestBuilders(unfiltered.finalApiSource, requestsStem, `./${requestsStem}`).requestsSource;
          logger.info('  request builders of all operations (endpoints.requestBuilders all)');
        }
        if (modelOptions.scope === 'all') logger.info('  models of all operations written (models.scope all)');
      }
      const { endpoints, handlerEndpoints, multipartCount, finalApiSource } = await runPass(api, `${i}.json`, false);
      const fileCount = [...handlerEndpoints.values()].filter((kind) => kind === 'blob').length;
      if (fileCount > 0) logger.info(`  ${fileCount} file download endpoint(s) (blobResponseHandler)`);
      if (multipartCount > 0) logger.info(`  ${multipartCount} multipart endpoint(s) (multipartFiles)`);
      if (!write) continue;
      if (endpointOptions.requestBuilders) {
        // endpoints.requestBuilders: the request builders in a module of their own, the endpoints use them
        const requestsStem = `${api.stem}Requests`;
        const split = splitRequestBuilders(finalApiSource, requestsStem, esm ? `./${requestsStem}.js` : `./${requestsStem}`);
        files.set(api.outputFile, split.apiSource);
        files.set(path.join(api.outputDir, `${requestsStem}.ts`), requestsSourceOfAllOperations ?? split.requestsSource);
        logger.info(`  ${split.count} request builder(s) used by ${api.stem}.ts`);
      } else {
        files.set(api.outputFile, finalApiSource);
      }

      const withExtension = (specifier: string): string => (esm ? `${specifier}.js` : specifier);
      const enhanced = buildEnhancedEndpoints({
        stem: api.stem,
        apiName: api.exportName,
        apiModuleImport: withExtension(`./${api.stem}`),
        baseApiImport: api.config.baseApiImport ?? withExtension(relativeImport(api.outputDir, api.apiFile).replace(/\.[cm]?[jt]sx?$/, '')),
        baseApiName: api.config.apiImport ?? 'api',
        audience: api.audience,
        endpoints,
        index,
        doc,
        operationTags: collectOperationTags(doc, api.audience),
        invalidation: api.invalidation,
        logger,
      });
      files.set(path.join(api.outputDir, `${api.stem}Enhanced.ts`), enhanced.source);
      files.set(path.join(api.outputDir, `${api.stem}Tags.ts`), renderTagsFile(api.stem, enhanced.tagTypes));
    }
  } finally {
    fs.rmSync(specDir, { recursive: true, force: true });
  }

  if (!options.skipPrettier) {
    logger.info('formatting with prettier');
    await formatFiles(files);
  }

  const committed = commitOutput(files, modelsDir, loaded.rootDir);
  let typechecked = false;
  if (!options.skipTsc) {
    logger.info('type check (tsc --noEmit)');
    try {
      typechecked = typecheck(loaded.rootDir, path.resolve(loaded.rootDir, loaded.config.tsconfig ?? 'tsconfig.json'), logger);
    } catch (error) {
      committed.rollback();
      logger.error('type check failed — previous output restored');
      throw error;
    }
  }
  committed.finalize();
  logger.info(`done: ${files.paths().length} files`);
  return { apis: apis.map((api) => api.exportName), files: files.paths(), modelsDir, typechecked };
}
