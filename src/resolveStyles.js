/**
 * resolve_styles — answers "what CSS actually applies to this selector?"
 *
 * Given a selector string and a set of files, returns a structured map of every
 * CSS property that could apply, who wins, and who got overridden — with confidence
 * levels so agents know how much to trust each answer.
 */

const path = require('path');
const { buildCSSOM, discoverStyleFiles, resolveCascade } = require('./cssomBuilder');
const { matchSelector } = require('./selectorMatcher');

function resolveStyles({ selector, files = [], projectRoot = null }) {
  if (!selector) return { error: 'selector is required' };

  // Resolve file list
  let filePaths = [...files];
  if (projectRoot) filePaths.push(...discoverStyleFiles(projectRoot));
  if (filePaths.length === 0) return { error: 'No CSS files found. Provide files[] or projectRoot.' };

  const cssom = buildCSSOM(filePaths);

  // Find all rules that could apply to this selector, tagged with match confidence
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
      matchedRules: 0,
      summary: 'No rules found matching "' + selector + '" across ' + filePaths.length + ' file(s).',
      agentNote: 'Either the selector does not exist yet, the files provided do not contain it, or the selector uses a pattern the static analyzer cannot match. Try broadening the file list or checking the selector spelling.',
    };
  }

  // Collect all unique properties across matching rules
  const allProps = new Set();
  for (const rule of matchingRules) {
    for (const decl of rule.declarations) allProps.add(decl.prop);
  }

  // Resolve each property through the cascade
  const properties = {};
  let overrideCount = 0;

  for (const prop of allProps) {
    const resolution = resolveCascade(matchingRules, prop);
    if (!resolution) continue;

    // Confidence for the property = lowest confidence among rules involved
    const involvedRules = matchingRules.filter(r => r.declarations.some(d => d.prop === prop));
    const lowestConfidence = involvedRules.some(r => r.matchConfidence === 'possible') ? 'possible'
      : involvedRules.some(r => r.matchConfidence === 'likely') ? 'likely' : 'certain';

    if (resolution.overridden.length > 0) overrideCount++;

    properties[prop] = {
      winner: resolution.winner,
      overridden: resolution.overridden,
      confidence: lowestConfidence,
    };
  }

  // Group by confidence for the agent note
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

  return {
    query: {
      selector,
      filesAnalyzed: filePaths.map(f => path.basename(f)),
      rulesScanned: cssom.rules.length,
    },
    properties,
    matchedRules: matchingRules.length,
    summary: 'Found ' + Object.keys(properties).length + ' properties applying to "' + selector + '" from ' + matchingRules.length + ' matched rule(s) across ' + filePaths.length + ' file(s).',
    agentNote: agentNoteParts.join(' '),
  };
}

module.exports = { resolveStyles };
