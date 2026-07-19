/**
 * Selector matcher — determines whether a CSS rule's selector could apply
 * to a queried selector string, without a real DOM.
 *
 * Three match levels, each returned with a confidence score:
 *
 *  'certain'  — selectors are identical (exact match)
 *  'likely'   — the rule selector's rightmost compound is a subset of the query
 *               (e.g. rule ".btn" matches query ".btn.primary" — .btn would apply)
 *  'possible' — the rule uses a combinator that could apply to an ancestor/sibling
 *               of the queried element (e.g. ".sidebar .btn" when querying ".btn")
 *
 * 'none' means no meaningful relationship — skip.
 */

const { graphConfirmsAncestry } = require('./astComponentGraph');

function parseCompound(selector) {
  // Split on combinators, return rightmost compound selector's tokens
  const parts = selector.trim().split(/(?<=[^\s>+~])\s*[\s>+~]+\s*/);
  const rightmost = parts[parts.length - 1].trim();
  const tokens = new Set();

  // IDs
  for (const m of rightmost.matchAll(/#([\w-]+)/g)) tokens.add('#' + m[1]);
  // Classes
  for (const m of rightmost.matchAll(/\.([\w-]+)/g)) tokens.add('.' + m[1]);
  // Tag
  const tagMatch = rightmost.match(/^([a-zA-Z][\w-]*)/);
  if (tagMatch && tagMatch[1] !== '*') tokens.add(tagMatch[1].toLowerCase());
  // Attrs
  for (const m of rightmost.matchAll(/\[([^\]]+)\]/g)) tokens.add('[' + m[1] + ']');

  return { tokens, hasCombinator: parts.length > 1, full: selector.trim() };
}

function matchSelector(ruleSelector, querySelector) {
  const rule = parseCompound(ruleSelector);
  const query = parseCompound(querySelector);

  // Exact match
  if (rule.full === query.full) return 'certain';

  // Combinator check must come before subset check — a rule like ".sidebar .btn"
  // has rightmost compound ".btn" which would falsely match as 'likely' against
  // a query of ".btn" if we checked subsets first. Combinator rules always require
  // DOM context so the best they can be is 'possible'.
  if (rule.hasCombinator) {
    for (const t of rule.tokens) {
      if (query.tokens.has(t)) return 'possible';
    }
    return 'none';
  }

  // No combinator — rule tokens are a subset of query tokens → likely
  // e.g. rule ".btn" vs query ".btn.primary" → .btn would apply to .btn.primary
  if (rule.tokens.size > 0) {
    let allMatch = true;
    for (const t of rule.tokens) {
      if (!query.tokens.has(t)) { allMatch = false; break; }
    }
    if (allMatch) return 'likely';
  }

  return 'none';
}

/**
 * Graph-aware selector matching. Same as matchSelector but upgrades
 * 'possible' to 'likely' when the AST component graph confirms the
 * ancestor relationship actually exists in the component tree.
 */
function matchSelectorWithGraph(ruleSelector, querySelector, ancestorMap) {
  const base = matchSelector(ruleSelector, querySelector);
  if (base !== 'possible' || !ancestorMap) return base;

  // Extract the ancestor token from the rule selector (the non-rightmost part)
  const rule = parseCompound(ruleSelector);
  const query = parseCompound(querySelector);

  if (!rule.hasCombinator) return base;

  // Check if any ancestor class in the rule is confirmed as an ancestor
  // of any class in the query by the component graph
  const ruleParts = ruleSelector.trim().split(/(?<=[^\s>+~])\s*[\s>+~]+\s*/);
  const ancestorSelector = ruleParts.slice(0, -1).join(' ');
  const ancestorTokens = parseCompound(ancestorSelector).tokens;

  for (const ancestorClass of ancestorTokens) {
    for (const queryClass of query.tokens) {
      if (graphConfirmsAncestry(ancestorClass, queryClass, ancestorMap)) {
        return 'likely';
      }
    }
  }

  return base;
}

module.exports = { matchSelector, matchSelectorWithGraph, parseCompound };
