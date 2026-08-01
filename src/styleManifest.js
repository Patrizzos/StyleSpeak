/**
 * style_manifest — stylespeak v1.2
 *
 * Builds a compressed, structured summary of a project's entire CSS knowledge
 * that an agent can load ONCE at the start of a session and keep in context —
 * instead of repeatedly querying individual files or running resolve_styles
 * on every selector it encounters.
 *
 * The manifest answers the most common agent questions up front:
 *   - What selectors exist and what do they set?
 *   - Which selectors compete with each other?
 *   - What CSS variables exist and what do they resolve to?
 *   - Where are the specificity hotspots worth watching?
 *   - Which files are CSS Modules?
 *
 * Token budget: designed to stay under ~10K tokens for medium projects (50-100 selectors).
 * Large projects can use maxSelectors to limit output to the most complex/risky selectors.
 *
 * The manifest is a READ artifact. For deep analysis of a specific selector or property,
 * agents should follow up with resolve_styles, trace_property, or impact_preview.
 */

const path = require('path');
const { buildCSSOM, discoverStyleFiles, specificityToString } = require('./cssomBuilder');
const { buildVariableSummary, enrichValue, containsVar } = require('./variableResolver');
const { matchSelector } = require('./selectorMatcher');
const { isCSSModule } = require('./cssModulesAnalyzer');

// ─── Selector index builder ───────────────────────────────────────────────────

/**
 * Builds a compact selector index.
 * For each unique selector, summarises: sources, properties set, specificity,
 * whether it's from a CSS Module, and a pre-computed override count.
 */
function buildSelectorIndex(rules) {
  const index = new Map(); // selector → { specificity, sources, properties, cssModule }

  for (const rule of rules) {
    const sel = rule.selector;
    if (!index.has(sel)) {
      index.set(sel, {
        specificity: specificityToString(rule.specificity),
        sources: [],
        properties: new Set(),
        cssModule: !!rule.cssModule,
        localScope: !!rule.localScope,
      });
    }
    const entry = index.get(sel);
    // Add source if not already listed
    const src = path.basename(rule.source.file) + ':' + rule.source.line;
    if (!entry.sources.includes(src)) entry.sources.push(src);
    // Collect property names (not values — keeps manifest compact)
    for (const decl of rule.declarations) {
      if (!decl.prop.startsWith('--')) entry.properties.add(decl.prop);
    }
    // Merge module status
    if (rule.cssModule) entry.cssModule = true;
  }

  return index;
}

/**
 * Builds competition relationships between selectors.
 * Returns Map: selector → Set<competing selector>
 * Two selectors compete if they both set the same property and could match
 * overlapping elements.
 */
function buildCompetitionMap(rules, selectorIndex) {
  const competitionMap = new Map();

  // Group rules by property
  const byProperty = new Map();
  for (const rule of rules) {
    for (const decl of rule.declarations) {
      if (decl.prop.startsWith('--')) continue;
      if (!byProperty.has(decl.prop)) byProperty.set(decl.prop, []);
      byProperty.get(decl.prop).push(rule);
    }
  }

  // For each property, check selector overlap between all pairs
  for (const [, propertyRules] of byProperty) {
    if (propertyRules.length < 2) continue;

    for (let i = 0; i < propertyRules.length; i++) {
      for (let j = i + 1; j < propertyRules.length; j++) {
        const a = propertyRules[i];
        const b = propertyRules[j];

        const confAB = matchSelector(a.selector, b.selector);
        const confBA = matchSelector(b.selector, a.selector);

        if (confAB === 'none' && confBA === 'none') continue;

        // Don't flag cross-module conflicts — they can't actually conflict
        if (a.cssModule && b.cssModule && a.source.file !== b.source.file) continue;

        if (!competitionMap.has(a.selector)) competitionMap.set(a.selector, new Set());
        if (!competitionMap.has(b.selector)) competitionMap.set(b.selector, new Set());
        competitionMap.get(a.selector).add(b.selector);
        competitionMap.get(b.selector).add(a.selector);
      }
    }
  }

  return competitionMap;
}

// ─── Property index builder ───────────────────────────────────────────────────

function buildPropertyIndex(rules) {
  const index = new Map(); // property → { totalRules, selectors, hasVariable }

  for (const rule of rules) {
    for (const decl of rule.declarations) {
      if (decl.prop.startsWith('--')) continue;
      if (!index.has(decl.prop)) {
        index.set(decl.prop, { totalRules: 0, selectors: [], hasVariableValue: false });
      }
      const entry = index.get(decl.prop);
      entry.totalRules++;
      if (!entry.selectors.includes(rule.selector)) entry.selectors.push(rule.selector);
      if (containsVar(decl.value)) entry.hasVariableValue = true;
    }
  }

  return index;
}

