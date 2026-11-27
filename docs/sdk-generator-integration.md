# SDK generation modes

Use the same `openapi-config.ts` and API entries for all three modes. Omit `generator` to use DDD Web’s existing RTK Query generation. Select an opt-in mode per run with `ddd-web-sdk --mode future` or `ddd-web-sdk --mode legacy`, or set `generator.mode` in the config.

| Mode | Output | Consumer dependency |
| --- | --- | --- |
| `default` | DDD RTK Query endpoints, hooks, shared models, tags, enhancements, and configured request builders | Existing DDD Web dependencies |
| `future` | TypeScript models and a typed promise client, with optional seeded mocks | `swagger-sdk-generator@^3` from npm |
| `legacy` | Legacy-dialect models, stores, thunks, and mocks | `swagger-sdk-generator@^3.1` from npm, plus the generated code’s Redux Toolkit, RxJS, and Faker dependencies |

## Promise client

Install the generator as an application dependency. Generated clients use its runtime in the running app.

```sh
pnpm add swagger-sdk-generator@^3
pnpm exec ddd-web-sdk --mode future
```

To inject a transport or add mocks, configure the output options in `openapi-config.ts`.

```ts
export default defineConfig({
  generator: {
    mode: 'future',
    outputs: { client: { transport: 'none' }, mocks: {} },
  },
  apis: [{
    schemaFile: './openapi.json',
    apiFile: './src/api/baseApi.ts',
    outputFile: './src/api/adminApi.ts',
  }],
});
```

Import `createApi` from `src/generated-sdk/future/adminApi/client/client.ts`. The client defaults to Fetch. With `transport: 'none'`, pass a custom transport or wrap an application-owned Axios instance with `createAxiosTransport` from `swagger-sdk-generator/runtime`. Configure auth and request hooks when calling `createApi`. Install Faker if you enable mocks.

## Legacy stores

Install `swagger-sdk-generator@^3.1`, then run `ddd-web-sdk --mode legacy`. The generated `stores/stores.ts` configures the shared transport runtime. Keep the model aliases required by your legacy configuration. For the default legacy alias, map `@models/swagger/*` to `./src/generated-sdk/legacy/adminApi/models/*` in the consuming project.

Set `generator.outputs.stores.runtimeModule` to use an app-owned runtime and generate only the operation stores. Use a package or alias specifier, or a relative path from the stores output directory. With the standard legacy mode, the module exports `send`, which you can get from `createStoreRuntime` in `swagger-sdk-generator/runtime/stores`. Configure that runtime with your own transport, such as an Axios instance wrapped with `createAxiosTransport`.

Apps migrating an existing legacy generator can call `generateLegacySdk` from `@mgamadeus/ddd-web/codegen`. Pass the ordered OpenAPI sources and explicit generator output options, including the app’s existing directories. This entry point accepts plain OpenAPI documents and stages the planned files before writing them. Files outside the plan stay in place.

### Pruning files the legacy run no longer writes

`generateLegacySdk` writes; by default it never deletes. Pass `prune: true` to also delete the files an earlier run
wrote and this run no longer plans — a store of a removed controller, a model or mock of a removed schema:

```ts
const results = await generateLegacySdk({ sources, prune: true, manifestFile: '.ddd-web-legacy-sdk.json' });
const deleted = results.flatMap((result) => result.pruned ?? []);
```

- The manifest (`manifestFile`, default `<cwd>/.ddd-web-legacy-sdk.json`; commit it or keep it next to the output)
  records, per source name and output name, the output directory and every file that output planned (paths relative
  to `cwd`, absolute outside it).
- Only listed files are deleted. A hand-written file in a shared output directory (a mocks root, say) is never listed
  and stays. The first run with `prune` writes the manifest and deletes nothing.
- Scoped to what ran: a file is deleted only when an output that ran this time listed it before, no output of this run
  plans it, and no output that did not run lists it. A source left out of `sources`, a skipped source (`onError`), and
  an output a source did not configure this time (stores of a mocks-only run) delete nothing; their manifest entries
  are kept. So a partial run never removes a mock another document still writes into the shared directory.
- Folders left empty below an output directory are removed; the output directory itself stays.
- `dryRun: true` deletes nothing and writes no manifest; `result.pruned` lists what a real run would delete.
- Each source's `result.pruned` holds the absolute paths it deleted (absent without `prune`).

## MSW handlers (default mode)

