/**
 * CSS Custom Property (variable) resolver — stylespeak v0.2
 *
 * Builds a variable map from parsed CSS rules and resolves var() references
 * in declaration values, handling:
 *   - Simple: var(--name)
 *   - Fallback: var(--name, fallback-value)
 *   - Nested fallback: var(--name, var(--other, default))
 *   - Chained: --a: var(--b), --b: #fff → --a resolves to #fff
 *   - Scoped: .card { --bg: white } overrides :root { --bg: #f9f9f9 } for .card elements
 *   - Media-context: @media (prefers-color-scheme: dark) { :root { --color: #fff } }
 *   - Circular reference protection (max depth 10)
 */

const { calculateSpecificity, compareSpecificity } = require('./specificity');
const { matchSelector } = require('./selectorMatcher');

const MAX_RESOLVE_DEPTH = 10;

// ─── Variable map builder ────────────────────────────────────────────────────

/**
 * Extracts all CSS custom property declarations from a flat rule list.
 * Returns a Map: variableName → [ { value, selector, specificity, mediaContext, sourceOrder } ]
 */
function buildVariableMap(rules) {
  const map = new Map();

  for (const rule of rules) {
    for (const decl of rule.declarations) {
      if (!decl.prop.startsWith('--')) continue;
      if (!map.has(decl.prop)) map.set(decl.prop, []);
      map.get(decl.prop).push({
        value: decl.value,
        selector: rule.selector,
        specificity: rule.specificity,
        mediaContext: rule.mediaContext,
        sourceOrder: rule.sourceOrder,
      });
    }
  }

  return map;
}

// ─── var() expression parser ─────────────────────────────────────────────────

/**
 * Parses a var() expression into { name, fallback }.
 * Handles nested var() in the fallback correctly by tracking parenthesis depth.
 * e.g. "var(--color-primary, var(--color-fallback, #2563eb))"
 *      → { name: "--color-primary", fallback: "var(--color-fallback, #2563eb)" }
 */
function parseVarExpression(expr) {
  const trimmed = expr.trim();
  if (!trimmed.startsWith('var(') || !trimmed.endsWith(')')) return null;

  const inner = trimmed.slice(4, -1).trim();
  let depth = 0;
  let commaIdx = -1;

  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) { commaIdx = i; break; }
  }

  const name = (commaIdx === -1 ? inner : inner.slice(0, commaIdx)).trim();
  const fallback = commaIdx === -1 ? null : inner.slice(commaIdx + 1).trim();

  if (!name.startsWith('--')) return null;
  return { name, fallback };
}

/**
 * Finds all var() expressions in a CSS value string, respecting nesting.
 * Returns true if the value contains any var() reference.
 */
