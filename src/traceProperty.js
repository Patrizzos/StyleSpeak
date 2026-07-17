/**
 * trace_property — answers "everywhere this CSS property is set, who wins?"
 *
 * Given a property name and a set of files, returns every rule that touches
 * that property — grouped by selector, showing who wins and who loses for each
 * competing group. Useful for agents trying to understand the full blast radius
 * of a property before changing it.
 */

const path = require('path');
const { buildCSSOM, discoverStyleFiles, resolveCascade, enrichResolution, specificityToString, buildVariableSummary } = require('./cssomBuilder');
const { matchSelector } = require('./selectorMatcher');

function traceProperty({ property, files = [], projectRoot = null }) {
  if (!property) return { error: 'property is required' };

  let filePaths = [...files];
  if (projectRoot) filePaths.push(...discoverStyleFiles(projectRoot));
  if (filePaths.length === 0) return { error: 'No CSS files found. Provide files[] or projectRoot.' };

  const cssom = buildCSSOM(filePaths);
  const { variableMap } = cssom;

  // Find every rule that sets this property
  const occurrences = cssom.rules.filter(rule =>
    rule.declarations.some(d => d.prop === property.toLowerCase())
  );

  if (occurrences.length === 0) {
    return {
      query: { property, filesAnalyzed: filePaths.map(f => path.basename(f)) },
      occurrences: [],
      competingGroups: [],
      summary: `"${property}" is not set in any of the ${filePaths.length} analyzed file(s).`,
      agentNote: `The property doesn't exist yet — safe to introduce. Check inherited values or browser defaults if you're seeing unexpected behavior.`,
    };
  }

  // Build competing groups: selectors that could target overlapping elements.
  // Two rules compete if EITHER direction of matchSelector returns non-'none' —
  // e.g. .btn competes with .btn.primary because .btn applies to .btn.primary elements,
  // even though .btn.primary does not apply to plain .btn elements.
  const groups = [];
  const assigned = new Set();

  for (let i = 0; i < occurrences.length; i++) {
    if (assigned.has(i)) continue;
    const group = [occurrences[i]];
    assigned.add(i);

    for (let j = i + 1; j < occurrences.length; j++) {
      if (assigned.has(j)) continue;
      const confAB = matchSelector(occurrences[j].selector, occurrences[i].selector);
      const confBA = matchSelector(occurrences[i].selector, occurrences[j].selector);
      if (confAB !== 'none' || confBA !== 'none') {
        group.push(occurrences[j]);
        assigned.add(j);
      }
    }

    if (group.length > 1) {
      const resolution = resolveCascade(group, property.toLowerCase());
      const enriched = resolution ? enrichResolution(resolution, variableMap, occurrences[i].selector) : null;
      groups.push({
        selectors: group.map(r => r.selector),
        winner: enriched ? enriched.winner : null,
        overridden: enriched ? enriched.overridden : [],
      });
    }
  }

  // Format all occurrences for output
  const formatted = occurrences.map(rule => {
    const decl = rule.declarations.find(d => d.prop === property.toLowerCase());
    const enriched = enrichResolution(
      { winner: { value: decl.value, important: decl.important, selector: rule.selector, specificity: specificityToString(rule.specificity), source: rule.source, mediaContext: rule.mediaContext }, overridden: [] },
      variableMap,
      rule.selector
    );
    return {
      selector: rule.selector,
      value: decl.value,
      resolvedValue: enriched.winner.resolvedValue,
      variableChain: enriched.winner.variableChain,
      conditionalValues: enriched.winner.conditionalValues,
      important: decl.important,
      specificity: specificityToString(rule.specificity),
      source: rule.source,
      mediaContext: rule.mediaContext || null,
    };
  });

  const affectedFiles = [...new Set(occurrences.map(r => path.basename(r.source.file)))];

  return {
    query: {
      property,
      filesAnalyzed: filePaths.map(f => path.basename(f)),
      rulesScanned: cssom.rules.length,
    },
    occurrences: formatted,
    competingGroups: groups,
    variables: buildVariableSummary(variableMap, null),
    summary: `"${property}" is set ${occurrences.length} time(s) across ${affectedFiles.join(', ')}.${groups.length > 0 ? ` ${groups.length} competing group(s) found where rules override each other.` : ''}`,
    agentNote: groups.length > 0
      ? `Changing "${property}" in one rule may have no effect if a competing rule with higher specificity or later source order wins. Review competing groups before editing.`
      : `No competing rules found — changes to "${property}" in these selectors should apply cleanly.`,
  };
}

module.exports = { traceProperty };