The default mode can write [MSW](https://mswjs.io) handler factories next to each api file. Enable them with
`mswHandlers`; without it nothing changes. The generated file imports `msw` (v2), which your project installs.

```ts
export default defineConfig({
  endpoints: { requestBuilders: 'all' },
  mswHandlers: {
    modelMocks: {
      importPrefix: '@mocks/models/',                            // + the model's path below modelsDir + fileSuffix
      fileSuffix: '.mock',                                       // default
      exportName: (modelName) => `get${modelName}Mock`,          // default; called without arguments
    },
  },
  apis: [
    { /* … */ outputFile: './src/api/adminApi.ts' },                                     // → src/api/adminApiMocks.ts
    { /* … */ outputFile: './src/api/clientApi.ts', mswHandlers: { outputFile: './src/mocks/clientHandlers.ts' } },
    { /* … */ outputFile: './src/api/publicApi.ts', mswHandlers: false },                // none for this api
  ],
});
```

| Option | Where | Meaning |
| --- | --- | --- |
| `mswHandlers` | config | Turns the handlers on for every api. |
| `mswHandlers.modelMocks` | config or api | `importPrefix` (required), `fileSuffix` (default `.mock`), `exportName(modelName, modelPath)` (default `get<ModelName>Mock`). Without it every default answer is `null`. |
| `mswHandlers.outputFile` | api | Default `<stem>Mocks.ts` next to the api file. |
| `mswHandlers.exportName` | api | Name of the exported object. Default `<stem>Mocks`. |
| `mswHandlers: false` | api | No handlers for this api. An api-level object alone also turns them on for that api. |

The file exports `<stem>Mocks`, with one factory per operation that has a request builder (every operation of the
document with `requestBuilders: 'all'`, otherwise the endpoints of the api file), and the `StoryMock` type:

```ts
export const adminApiMocks = { // abridged: the call also carries the type arguments
  getApiAdminLibraryBooksByBookId: (custom?: Partial<StoryMock<GetApiAdminLibraryBooksByBookIdApiResponse, GetApiAdminLibraryBooksByBookIdApiArg>>) =>
    mockOperation('get', '*/api/admin/library/books/:bookId', '/api/admin/library/books/{bookId}', 'json', 200, () => getBookGetResponseDtoMock(), custom),
  // …
};
```

- **URL**: `*` + the operation path with each `{param}` as an MSW `:param` — any origin and base path; MSW ignores
  the query string. A `:param` matches exactly one segment (`/books/:bookId` does not answer `/books/7/archive`), but
  it does match a static sibling, so register a static path (`/books/featured`) before a parameterised one it also
  matches (`/books/{bookId}`), or pass `url`. Parameter names are reduced to word characters (`{file-name}` →
  `:file_name`).
- **Default answer**: a response that is one model answers its mock (`get<Model>Mock()` from
  `importPrefix + <model path> + fileSuffix`); an array of a model answers `[mock]`; no content, another shape or no
  `modelMocks` answer `null`. A file download answers `null` with status 200; text answers `null`. The status is the
  operation's first declared 2xx (e.g. 204), 200 when none.
- **`custom`** (`Partial<StoryMock<Response, Arg>>`): `url` replaces the pattern; `status`; `delay` (ms, `'real'`,
  `'infinite'`); `response` is a value or `(params, defaultMock, info) => value | Promise<value>`, where `params` holds
  the path parameters and query values as strings and `info` is MSW's resolver info. `null` answers an empty body. For
  a file download the response is a `Blob` or string body.
- The mocks are typed by the generated models: a mock returning another shape, or a missing mock module, fails the
  type check. Model mocks of another generator work as long as their exports match `exportName`.

For `engine: 'legacy'`, your `runtimeModule` exports `LegacyStoreBase`, `AbortControllersManager`, `HttpCallOptions` (a type), `sendLegacyRequest`, and `legacyStoreThunk`. The generated methods delegate to `sendLegacyRequest(store, abortManager, verb, path, call)`. The call includes query parameters, options, content type, the binary response flag, and the request body for writes. When `legacyRequestBuilders` is configured, the call also carries the operation's builder metadata so the app can choose its sender. The runtime's `legacyStoreThunk(name, request)` wraps an Observable-returning method for Redux Toolkit callers.

## Output and validation

The opt-in directories default to `src/generated-sdk/<mode>/<output-file-stem>/`. Change the base with `generator.outputDir`. DDD Web owns and replaces each selected API’s directory, so use a dedicated directory for generated files. Relative imports in the delegated TypeScript output assume bundler-style resolution.

Both opt-in modes validate the DDD contract, repair missing path parameters, and honor `skipUpdatePostTwins`. They use the external generator’s output and transport behavior. DDD RTK-specific settings, including base API bindings, hooks, response overrides, and invalidation resolvers, apply in default mode. `--api` regenerates one API and `--schema` can override its input. Generation stages every selected API and restores previous files if the type check fails.
