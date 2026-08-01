/**
 * impact_preview — stylespeak v1.1
 *
 * Answers the question agents need most before editing CSS:
 * "If I change property P on selector S to value V, what else changes?"
 *
 * Statically computes the blast radius of a proposed CSS change across
 * all provided files — no browser required, works in CI, works at edit time.
 *
 * Three categories of impact are returned:
 *
 *  DIRECT impacts — selectors that compete with S for property P.
 *    For each competing rule, we determine whether S currently wins or loses
 *    the cascade for that element context, and what happens after the change.
 *
 *  VARIABLE impacts — if P is a CSS custom property (--name), all rules
 *    across the codebase that use var(P) directly or transitively will see
 *    a different resolved value. These are surfaced with before/after values.
 *
 *  INHERITANCE impacts — properties that inherit (color, font-size, etc.)
 *    affect descendant elements. Rules targeting child selectors that don't
 *    explicitly set P may see a different inherited value after the change.
 *
 * Impact types:
 *   "value-change"              — S wins this property for these elements; value changes
 *   "shielded"                  — higher-specificity rule wins; change has no effect here
 *   "competing-rule-redundant"  — after change, S's new value matches a competing rule's value
 *   "cascade-risk"              — possible-confidence match; change may affect this context
 *   "variable-downstream"       — affected through CSS variable chain
 *   "inheritance-downstream"    — affected through CSS inheritance
 */

const path = require('path');
const { buildCSSOM, discoverStyleFiles, resolveCascade, specificityToString } = require('./cssomBuilder');
const { matchSelector } = require('./selectorMatcher');
const { enrichValue, containsVar } = require('./variableResolver');
const { compareSpecificity } = require('./specificity');

