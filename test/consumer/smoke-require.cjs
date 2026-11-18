// Installed-package smoke test from CommonJS: every subpath that declares a `default` condition loads with require()
// (Node's require of an ES module, Node >= 20.19 / >= 22.12) and exports something.
const assert = require('node:assert');
const manifest = require('@mgamadeus/ddd-web/package.json');

const requirableSubpaths = Object.entries(manifest.exports)
  .filter(([, conditions]) => conditions !== null && typeof conditions === 'object' && 'default' in conditions)
  .map(([subpath]) => subpath.replace(/^\.\//, ''));
assert.ok(requirableSubpaths.includes('contract'), '@mgamadeus/ddd-web/contract must be requirable');

for (const subpath of requirableSubpaths) {
  const module = require(`@mgamadeus/ddd-web/${subpath}`);
  assert.ok(Object.keys(module).length > 0, `@mgamadeus/ddd-web/${subpath} exports nothing under require()`);
  console.log(`ok require @mgamadeus/ddd-web/${subpath}: ${Object.keys(module).length} exports`);
}

const contract = require('@mgamadeus/ddd-web/contract');
assert.ok(Array.isArray(contract.FILTER_OPERATORS) && contract.FILTER_OPERATORS.length > 0, 'contract FILTER_OPERATORS');
const wire = require('@mgamadeus/ddd-web/issues/wire');
assert.strictEqual(typeof wire.toDddClientIssueEvent, 'function', 'issues/wire toDddClientIssueEvent');
console.log('CommonJS require smoke passed');
