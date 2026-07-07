const assert = require('assert');
const path = require('path');
const { resolveStyles } = require('../src/resolveStyles');
const { traceProperty } = require('../src/traceProperty');
const { matchSelector } = require('../src/selectorMatcher');
const { calculateSpecificity, specificityToString } = require('../src/specificity');

const fixtures = [
  path.join(__dirname, 'fixtures', 'buttons.css'),
  path.join(__dirname, 'fixtures', 'typography.css'),
];

function run() {
  // ── specificity ────────────────────────────────────────────────────────────
  assert.deepStrictEqual(calculateSpecificity('#header'), [0,1,0,0], 'ID specificity');
  assert.deepStrictEqual(calculateSpecificity('.btn.primary'), [0,0,2,0], 'double class specificity');
  assert.deepStrictEqual(calculateSpecificity('div.btn'), [0,0,1,1], 'tag+class specificity');
  assert.strictEqual(specificityToString([0,1,0,0]), '(0,1,0,0)', 'specificity toString');

  // ── selector matcher ───────────────────────────────────────────────────────
  assert.strictEqual(matchSelector('.btn', '.btn'), 'certain', 'exact match');
  assert.strictEqual(matchSelector('.btn', '.btn.primary'), 'likely', '.btn likely matches .btn.primary');
  assert.strictEqual(matchSelector('.sidebar .btn', '.btn'), 'possible', 'combinator rule is possible');
  assert.strictEqual(matchSelector('.nav', '.btn'), 'none', 'unrelated selectors');

  // ── resolve_styles ─────────────────────────────────────────────────────────
  const resolved = resolveStyles({ selector: '.btn.primary', files: fixtures });
  assert.ok(!resolved.error, 'resolve_styles should not error');
  assert.ok(resolved.properties, 'should return properties');
  assert.ok(resolved.properties['background-color'], 'should resolve background-color');

  const bg = resolved.properties['background-color'];
  assert.strictEqual(bg.winner.selector, '.btn.primary', '.btn.primary wins background-color over .btn');
  assert.ok(bg.overridden.length > 0, 'background-color should have overridden rules');
  assert.ok(resolved.matchedRules > 0, 'should have matched rules');
  assert.ok(resolved.summary, 'should have a summary');
  assert.ok(resolved.agentNote, 'should have an agentNote');

  // ── resolve_styles with no match ───────────────────────────────────────────
  const noMatch = resolveStyles({ selector: '.totally-unknown', files: fixtures });
  assert.ok(!noMatch.error, 'should not error on unknown selector');
  assert.strictEqual(Object.keys(noMatch.properties).length, 0, 'no properties for unknown selector');

  // ── trace_property ─────────────────────────────────────────────────────────
  const traced = traceProperty({ property: 'color', files: fixtures });
  assert.ok(!traced.error, 'trace_property should not error');
  assert.ok(traced.occurrences.length > 0, 'color should appear in fixtures');
  assert.ok(traced.summary, 'should have summary');
  assert.ok(traced.agentNote, 'should have agentNote');

  // ── trace_property missing property ────────────────────────────────────────
  const notFound = traceProperty({ property: 'grid-template-areas', files: fixtures });
  assert.strictEqual(notFound.occurrences.length, 0, 'missing property returns empty occurrences');

  // ── error handling ─────────────────────────────────────────────────────────
  const noSelector = resolveStyles({ files: fixtures });
  assert.ok(noSelector.error, 'should return error when selector missing');

  const noProperty = traceProperty({ files: fixtures });
  assert.ok(noProperty.error, 'should return error when property missing');

  console.log('stylescope regression checks passed');
}

run();