// ─── Variable index builder ───────────────────────────────────────────────────

function buildVariableIndex(rules, variableMap) {
  const index = {};

  for (const [name, entries] of variableMap) {
    const summary = buildVariableSummary(new Map([[name, entries]]), null);
    const varSummary = summary[name];
    if (!varSummary) continue;

    // Find which properties and selectors use this variable
    const usedBySelectors = [];
    const usedByProperties = new Set();

    for (const rule of rules) {
      for (const decl of rule.declarations) {
        if (!containsVar(decl.value)) continue;
        const enriched = enrichValue(decl.value, variableMap, rule.selector);
        if (!enriched) continue;
        const chain = enriched.variableChain || [];
        if (chain.some(step => step.startsWith(name + ' \u2192'))) {
          if (!usedBySelectors.includes(rule.selector)) usedBySelectors.push(rule.selector);
          usedByProperties.add(decl.prop);
        }
      }
    }

    index[name] = {
      value: varSummary.value,
      resolvedValue: varSummary.resolvedValue,
      scope: varSummary.selector,
      usedByProperties: [...usedByProperties],
      usedBySelectors,
      conditionalValues: varSummary.conditionalValues,
    };
  }

  return index;
}

// ─── Risk hotspot detector ────────────────────────────────────────────────────

function identifyRiskHotspots(selectorIndex, competitionMap, rules) {
  const hotspots = [];

  for (const [selector, info] of selectorIndex) {
    const competitors = competitionMap.get(selector) || new Set();
    const overrideCount = competitors.size;

    // Risk factors
    let riskScore = 0;
    const reasons = [];

    if (overrideCount >= 3) { riskScore += 3; reasons.push(overrideCount + ' competing rules'); }
    else if (overrideCount >= 1) { riskScore += 1; }

    // High specificity (ID in selector)
    if (info.specificity.match(/\(0,[1-9]/)) { riskScore += 2; reasons.push('ID-level specificity'); }

    // Many properties set (broad rule)
    if (info.properties.size > 8) { riskScore += 1; reasons.push(info.properties.size + ' properties set'); }

    // Multiple source locations (same selector declared in multiple places)
    if (info.sources.length > 1) { riskScore += 2; reasons.push('declared in ' + info.sources.length + ' locations'); }

    if (riskScore >= 2) {
      hotspots.push({
        selector,
        riskLevel: riskScore >= 5 ? 'high' : riskScore >= 3 ? 'medium' : 'low',
        reasons,
        competingWith: [...competitors],
        action: 'Call resolve_styles("' + selector + '", files) for full cascade analysis',
      });
    }
  }

  // Sort by risk level
  return hotspots.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.riskLevel] - order[b.riskLevel];
  });
}

// ─── File summary ─────────────────────────────────────────────────────────────

function buildFileSummary(rules, filePaths) {
  const summary = {};

  for (const filePath of filePaths) {
    const basename = path.basename(filePath);
    const fileRules = rules.filter(r => r.source.file === filePath);
    const selectors = [...new Set(fileRules.map(r => r.selector))];
    summary[basename] = {
      path: filePath,
      selectorCount: selectors.length,
      cssModule: isCSSModule(filePath),
      selectors,
    };
  }

  return summary;
}

// ─── Agent guide generator ────────────────────────────────────────────────────