function containsVar(value) {
  return /\bvar\s*\(/.test(value);
}

// ─── Scope resolver ──────────────────────────────────────────────────────────

function isGlobalSelector(selector) {
  const s = selector.trim().toLowerCase();
  return s === ':root' || s === 'html' || s === '*' || s === 'body';
}

/**
 * Given a variable name, selector context, and variable map, returns the winning
 * declaration for that variable — applying the same cascade rules (scope specificity,
 * source order) that browsers use for custom property inheritance.
 *
 * Media-context entries are returned separately as conditionalValues.
 */
function resolveVariableDeclaration(name, selectorContext, variableMap) {
  const entries = variableMap.get(name);
  if (!entries || entries.length === 0) return null;

  const baseEntries = entries.filter(e => !e.mediaContext);
  const mediaEntries = entries.filter(e => e.mediaContext);

  // Global selectors (:root, html, *) always apply.
  // Scoped selectors (.dark-theme, #sidebar) only apply when they match the context.
  const matchingBase = baseEntries.filter(e => {
    if (!selectorContext) return true;
    if (isGlobalSelector(e.selector)) return true;
    const conf = matchSelector(e.selector, selectorContext);
    return conf !== 'none';
  });

  // If nothing matched at all, fall back to global-only entries so we always
  // have a value rather than returning null for a declared variable.
  const candidates = matchingBase.length > 0
    ? matchingBase
    : baseEntries.filter(e => isGlobalSelector(e.selector));

  if (candidates.length === 0) return null;

  // Sort by specificity then source order
  candidates.sort((a, b) => {
    const cmp = compareSpecificity(b.specificity, a.specificity);
    return cmp !== 0 ? cmp : b.sourceOrder - a.sourceOrder;
  });

  const winner = candidates[0] || null;

  // Collect unique media-context overrides
  const conditionalByMedia = new Map();
  for (const e of mediaEntries) {
    const key = e.mediaContext;
    if (!conditionalByMedia.has(key)) conditionalByMedia.set(key, e);
    else {
      const existing = conditionalByMedia.get(key);
      const cmp = compareSpecificity(e.specificity, existing.specificity);
      if (cmp > 0 || (cmp === 0 && e.sourceOrder > existing.sourceOrder)) {
        conditionalByMedia.set(key, e);
      }
    }
  }

  return {
    winner,
    conditionalEntries: [...conditionalByMedia.values()],
  };
}

// ─── Recursive value resolver ────────────────────────────────────────────────

/**
 * Resolves a CSS value that may contain one or more var() references.
 * Returns { resolvedValue, variableChain, conditionalValues, unresolved }
 *
 * - resolvedValue: the fully resolved string (variables substituted)
 * - variableChain: array of strings documenting the resolution path
 * - conditionalValues: array of { resolvedValue, mediaContext } for media-scoped overrides
 * - unresolved: array of variable names that couldn't be resolved
 */
function resolveValue(value, variableMap, selectorContext, depth = 0, chain = []) {
  if (depth > MAX_RESOLVE_DEPTH) {
    return { resolvedValue: value, variableChain: chain, conditionalValues: [], unresolved: ['circular reference detected'] };
  }

  if (!containsVar(value)) {
    return { resolvedValue: value, variableChain: chain, conditionalValues: [], unresolved: [] };
  }

  // Find the outermost var() in the value and replace it
  // We process left-to-right, one var() at a time
  const varRegex = /var\s*\(/g;
  let match;
  let result = value;
  const allConditional = [];
  const allUnresolved = [];

  // Collect all var() start positions
  const varPositions = [];
  while ((match = varRegex.exec(value)) !== null) {
    varPositions.push(match.index);
  }

  // Process from right to left so replacements don't shift earlier indices
  for (let p = varPositions.length - 1; p >= 0; p--) {
    const startIdx = varPositions[p];

    // Find matching closing paren
    let depth2 = 0;
    let endIdx = startIdx + 3; // "var" length
    while (endIdx < result.length) {
      if (result[endIdx] === '(') depth2++;
      else if (result[endIdx] === ')') {
        depth2--;
        if (depth2 === 0) break;
      }
      endIdx++;
    }

    const varExpr = result.slice(startIdx, endIdx + 1);
    const parsed = parseVarExpression(varExpr);
    if (!parsed) continue;

    const { name, fallback } = parsed;
    const resolution = resolveVariableDeclaration(name, selectorContext, variableMap);

    if (resolution && resolution.winner) {
      const winnerValue = resolution.winner.value;
      chain.push(name + ' \u2192 ' + winnerValue);

      // Recursively resolve the winner value in case it's also a variable
      const nested = resolveValue(winnerValue, variableMap, selectorContext, depth + 1, chain);
      const finalValue = nested.resolvedValue;
      allUnresolved.push(...nested.unresolved);

      // Resolve conditional (media) values
      for (const conditional of resolution.conditionalEntries) {
        const condResolved = resolveValue(conditional.value, variableMap, selectorContext, depth + 1, []);
        allConditional.push({
          mediaContext: conditional.mediaContext,
          rawValue: conditional.value,
          resolvedValue: condResolved.resolvedValue,
        });
      }

      result = result.slice(0, startIdx) + finalValue + result.slice(endIdx + 1);
    } else if (fallback !== null) {
      // Variable not found — use fallback
      chain.push(name + ' \u2192 (not found, using fallback: ' + fallback + ')');
      const fallbackResolved = resolveValue(fallback, variableMap, selectorContext, depth + 1, chain);
      result = result.slice(0, startIdx) + fallbackResolved.resolvedValue + result.slice(endIdx + 1);
      allUnresolved.push(...fallbackResolved.unresolved);
    } else {
      // Variable not found, no fallback
      chain.push(name + ' \u2192 (not found)');
      allUnresolved.push(name);
      // Leave the var() expression in place — don't substitute
    }
  }

  return {
    resolvedValue: result,
    variableChain: chain,
    conditionalValues: allConditional,
    unresolved: allUnresolved,
  };
}

// ─── Declaration enricher ────────────────────────────────────────────────────

/**
 * Takes a value string and returns enriched resolution data if it contains var().
 * Returns null if the value has no var() references.
 */
function enrichValue(value, variableMap, selectorContext) {
  if (!containsVar(value)) return null;

  const { resolvedValue, variableChain, conditionalValues, unresolved } = resolveValue(
    value, variableMap, selectorContext, 0, []
  );

  return {
    resolvedValue,
    variableChain,
    conditionalValues: conditionalValues.length > 0 ? conditionalValues : undefined,
    unresolved: unresolved.length > 0 ? unresolved : undefined,
  };
}

/**
 * Builds a clean variable summary map for top-level report output.
 * Returns an object: { '--var-name': { value, resolvedValue, selector, mediaContext?, chain? } }
 */
function buildVariableSummary(variableMap, selectorContext) {
  const summary = {};

  for (const [name, entries] of variableMap) {
    const resolution = resolveVariableDeclaration(name, selectorContext, variableMap);
    if (!resolution || !resolution.winner) continue;

    const winner = resolution.winner;
    const enriched = enrichValue(winner.value, variableMap, selectorContext);

    summary[name] = {
      value: winner.value,
      resolvedValue: enriched ? enriched.resolvedValue : winner.value,
      selector: winner.selector,
      mediaContext: winner.mediaContext || undefined,
      variableChain: enriched ? enriched.variableChain : undefined,
      conditionalValues: resolution.conditionalEntries.length > 0
        ? resolution.conditionalEntries.map(c => ({
            mediaContext: c.mediaContext,
            value: c.value,
          }))
        : undefined,
    };
  }

  return summary;
}

module.exports = { buildVariableMap, enrichValue, buildVariableSummary, containsVar };
