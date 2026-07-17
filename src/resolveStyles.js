/**
 * resolve_styles — answers "what CSS actually applies to this selector?"
 *
 * v0.2: now includes full CSS custom property resolution.
 * Every property value that references a var() gets both the raw value and
 * the fully resolved value, plus the variable chain and any media-context
 * conditional overrides. A top-level `variables` map shows all custom
 * properties found across the analyzed files.
 */

const path = require('path');
const { buildCSSOM, discoverStyleFiles, resolveCascade, enrichResolution, buildVariableSummary } = require('./cssomBuilder');
const { matchSelector } = require('./selectorMatcher');

function resolveStyles({ selector, files = [], projectRoot = null }) {
  if (!selector) return { error: 'selector is required' };

  let filePaths = [...files];
  if (projectRoot) filePaths.push(...discoverStyleFiles(projectRoot));
  if (filePaths.length === 0) return { error: 'No CSS files found. Provide files[] or projectRoot.' };

  const cssom = buildCSSOM(filePaths);
  const { variableMap } = cssom;

  // Find all rules that could apply to this selector
  const matchingRules = [];
  for (const rule of cssom.rules) {
    const confidence = matchSelector(rule.selector, selector);
    if (confidence !== 'none') {
      matchingRules.push({ ...rule, matchConfidence: confidence });
    }
  }

  if (matchingRules.length === 0) {
    return {
      query: { selector, filesAnalyzed: filePaths.map(f => path.basename(f)) },
      properties: {},
      variables: buildVariableSummary(variableMap, selector),
      matchedRules: 0,
      summary: 'No rules found matching "' + selector + '" across ' + filePaths.length + ' file(s).',
      agentNote: 'Either the selector does not exist yet, the files provided do not contain it, or the selector uses a pattern the static analyzer cannot match.',
    };
  }

  // Collect all unique properties
  const allProps = new Set();
  for (const rule of matchingRules) {
    for (const decl of rule.declarations) {
      if (!decl.prop.startsWith('--')) allProps.add(decl.prop);
    }
  }

  // Resolve each property through the cascade + variable enrichment
  const properties = {};
  let overrideCount = 0;
  let varCount = 0;

  for (const prop of allProps) {
    const resolution = resolveCascade(matchingRules, prop);
    if (!resolution) continue;

    const enriched = enrichResolution(resolution, variableMap, selector);

    const involvedRules = matchingRules.filter(r => r.declarations.some(d => d.prop === prop));
    const lowestConfidence = involvedRules.some(r => r.matchConfidence === 'possible') ? 'possible'
      : involvedRules.some(r => r.matchConfidence === 'likely') ? 'likely' : 'certain';

    if (enriched.overridden.length > 0) overrideCount++;
    if (enriched.winner.resolvedValue !== undefined) varCount++;

    properties[prop] = {
      winner: enriched.winner,
      overridden: enriched.overridden,
      confidence: lowestConfidence,
    };
  }

  const certain = Object.entries(properties).filter(([, v]) => v.confidence === 'certain').map(([k]) => k);
  const likely = Object.entries(properties).filter(([, v]) => v.confidence === 'likely').map(([k]) => k);
  const possible = Object.entries(properties).filter(([, v]) => v.confidence === 'possible').map(([k]) => k);
  const mediaWinners = Object.values(properties).filter(p => p.winner.mediaContext).length;

  const agentNoteParts = [];
  if (certain.length) agentNoteParts.push(certain.length + ' propert' + (certain.length === 1 ? 'y is' : 'ies are') + ' certain (exact selector match).');
  if (likely.length) agentNoteParts.push(likely.length + ' propert' + (likely.length === 1 ? 'y is' : 'ies are') + ' likely (rule applies to this selector based on token overlap).');
  if (possible.length) agentNoteParts.push(possible.length + ' propert' + (possible.length === 1 ? 'y is' : 'ies are') + ' possible (via ancestor/combinator rule - depends on DOM context).');
  if (overrideCount) agentNoteParts.push(overrideCount + ' propert' + (overrideCount === 1 ? 'y has' : 'ies have') + ' overridden rules - review before modifying.');
  if (mediaWinners > 0) agentNoteParts.push(mediaWinners + ' propert' + (mediaWinners === 1 ? "y's" : "ies'") + ' winning value comes from a @media rule - only applies at that breakpoint.');
  if (varCount > 0) agentNoteParts.push(varCount + ' propert' + (varCount === 1 ? 'y uses' : 'ies use') + ' CSS custom properties - resolved values shown alongside raw var() references.');

  return {
    query: {
      selector,
      filesAnalyzed: filePaths.map(f => path.basename(f)),
      rulesScanned: cssom.rules.length,
    },
    properties,
    variables: buildVariableSummary(variableMap, selector),
    matchedRules: matchingRules.length,
    summary: 'Found ' + Object.keys(properties).length + ' properties applying to "' + selector + '" from ' + matchingRules.length + ' matched rule(s) across ' + filePaths.length + ' file(s).',
    agentNote: agentNoteParts.join(' '),
  };
}

module.exports = { resolveStyles };
