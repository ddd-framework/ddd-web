// Installed-package smoke test: every public subpath resolves and exports something.
const subpaths = [
  'contract',
  'query',
  'api',
  'auth',
  'codegen',
  'fetch-api-request',
  'vite',
  'issues',
  'issues/browser',
  'issues/node',
  'issues/wire',
];
for (const subpath of subpaths) {
  const module = await import(`@mgamadeus/ddd-web/${subpath}`);
  if (Object.keys(module).length === 0 && subpath !== 'contract') {
    throw new Error(`@mgamadeus/ddd-web/${subpath} exports nothing`);
  }
  console.log(`ok @mgamadeus/ddd-web/${subpath}: ${Object.keys(module).join(', ')}`);
}

const api = await import('@mgamadeus/ddd-web/api');
for (const name of ['createDddBaseQuery', 'buildDddMultipartBody', 'mergeDddTagTypes', 'isDddUploadAborted']) {
  if (typeof api[name] !== 'function') throw new Error(`@mgamadeus/ddd-web/api lacks ${name}`);
}

const issues = await import('@mgamadeus/ddd-web/issues');
for (const name of ['createIssuesReporter', 'createIssuesRouteTracker', 'createFetchIssuesTransport', 'redactUrl', 'buildRoutePattern']) {
  if (typeof issues[name] !== 'function') throw new Error(`@mgamadeus/ddd-web/issues lacks ${name}`);
}
const issuesBrowser = await import('@mgamadeus/ddd-web/issues/browser');
if (issuesBrowser.createBrowserIssuesReporter({ app: 'smoke' }) !== null) {
  throw new Error('createBrowserIssuesReporter must return null outside a browser');
}