// Properties that CSS inherits by default
const INHERITED_PROPERTIES = new Set([
  'color', 'font', 'font-family', 'font-size', 'font-style', 'font-variant',
  'font-weight', 'font-stretch', 'letter-spacing', 'line-height', 'text-align',
  'text-indent', 'text-transform', 'text-shadow', 'word-spacing', 'word-break',
  'white-space', 'cursor', 'visibility', 'direction', 'quotes', 'list-style',
  'list-style-type', 'list-style-image', 'list-style-position', 'border-collapse',
  'border-spacing', 'caption-side', 'empty-cells', 'orphans', 'widows',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isVariableProperty(property) {
  return property.trim().startsWith('--');
}

function isInherited(property) {
  return INHERITED_PROPERTIES.has(property.toLowerCase());
}

/**
 * Gets the current value of property P on selector S from the CSSOM.
 * Returns null if S doesn't declare P.
 */
function getCurrentValue(cssom, selector, property) {
  const rule = cssom.rules.find(r =>
    r.selector === selector &&
    r.declarations.some(d => d.prop === property)
  );
  if (!rule) return null;
  const decl = rule.declarations.find(d => d.prop === property);
  return decl ? decl.value : null;
}

/**
 * Determines whether `targetSelector` currently wins the cascade for `property`
 * against `competingRule`. Returns 'wins' | 'loses' | 'tied'.
 */
function determineCascadeRelationship(targetRule, competingRule, property) {
  const targetDecl = targetRule.declarations.find(d => d.prop === property);
  const competingDecl = competingRule.declarations.find(d => d.prop === property);

  if (!targetDecl || !competingDecl) return null;

  // !important override
  if (targetDecl.important && !competingDecl.important) return 'wins';
  if (!targetDecl.important && competingDecl.important) return 'loses';

  // Specificity comparison
  const cmp = compareSpecificity(targetRule.specificity, competingRule.specificity);
  if (cmp > 0) return 'wins';
  if (cmp < 0) return 'loses';

  // Source order tiebreak (later wins)
  return targetRule.sourceOrder > competingRule.sourceOrder ? 'wins' : 'loses';
}

// ─── Direct impact analysis ───────────────────────────────────────────────────

function analyzeDirectImpacts(cssom, selector, property, newValue) {
  const impacts = [];

  // Find the target rule (the one being changed)
  const targetRule = cssom.rules.find(r => r.selector === selector);
  if (!targetRule) {
    return [{
      type: 'rule-not-found',
      selector,
      confidence: 'certain',
      reason: '"' + selector + '" was not found in the analyzed files. This would be a new rule — no cascade conflicts to preview.',
    }];
  }

  // Find all rules that declare this property and could overlap with the target selector
  const competingRules = cssom.rules.filter(r => {
    if (r.selector === selector) return false; // skip self
    if (!r.declarations.some(d => d.prop === property)) return false;
    const conf = matchSelector(r.selector, selector);
    if (conf === 'none') {
      // Also check reverse direction — target might be more specific than competitor
      const reverseConf = matchSelector(selector, r.selector);
      return reverseConf !== 'none';
    }
    return true;
  });

  // The target rule itself — direct value change
  impacts.push({
    type: 'value-change',
    affectedSelector: selector,
    currentValue: targetRule.declarations.find(d => d.prop === property)?.value || null,
    newValue: newValue || '(new value)',
    confidence: 'certain',
    specificity: specificityToString(targetRule.specificity),
    source: targetRule.source,
    reason: '"' + selector + '" directly sets ' + property + ' — all elements matching this selector (that aren\'t overridden by a more specific rule) will see the new value.',
  });

  // Analyze each competing rule
  for (const competing of competingRules) {
    const matchConf = matchSelector(competing.selector, selector) !== 'none'
      ? matchSelector(competing.selector, selector)
      : matchSelector(selector, competing.selector);

    const relationship = determineCascadeRelationship(targetRule, competing, property);
    const competingDecl = competing.declarations.find(d => d.prop === property);

    if (relationship === 'wins') {
      // Target currently wins — competing rule is already overridden by our selector
      // After change: target still wins (cascade winner doesn't change), but value changes
      const impact = {
        type: newValue && competingDecl.value === newValue
          ? 'competing-rule-redundant'
          : 'value-change',
        affectedSelector: competing.selector,
        currentValue: competingDecl.value,
        newValue: newValue || '(new value)',
        confidence: matchConf,
        specificity: specificityToString(competing.specificity),
        source: competing.source,
        reason: '"' + selector + '" wins over "' + competing.selector + '" — elements matching both will see the new value.',
      };
      if (impact.type === 'competing-rule-redundant') {
        impact.reason = 'After this change, "' + selector + '" and "' + competing.selector + '" will set the same value (' + newValue + '). The competing rule becomes redundant dead code.';
      }
      impacts.push(impact);

    } else if (relationship === 'loses') {
      // Competing rule currently wins — our target is already overridden
      // After change: competing rule still wins (unless we're adding !important)
      impacts.push({
        type: 'shielded',
        affectedSelector: competing.selector,
        shieldingValue: competingDecl.value,
        confidence: matchConf,
        specificity: specificityToString(competing.specificity),
        source: competing.source,
        reason: '"' + competing.selector + '" has higher priority (specificity: ' + specificityToString(competing.specificity) + ' vs ' + specificityToString(targetRule.specificity) + ') — elements matching both selectors will NOT be affected by this change. The competing rule shields them.',
      });
    } else {
      // Tied or uncertain — flag as risk
      impacts.push({
        type: 'cascade-risk',
        affectedSelector: competing.selector,
        currentValue: competingDecl.value,
        newValue: newValue || '(new value)',
        confidence: matchConf,
        specificity: specificityToString(competing.specificity),
        source: competing.source,
        reason: 'Uncertain cascade relationship between "' + selector + '" and "' + competing.selector + '". Source order determines the winner — review carefully before changing.',
      });
    }
  }

  return impacts;
}

// ─── Variable impact analysis ─────────────────────────────────────────────────

function analyzeVariableImpacts(cssom, property, newValue) {
  const impacts = [];
  const varName = property.trim();

  // Find all rules that use this variable in any property value
  for (const rule of cssom.rules) {
    for (const decl of rule.declarations) {
      if (!containsVar(decl.value)) continue;

      // Check if this declaration references our variable (directly or in chain)
      const currentResolved = enrichValue(decl.value, cssom.variableMap, rule.selector);
      if (!currentResolved) continue;

      // Check if the variable chain mentions our variable
      const chain = currentResolved.variableChain || [];
      const mentionsVar = chain.some(step => step.startsWith(varName + ' \u2192'));
      if (!mentionsVar && !decl.value.includes('var(' + varName)) continue;

      // Compute what the new resolved value would be if we changed the variable
      // Build a fake variable map with the new value substituted
      const fakeMap = new Map(cssom.variableMap);
      if (newValue) {
        const existing = fakeMap.get(varName) || [];
        fakeMap.set(varName, [
          { value: newValue, selector: ':root', specificity: [0, 0, 1, 0], mediaContext: null, sourceOrder: -1 },
          ...existing,
        ]);
      }
      const newResolved = newValue
        ? enrichValue(decl.value, fakeMap, rule.selector)
        : null;

      impacts.push({
        type: 'variable-downstream',
        affectedSelector: rule.selector,
        affectedProperty: decl.prop,
        currentValue: decl.value,
        currentResolvedValue: currentResolved.resolvedValue,
        newResolvedValue: newResolved ? newResolved.resolvedValue : '(depends on new value)',
        variableChain: chain,
        confidence: 'certain',
        source: rule.source,
        reason: '"' + rule.selector + '" uses ' + varName + ' via ' + decl.prop + ': ' + decl.value + '. Resolved value will change from "' + currentResolved.resolvedValue + '" to "' + (newResolved ? newResolved.resolvedValue : 'new value') + '".',
      });
    }
  }

  return impacts;
}

// ─── Inheritance impact analysis ──────────────────────────────────────────────

function analyzeInheritanceImpacts(cssom, selector, property, newValue) {
  if (!isInherited(property)) return [];

  const impacts = [];

  // Find selectors that are likely descendants of our changed selector
  // and DON'T explicitly set this property (so they would inherit)
  for (const rule of cssom.rules) {
    if (rule.selector === selector) continue;

    // Only look at rules that are likely child/descendant selectors
    const matchConf = matchSelector(selector, rule.selector);
    if (matchConf === 'none') continue;

    // Does this rule explicitly set the property? If so, inheritance doesn't matter
    const setsProperty = rule.declarations.some(d => d.prop === property);
    if (setsProperty) continue;

    impacts.push({
      type: 'inheritance-downstream',
      affectedSelector: rule.selector,
      inheritedProperty: property,
      currentInheritedValue: '(inherited from ' + selector + ')',
      newInheritedValue: newValue || '(new value)',
      confidence: matchConf,
      source: rule.source,
      reason: '"' + rule.selector + '" does not set ' + property + ' explicitly and may inherit it from "' + selector + '". Elements matching both will see the inherited value change.',
    });
  }

  return impacts;
}

// ─── Main tool function ───────────────────────────────────────────────────────

function impactPreview({ selector, property, newValue = null, files = [], projectRoot = null }) {
  if (!selector) return { error: 'selector is required' };
  if (!property) return { error: 'property is required' };

  let filePaths = [...files];
  if (projectRoot) filePaths.push(...discoverStyleFiles(projectRoot));
  if (filePaths.length === 0) return { error: 'No CSS files found. Provide files[] or projectRoot.' };

  const cssom = buildCSSOM(filePaths);
  const isVarChange = isVariableProperty(property);

  // Run all three impact categories
  const directImpacts = isVarChange
    ? []
    : analyzeDirectImpacts(cssom, selector, property, newValue);

  const variableImpacts = isVarChange
    ? analyzeVariableImpacts(cssom, property, newValue)
    : [];

  const inheritanceImpacts = isVarChange
    ? []
    : analyzeInheritanceImpacts(cssom, selector, property, newValue);

  const allImpacts = [...directImpacts, ...variableImpacts, ...inheritanceImpacts];

  // Compute blast radius
  const blastRadius = {
    total: allImpacts.length,
    valueChanges: allImpacts.filter(i => i.type === 'value-change').length,
    shielded: allImpacts.filter(i => i.type === 'shielded').length,
    risks: allImpacts.filter(i => i.type === 'cascade-risk').length,
    variableDownstream: variableImpacts.length,
    inheritanceDownstream: inheritanceImpacts.length,
    redundantRules: allImpacts.filter(i => i.type === 'competing-rule-redundant').length,
  };

  // Determine overall risk level
  const hasRisks = blastRadius.risks > 0;
  const hasPossibleImpacts = allImpacts.some(i => i.confidence === 'possible');
  const riskLevel = hasRisks || hasPossibleImpacts ? 'medium'
    : blastRadius.valueChanges > 3 ? 'medium'
    : 'low';

  const safeToChange = riskLevel === 'low' && blastRadius.risks === 0;

  // Build summary
  const summaryParts = [];
  if (blastRadius.valueChanges > 0) summaryParts.push(blastRadius.valueChanges + ' selector(s) will see a different value');
  if (blastRadius.shielded > 0) summaryParts.push(blastRadius.shielded + ' selector(s) are shielded by higher specificity');
  if (blastRadius.risks > 0) summaryParts.push(blastRadius.risks + ' uncertain cascade relationship(s) need review');
  if (blastRadius.variableDownstream > 0) summaryParts.push(blastRadius.variableDownstream + ' rule(s) affected through variable chain');
  if (blastRadius.inheritanceDownstream > 0) summaryParts.push(blastRadius.inheritanceDownstream + ' potential inheritance impact(s)');
  if (blastRadius.redundantRules > 0) summaryParts.push(blastRadius.redundantRules + ' competing rule(s) would become redundant');

  const agentNoteParts = [];
  if (safeToChange) {
    agentNoteParts.push('Change appears safe to make.');
  } else {
    agentNoteParts.push('Review flagged impacts before proceeding.');
  }
  if (blastRadius.shielded > 0) agentNoteParts.push('Shielded selectors are safe — higher-specificity rules protect those elements.');
  if (blastRadius.risks > 0) agentNoteParts.push('Cascade-risk impacts have uncertain source-order relationships — confirm intended behavior.');
  if (blastRadius.variableDownstream > 0) agentNoteParts.push('Variable downstream impacts show exact before/after resolved values.');
  if (blastRadius.inheritanceDownstream > 0) agentNoteParts.push('Inheritance impacts only apply if no closer ancestor sets the property explicitly.');

  return {
    change: {
      selector,
      property,
      currentValue: isVarChange ? null : getCurrentValue(cssom, selector, property),
      newValue,
      isVariableChange: isVarChange,
      isInheritedProperty: isInherited(property),
    },
    blastRadius,
    riskLevel,
    safeToChange,
    impacts: directImpacts,
    variableImpacts,
    inheritanceImpacts,
    query: {
      filesAnalyzed: filePaths.map(f => path.basename(f)),
      rulesScanned: cssom.rules.length,
    },
    summary: 'Impact preview for changing ' + property + ' on "' + selector + '": ' +
      (summaryParts.length > 0 ? summaryParts.join(', ') + '.' : 'No competing rules found — change is isolated.'),
    agentNote: agentNoteParts.join(' '),
  };
}

module.exports = { impactPreview };
