/**
 * CSSOM Builder — reads one or more CSS files and builds an in-memory cascade model.
 *
 * The model is a flat ordered list of enriched rules, each carrying:
 *   - selectors (array)
 *   - declarations (array of { prop, value, important })
 *   - source { file, line }
 *   - mediaContext (string | null)
 *   - specificity per selector (computed on build)
 *   - sourceOrder (global integer, cross-file, determines cascade tiebreaking)
 *
 * This is the shared foundation both resolveStyles and traceProperty query against.
 */

const fs = require('fs');
const path = require('path');
const { parseCSS, parseFile } = require('./cssParser');
const { calculateSpecificity, compareSpecificity, specificityToString } = require('./specificity');
const { buildVariableMap, enrichValue, buildVariableSummary } = require('./variableResolver');
const { tagModuleRules, shouldSuppressCrossModuleConflict, enrichWithModuleInfo } = require('./cssModulesAnalyzer');
const { buildComponentGraph, discoverComponentFiles } = require('./astComponentGraph');

const STYLE_EXTENSIONS = new Set(['.css', '.scss']);

function buildCSSOM(filePaths) {
  const flatRules = [];
  let sourceOrder = 0;

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;
    const ext = path.extname(filePath).toLowerCase();
    if (!STYLE_EXTENSIONS.has(ext)) continue;

    const cssText = fs.readFileSync(filePath, 'utf8');
    const rules = parseFile(cssText, filePath);

    for (const rule of rules) {
      for (const selector of rule.selectors) {
        flatRules.push({
          selector: selector.trim(),
          declarations: rule.declarations,
          source: rule.source,
          mediaContext: rule.mediaContext,
          specificity: calculateSpecificity(selector),
          sourceOrder: sourceOrder++,
        });
      }
    }
  }

  const taggedRules = tagModuleRules(flatRules);
  const variableMap = buildVariableMap(taggedRules);
  return { rules: taggedRules, fileCount: filePaths.length, variableMap };
}

/**
 * Discovers all CSS/SCSS files under a directory recursively.
 */
function discoverStyleFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'build', '.next', 'out'].includes(entry.name)) {
          walk(fullPath);
        }
      } else if (STYLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Resolves which value wins for a given property across a set of rules
 * that all potentially apply to an element (pre-filtered to matching rules).
 * Returns { winner, overridden[] }.
 */
function resolveCascade(matchingRules, prop) {
  const relevant = matchingRules.filter(r =>
    r.declarations.some(d => d.prop === prop)
  );

  if (relevant.length === 0) return null;

  // Sort by cascade order: !important first, then specificity, then source order
  const withDecl = relevant.map(rule => ({
    rule,
    decl: rule.declarations.find(d => d.prop === prop),
  }));

  const CONFIDENCE_RANK = { certain: 0, likely: 1, possible: 2 };

  withDecl.sort((a, b) => {
    // !important always wins
    if (a.decl.important && !b.decl.important) return -1;
    if (!a.decl.important && b.decl.important) return 1;
    // confidence first — certain/likely beats possible (possible rules need DOM context)
    const confA = CONFIDENCE_RANK[a.rule.matchConfidence] ?? 1;
    const confB = CONFIDENCE_RANK[b.rule.matchConfidence] ?? 1;
    if (confA !== confB) return confA - confB;
    // then specificity
    const cmp = compareSpecificity(b.rule.specificity, a.rule.specificity);
    if (cmp !== 0) return cmp;
    // then source order (later wins)
    return b.rule.sourceOrder - a.rule.sourceOrder;
  });

  const [winning, ...losing] = withDecl;

  return {
    winner: {
      value: winning.decl.value,
      important: winning.decl.important,
      selector: winning.rule.selector,
      specificity: specificityToString(winning.rule.specificity),
      source: winning.rule.source,
      mediaContext: winning.rule.mediaContext,
    },
    overridden: losing.map(({ rule, decl }) => ({
      value: decl.value,
      important: decl.important,
      selector: rule.selector,
      specificity: specificityToString(rule.specificity),
      source: rule.source,
      mediaContext: rule.mediaContext,
      reason: losing.length > 0
        ? decl.important && !winning.decl.important ? 'overridden by !important'
          : compareSpecificity(rule.specificity, winning.rule.specificity) < 0 ? 'lower specificity'
          : 'earlier in source order'
        : 'lower specificity',
    })),
  };
}

/**
 * Enriches a cascade resolution result with variable resolution data.
 * Adds resolvedValue, variableChain, and conditionalValues to winner and overridden entries.
 */
function enrichResolution(resolution, variableMap, selectorContext) {
  if (!resolution) return null;

  function enrichEntry(entry) {
    const enriched = enrichValue(entry.value, variableMap, selectorContext);
    if (!enriched) return entry;
    return { ...entry, ...enriched };
  }

  return {
    winner: enrichEntry(resolution.winner),
    overridden: resolution.overridden.map(enrichEntry),
  };
}

/**
 * Graph-aware CSSOM builder. Accepts optional componentFiles (JSX/TSX paths)
 * to build an AST component graph alongside the CSSOM. The graph is used by
 * selectorMatcher to upgrade 'possible' confidence to 'likely'.
 */
function buildCSSOMWithGraph(filePaths, componentFiles = []) {
  const cssom = buildCSSOM(filePaths);
  const graph = componentFiles.length > 0
    ? buildComponentGraph(componentFiles)
    : { componentMap: new Map(), ancestorMap: new Map() };
  return { ...cssom, graph };
}

module.exports = { buildCSSOM, buildCSSOMWithGraph, discoverStyleFiles, resolveCascade, enrichResolution, specificityToString, buildVariableSummary, shouldSuppressCrossModuleConflict };