function generateAgentGuide(meta, hotspots, variableCount) {
  const parts = [
    'This manifest summarises ' + meta.selectorCount + ' CSS selectors across ' +
    meta.fileCount + ' file(s). Use it as a reference at the start of a session.',
    '',
    'BEFORE editing any selector:',
    '  1. Check "riskHotspots" — high-risk selectors need extra care.',
    '  2. Call impact_preview(selector, property, files) to see what else changes.',
    '  3. Call resolve_styles(selector, files) if you need the full cascade picture.',
    '',
    'BEFORE changing a CSS variable:',
    '  1. Find it in "variables" to see every selector that uses it.',
    '  2. Call impact_preview(":root", "--var-name", files) for downstream impact.',
    '',
  ];

  if (hotspots.length > 0) {
    parts.push('HIGH-PRIORITY HOTSPOTS (' + hotspots.filter(h => h.riskLevel === 'high').length + ' high, ' +
      hotspots.filter(h => h.riskLevel === 'medium').length + ' medium):');
    for (const h of hotspots.slice(0, 5)) {
      parts.push('  ' + h.riskLevel.toUpperCase() + ': ' + h.selector + ' — ' + h.reasons.join(', '));
    }
    if (hotspots.length > 5) parts.push('  ... and ' + (hotspots.length - 5) + ' more. See riskHotspots array.');
    parts.push('');
  }

  if (variableCount > 0) {
    parts.push('CSS VARIABLES: ' + variableCount + ' custom propert' + (variableCount === 1 ? 'y' : 'ies') +
      ' found. See "variables" for resolved values and usage.');
  }

  parts.push('');
  parts.push('For deep analysis of any selector, call resolve_styles or trace_property with the full file paths.');

  return parts.join('\n');
}

// ─── Main tool function ───────────────────────────────────────────────────────

function styleManifest({ files = [], projectRoot = null, maxSelectors = 200 }) {
  let filePaths = [...files];
  if (projectRoot) filePaths.push(...discoverStyleFiles(projectRoot));
  if (filePaths.length === 0) return { error: 'No CSS files found. Provide files[] or projectRoot.' };

  const cssom = buildCSSOM(filePaths);
  const { rules, variableMap } = cssom;

  // Build all indexes
  const selectorIndex = buildSelectorIndex(rules);
  const competitionMap = buildCompetitionMap(rules, selectorIndex);
  const propertyIndex = buildPropertyIndex(rules);
  const variableIndex = buildVariableIndex(rules, variableMap);
  const hotspots = identifyRiskHotspots(selectorIndex, competitionMap, rules);
  const fileSummary = buildFileSummary(rules, filePaths);

  // Serialize selector index — apply maxSelectors limit by prioritising risky selectors
  const hotspotSelectors = new Set(hotspots.map(h => h.selector));
  const selectorEntries = [...selectorIndex.entries()];

  // Sort: hotspot selectors first, then by override count, then alphabetically
  selectorEntries.sort(([selA], [selB]) => {
    const aHot = hotspotSelectors.has(selA) ? 0 : 1;
    const bHot = hotspotSelectors.has(selB) ? 0 : 1;
    if (aHot !== bHot) return aHot - bHot;
    const aCmp = (competitionMap.get(selA) || new Set()).size;
    const bCmp = (competitionMap.get(selB) || new Set()).size;
    return bCmp - aCmp;
  });

  const truncated = selectorEntries.length > maxSelectors;
  const outputEntries = selectorEntries.slice(0, maxSelectors);

  const selectors = {};
  for (const [sel, info] of outputEntries) {
    const competitors = [...(competitionMap.get(sel) || new Set())];
    selectors[sel] = {
      specificity: info.specificity,
      sources: info.sources,
      properties: [...info.properties],
      competingWith: competitors.length > 0 ? competitors : undefined,
      overrideCount: competitors.length,
      cssModule: info.cssModule || undefined,
      localScope: info.localScope || undefined,
    };
  }

  // Serialize property index (only properties with >1 rule — single rules are unambiguous)
  const properties = {};
  for (const [prop, info] of propertyIndex) {
    if (info.totalRules > 1) {
      properties[prop] = {
        totalRules: info.totalRules,
        selectors: info.selectors,
        hasVariableValue: info.hasVariableValue || undefined,
      };
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    filesAnalyzed: filePaths.map(f => path.basename(f)),
    fileCount: filePaths.length,
    selectorCount: selectorIndex.size,
    outputSelectorCount: outputEntries.length,
    truncated,
    propertyCount: propertyIndex.size,
    variableCount: Object.keys(variableIndex).length,
    competitionGroupCount: [...competitionMap.values()].filter(s => s.size > 0).length / 2 | 0,
    cssModuleCount: filePaths.filter(f => isCSSModule(f)).length,
    hotspotCount: hotspots.length,
  };

  return {
    meta,
    selectors,
    properties,
    variables: variableIndex,
    riskHotspots: hotspots,
    files: fileSummary,
    agentGuide: generateAgentGuide(meta, hotspots, meta.variableCount),
    note: truncated
      ? 'Output limited to ' + maxSelectors + ' selectors (project has ' + selectorIndex.size + '). Increase maxSelectors or use projectRoot with a more specific path.'
      : undefined,
  };
}

module.exports = { styleManifest };
