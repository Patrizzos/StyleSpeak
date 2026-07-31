/**
 * live_resolve — stylespeak v1.0
 *
 * Live CSS resolution via Chrome DevTools Protocol.
 * Returns exact computed styles and matched rules for a selector
 * by querying a running browser — no static analysis, no heuristics,
 * no confidence levels. The browser resolved it.
 *
 * Requires Chrome (or any Chromium browser) running with:
 *   --remote-debugging-port=9222
 *
 * Output shape mirrors resolve_styles for agent interoperability,
 * with these additions:
 *   - liveResolution: true
 *   - confidence: "exact" on all properties
 *   - computedStyles: { prop → value } — final values including inheritance
 *     and browser defaults, not just authored styles
 *   - matchedRules: [ { selector, properties, source, origin } ] — every
 *     rule that matched the element, in cascade order
 *   - tab: { title, url } — which tab was inspected
 */

const { inspect, CdpNotRunningError, DEFAULT_PORT } = require('./cdpBridge');

// ─── CDP data formatters ──────────────────────────────────────────────────────

/**
 * Extracts computed styles from CDP response into a clean { prop: value } map.
 */
function formatComputedStyles(computedStyles) {
  const result = {};
  const properties = computedStyles.computedStyle || [];
  for (const { name, value } of properties) {
    if (name && value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * Formats matched CSS rules from CDP into a clean array.
 * CDP returns matchedCSSRules: [ { rule, matchingSelectors } ]
 * Each rule has: selectorList, style.cssProperties, origin, styleSheetId
 */
function formatMatchedRules(matchedStyles) {
  const rules = [];

  // Matched authored rules (from stylesheets)
  const matchedCSSRules = matchedStyles.matchedCSSRules || [];
  for (const { rule, matchingSelectors } of matchedCSSRules) {
    const selectors = rule.selectorList.selectors.map(s => s.text);
    const matchedSelectorTexts = matchingSelectors.map(i => selectors[i]);
    const properties = {};
    for (const { name, value, important } of (rule.style.cssProperties || [])) {
      if (name && value !== undefined && !name.startsWith('--')) {
        properties[name] = { value, important: !!important };
      }
    }

    // Source location
    let source = null;
    if (rule.style.styleSheetId && rule.style.range) {
      source = {
        styleSheetId: rule.style.styleSheetId,
        startLine: rule.style.range.startLine + 1,
      };
    }

    rules.push({
      matchedSelectors: matchedSelectorTexts,
      allSelectors: selectors,
      properties,
      origin: rule.origin || 'author',
      source,
    });
  }

  // Inherited styles
  const inherited = matchedStyles.inherited || [];
  for (const { matchedCSSRules: inheritedRules } of inherited) {
    for (const { rule } of (inheritedRules || [])) {
      const properties = {};
      for (const { name, value, important } of (rule.style.cssProperties || [])) {
        if (name && value !== undefined && !name.startsWith('--')) {
          properties[name] = { value, important: !!important, inherited: true };
        }
      }
      if (Object.keys(properties).length > 0) {
        rules.push({
          matchedSelectors: rule.selectorList.selectors.map(s => s.text),
          allSelectors: rule.selectorList.selectors.map(s => s.text),
          properties,
          origin: 'inherited',
          source: null,
        });
      }
    }
  }

  // Inline styles
  const inline = matchedStyles.inlineStyle;
  if (inline && inline.cssProperties && inline.cssProperties.length > 0) {
    const properties = {};
    for (const { name, value, important } of inline.cssProperties) {
      if (name && value) properties[name] = { value, important: !!important };
    }
    if (Object.keys(properties).length > 0) {
      rules.unshift({
        matchedSelectors: ['(inline style)'],
        allSelectors: ['(inline style)'],
        properties,
        origin: 'inline',
        source: null,
      });
    }
  }

  return rules;
}

/**
 * Builds a per-property breakdown: for each CSS property, which rule won
 * and what's the computed (final) value. Merges matched rules with computed values.
 */
function buildPropertyBreakdown(matchedRules, computedStyleMap) {
  const breakdown = {};

  // Walk rules in reverse cascade order (last = highest priority, already in CDP order)
  // CDP returns rules with highest priority last — we reverse to find winners
  const reversed = [...matchedRules].reverse();

  for (const rule of reversed) {
    for (const [prop, { value, important, inherited }] of Object.entries(rule.properties)) {
      if (!breakdown[prop]) {
        breakdown[prop] = {
          winner: {
            value,
            computedValue: computedStyleMap[prop] || value,
            important: !!important,
            inherited: !!inherited,
            matchedSelectors: rule.matchedSelectors,
            origin: rule.origin,
            source: rule.source,
            confidence: 'exact',
          },
          overridden: [],
          liveResolution: true,
        };
      } else {
        breakdown[prop].overridden.push({
          value,
          important: !!important,
          inherited: !!inherited,
          matchedSelectors: rule.matchedSelectors,
          origin: rule.origin,
          source: rule.source,
          reason: important && !breakdown[prop].winner.important
            ? 'overridden by !important'
            : 'lower cascade priority',
        });
      }
    }
  }

  // Add computed-only properties (from browser defaults / inheritance)
  // that didn't appear in any matched rule
  for (const [prop, value] of Object.entries(computedStyleMap)) {
    if (!breakdown[prop]) {
      breakdown[prop] = {
        winner: {
          value,
          computedValue: value,
          important: false,
          inherited: false,
          matchedSelectors: ['(browser default or inherited)'],
          origin: 'user-agent',
          source: null,
          confidence: 'exact',
        },
        overridden: [],
        liveResolution: true,
      };
    }
  }

  return breakdown;
}

// ─── Main tool function ───────────────────────────────────────────────────────

async function liveResolve({ selector, port = DEFAULT_PORT, tabUrl = null }) {
  if (!selector) return { error: 'selector is required' };

  // Node 21+ has built-in WebSocket — check for it
  if (typeof WebSocket === 'undefined') {
    return {
      error: 'live_resolve requires Node.js 21 or later for built-in WebSocket support. ' +
        'Your current Node version does not include it. ' +
        'Update Node or use resolve_styles for static analysis.',
    };
  }

  let cdpData;
  try {
    cdpData = await inspect(selector, { port, tabUrl });
  } catch (err) {
    if (err.name === 'CdpNotRunningError' || err.code === 'CDP_NOT_RUNNING') {
      return {
        error: err.message,
        code: 'CDP_NOT_RUNNING',
        fallback: 'Use resolve_styles for static analysis without a running browser.',
      };
    }
    return { error: 'CDP error: ' + err.message };
  }

  // Selector not found in DOM
  if (!cdpData.nodeId) {
    return {
      query: { selector, tab: cdpData.tab },
      found: false,
      properties: {},
      matchedRules: [],
      computedStyles: {},
      liveResolution: true,
      summary: 'No element matching "' + selector + '" was found in the current DOM.',
      agentNote:
        'The selector matched nothing. Check that the element exists and is rendered ' +
        '(not hidden by v-if, conditional rendering, or a loading state). ' +
        'The page inspected was: ' + (cdpData.tab ? cdpData.tab.url : 'unknown'),
    };
  }

  const computedStyleMap = formatComputedStyles(cdpData.computedStyles);
  const matchedRules = formatMatchedRules({
    matchedCSSRules: cdpData.matchedStyles.matchedCSSRules,
    inherited: cdpData.matchedStyles.inherited,
    inlineStyle: cdpData.inlineStyles ? cdpData.inlineStyles.inlineStyle : null,
  });
  const properties = buildPropertyBreakdown(matchedRules, computedStyleMap);

  const authoredCount = matchedRules.filter(r => r.origin === 'author').length;
  const propCount = Object.keys(properties).length;
  const shadowDomNote = cdpData.matchedStyles.pseudoElements && cdpData.matchedStyles.pseudoElements.length > 0
    ? ' Note: pseudo-element styles found — shadow DOM internals are not included.'
    : '';

  return {
    query: { selector, port, tabUrl },
    tab: cdpData.tab,
    found: true,
    liveResolution: true,
    properties,
    matchedRules,
    computedStyles: computedStyleMap,
    summary:
      'Live resolution of "' + selector + '": ' +
      propCount + ' properties resolved, ' +
      authoredCount + ' authored rule(s) matched.' +
      shadowDomNote,
    agentNote:
      'All values are exact — resolved by the browser engine, not static analysis. ' +
      'computedStyles includes inherited and browser-default values. ' +
      'matchedRules shows every rule that applied, in cascade order. ' +
      'properties.winner.computedValue is the final rendered value.',
  };
}

module.exports = { liveResolve };
