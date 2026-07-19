const assert = require('assert');
const path = require('path');
const { resolveStyles } = require('../src/resolveStyles');
const { traceProperty } = require('../src/traceProperty');
const { matchSelector } = require('../src/selectorMatcher');
const { calculateSpecificity, specificityToString } = require('../src/specificity');
const { buildVariableMap, enrichValue, containsVar } = require('../src/variableResolver');
const { buildCSSOM } = require('../src/cssomBuilder');

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

  // ── variable resolver unit tests ──────────────────────────────────────────
  const varFixture = path.join(__dirname, 'fixtures', 'variables.css');
  const varCSOM = buildCSSOM([varFixture]);
  const varMap = varCSOM.variableMap;

  assert.ok(varMap.has('--color-primary'), 'variable map should contain --color-primary');
  assert.ok(varMap.has('--spacing-md'), 'variable map should contain --spacing-md');
  assert.ok(varMap.has('--btn-color'), 'variable map should contain --btn-color (chained)');

  // simple resolution
  const simpleEnriched = enrichValue('var(--color-primary)', varMap, '.btn');
  assert.ok(simpleEnriched, 'should return enriched value for var(--color-primary)');
  assert.strictEqual(simpleEnriched.resolvedValue, '#2563eb', 'should resolve --color-primary to #2563eb');
  assert.ok(simpleEnriched.variableChain.length > 0, 'should have a variable chain');

  // chained resolution: --btn-color: var(--color-primary) -> #2563eb
  const chainedEnriched = enrichValue('var(--btn-color)', varMap, '.btn-text');
  assert.ok(chainedEnriched, 'should return enriched value for chained var');
  assert.strictEqual(chainedEnriched.resolvedValue, '#2563eb', 'chained --btn-color should resolve to #2563eb');
  assert.ok(chainedEnriched.variableChain.length >= 2, 'chained var should have at least 2 steps in chain');

  // fallback resolution
  const fallbackEnriched = enrichValue('var(--color-undefined, #ff0000)', varMap, '.btn-fallback');
  assert.ok(fallbackEnriched, 'should return enriched value for var with fallback');
  assert.strictEqual(fallbackEnriched.resolvedValue, '#ff0000', 'undefined var should use fallback value');

  // non-var value returns null
  const noVar = enrichValue('#2563eb', varMap, '.btn');
  assert.strictEqual(noVar, null, 'non-var value should return null from enrichValue');

  // containsVar
  assert.ok(containsVar('var(--color-primary)'), 'should detect var()');
  assert.ok(!containsVar('#2563eb'), 'should not detect var() in plain value');

  // resolve_styles includes variables map
  const varResolved = resolveStyles({ selector: '.btn', files: [varFixture] });
  assert.ok(varResolved.variables, 'resolve_styles should include variables map');
  assert.ok(varResolved.variables['--color-primary'], 'variables map should include --color-primary');
  assert.strictEqual(varResolved.variables['--color-primary'].resolvedValue, '#2563eb', 'variable summary should show resolved value');

  // winner should have resolvedValue for var() properties
  const bgColor = varResolved.properties['background-color'];
  assert.ok(bgColor, 'should resolve background-color for .btn');
  assert.strictEqual(bgColor.winner.value, 'var(--color-primary)', 'winner value should be raw var()');
  assert.strictEqual(bgColor.winner.resolvedValue, '#2563eb', 'winner resolvedValue should be resolved');

  // media context conditionals
  const primaryVar = varResolved.variables['--color-primary'];
  assert.ok(primaryVar.conditionalValues, '--color-primary should have conditional media values');

  // trace_property includes variables
  const varTraced = traceProperty({ property: 'background-color', files: [varFixture] });
  assert.ok(varTraced.variables, 'trace_property should include variables map');
  assert.ok(varTraced.occurrences[0].resolvedValue, 'trace occurrence should have resolvedValue');

  // ── CSS Modules ───────────────────────────────────────────────────────────
  const { isCSSModule, isGlobalInModule, tagModuleRules, shouldSuppressCrossModuleConflict } = require('../src/cssModulesAnalyzer');

  assert.ok(isCSSModule('Button.module.css'), 'should detect .module.css');
  assert.ok(isCSSModule('Card.module.scss'), 'should detect .module.scss');
  assert.ok(!isCSSModule('styles.css'), 'should not flag regular css as module');

  assert.ok(isGlobalInModule(':root'), 'should treat :root as global in module');
  assert.ok(isGlobalInModule('*'), 'should treat * as global in module');
  assert.ok(!isGlobalInModule('.btn'), 'should treat .btn as locally scoped');

  const btnFixture = path.join(__dirname, 'fixtures', 'Button.module.css');
  const cardFixture = path.join(__dirname, 'fixtures', 'Card.module.css');
  const moduleCSSOM = buildCSSOM([btnFixture, cardFixture]);
  const btnRule = moduleCSSOM.rules.find(r => r.selector === '.btn' && r.source.file === btnFixture);
  const cardBtnRule = moduleCSSOM.rules.find(r => r.selector === '.btn' && r.source.file === cardFixture);
  assert.ok(btnRule && btnRule.cssModule === true, '.btn from module file should be tagged cssModule: true');
  assert.ok(btnRule && btnRule.localScope === true, '.btn from module file should be locally scoped');
  assert.ok(shouldSuppressCrossModuleConflict(btnRule, cardBtnRule), 'cross-module .btn conflict should be suppressed');
  assert.ok(!shouldSuppressCrossModuleConflict(btnRule, btnRule), 'same-file conflict should not be suppressed');

  // ── SCSS nesting ──────────────────────────────────────────────────────
  const { expandSCSS, combineSelectors } = require('../src/scssNestingExpander');

  assert.strictEqual(combineSelectors('.btn', '&:hover'), '.btn:hover', '& reference should combine correctly');
  assert.strictEqual(combineSelectors('.btn', '&.sm'), '.btn.sm', '& modifier should combine correctly');
  assert.strictEqual(combineSelectors('.card', '.title'), '.card .title', 'descendant should add space');

  const scssFixture = path.join(__dirname, 'fixtures', 'nested.scss');
  const scssCSSOM = buildCSSOM([scssFixture]);
  const cardTitleRule = scssCSSOM.rules.find(r => r.selector === '.card .title');
  const cardHoverRule = scssCSSOM.rules.find(r => r.selector === '.card:hover');
  const btnHoverRule = scssCSSOM.rules.find(r => r.selector === '.btn:hover');
  const btnSmRule = scssCSSOM.rules.find(r => r.selector === '.btn.sm');
  assert.ok(cardTitleRule, 'nested .card .title should be expanded');
  assert.ok(cardHoverRule, 'nested &:hover should expand to .card:hover');
  assert.ok(btnHoverRule, 'nested .btn &:hover should expand to .btn:hover');
  assert.ok(btnSmRule, 'nested .btn &.sm should expand to .btn.sm');

  // ── AST component graph ───────────────────────────────────────────────
  const { buildComponentGraph, graphConfirmsAncestry, extractComponentInfo } = require('../src/astComponentGraph');

  const jsxFixture = path.join(__dirname, 'fixtures', 'components.jsx');
  if (require('fs').existsSync(jsxFixture)) {
    const graphResult = buildComponentGraph([jsxFixture]);
    assert.ok(graphResult.componentMap, 'should build component map');
    assert.ok(graphResult.ancestorMap, 'should build ancestor map');
  }

  // graph-aware matching upgrades possible to likely
  const { matchSelectorWithGraph } = require('../src/selectorMatcher');
  const fakeAncestorMap = new Map([['.btn', new Set(['.sidebar'])]]);
  assert.strictEqual(matchSelectorWithGraph('.sidebar .btn', '.btn', fakeAncestorMap), 'likely', 'graph should upgrade possible to likely when ancestry confirmed');
  assert.strictEqual(matchSelectorWithGraph('.nav .btn', '.btn', fakeAncestorMap), 'possible', 'graph should leave possible when ancestry not confirmed');

  console.log('stylespeak regression checks passed');
}

run();
