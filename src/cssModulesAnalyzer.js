/**
 * CSS Modules analyzer — stylespeak v0.3
 *
 * CSS Modules (.module.css, .module.scss) locally scope every class name at
 * build time — `.btn` becomes `.btn_abc123` in the compiled output. This means:
 *
 *   1. Cross-file cascade conflicts between two module files don't exist at
 *      the CSS level (each class is unique after compilation).
 *   2. Within a single module file, cascade rules still apply normally.
 *   3. Global selectors (:root, *, html, element selectors) in module files
 *      are NOT scoped and behave as normal CSS.
 *
 * This module provides:
 *   - isCSSModule(filePath)  — detects module files by filename convention
 *   - tagModuleRules(rules)  — marks rules from module files with cssModule: true
 *   - shouldSuppressCrossModuleConflict(ruleA, ruleB) — returns true when two
 *     rules from different module files would be flagged as conflicting but
 *     actually can't conflict at runtime
 *   - formatModuleNote(selector) — human-readable note for agents explaining
 *     why a class is locally scoped
 */

const path = require('path');

// ─── Detection ───────────────────────────────────────────────────────────────

const MODULE_PATTERN = /\.module\.(css|scss)$/i;

function isCSSModule(filePath) {
  return MODULE_PATTERN.test(filePath);
}

/**
 * Returns true if a selector is globally scoped even inside a CSS Module.
 * These selectors are NOT locally scoped by the CSS Modules compiler.
 */
function isGlobalInModule(selector) {
  const s = selector.trim().toLowerCase();
  // :global() wrapper
  if (s.startsWith(':global')) return true;
  // Pure element selectors, :root, *, html, body
  if (/^(\*|html|body|:root)$/.test(s)) return true;
  // Starts with an element selector (no class/id prefix)
  if (/^[a-z][\w-]*(\s|$|::?|>|\+|~)/.test(s) && !s.startsWith('.') && !s.startsWith('#')) return true;
  return false;
}

// ─── Rule tagging ─────────────────────────────────────────────────────────────

/**
 * Adds cssModule: true and localScope: true/false to rules from module files.
 * Called after buildCSSOM's flat rule list is assembled.
 */
function tagModuleRules(rules) {
  return rules.map(rule => {
    if (!isCSSModule(rule.source.file)) return rule;
    const local = !isGlobalInModule(rule.selector);
    return {
      ...rule,
      cssModule: true,
      localScope: local,
      sourceModule: path.basename(rule.source.file),
    };
  });
}

// ─── Conflict suppression ────────────────────────────────────────────────────

/**
 * Returns true when a cascade conflict between two rules should be suppressed
 * because they come from different CSS Module files and are both locally scoped.
 * At runtime these selectors will have unique compiled class names and cannot
 * actually conflict.
 */
function shouldSuppressCrossModuleConflict(ruleA, ruleB) {
  if (!ruleA.cssModule || !ruleB.cssModule) return false;
  if (!ruleA.localScope || !ruleB.localScope) return false;
  // Same module file — conflicts are real and should still be reported
  if (ruleA.source.file === ruleB.source.file) return false;
  return true;
}

// ─── Output formatting ───────────────────────────────────────────────────────

/**
 * Returns an agent-readable note explaining CSS Module local scoping.
 */
function formatModuleNote(selector, sourceModule) {
  return (
    '"' + selector + '" is locally scoped in ' + sourceModule + '. ' +
    'At build time this class name will be compiled to a unique identifier ' +
    '(e.g. "' + selector.replace(/^\./, '') + '_abc123"). ' +
    'Cross-file cascade conflicts with this selector are suppressed — they cannot occur at runtime.'
  );
}

/**
 * Enriches a resolved property entry with CSS Module metadata if applicable.
 */
function enrichWithModuleInfo(entry, rule) {
  if (!rule || !rule.cssModule) return entry;
  return {
    ...entry,
    cssModule: true,
    localScope: rule.localScope,
    localScopeNote: rule.localScope
      ? formatModuleNote(rule.selector, rule.sourceModule)
      : undefined,
  };
}

module.exports = {
  isCSSModule,
  isGlobalInModule,
  tagModuleRules,
  shouldSuppressCrossModuleConflict,
  formatModuleNote,
  enrichWithModuleInfo,
};
