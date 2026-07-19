/**
 * SCSS nesting expander — stylespeak v0.3
 *
 * Expands SCSS-style nested rules into flat CSS before parsing.
 * Handles:
 *   - Descendant nesting:   .parent { .child {} }  → .parent .child {}
 *   - Self-referencing &:   .btn { &:hover {} }    → .btn:hover {}
 *   - Modifier &:           .btn { &.primary {} }  → .btn.primary {}
 *   - Sibling &:            .btn { & + & {} }      → .btn + .btn {}
 *   - Element nesting:      .card { h2 {} }        → .card h2 {}
 *   - @media passthrough:   @media blocks preserved and re-wrapped
 *   - Arbitrary depth:      recursive expansion
 *
 * Does NOT handle:
 *   - SCSS variables ($color: red) — stripped with a warning comment
 *   - @mixin / @include / @extend — stripped with a warning comment
 *   - Interpolation (#{$var}) — left as-is
 *
 * Returns a flat CSS string ready for cssParser.js
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripSCSSSpecific(scss) {
  // Strip SCSS variable declarations ($var: value;)
  let out = scss.replace(/^\s*\$[\w-]+\s*:[^;]+;/gm, '/* [stylespeak: SCSS variable stripped] */');
  // Strip @mixin definitions
  out = out.replace(/@mixin\s+[\w-]+[^{]*\{[^}]*\}/g, '/* [stylespeak: @mixin stripped] */');
  // Strip @include calls
  out = out.replace(/@include\s+[^;]+;/g, '/* [stylespeak: @include stripped] */');
  // Strip @extend calls
  out = out.replace(/@extend\s+[^;]+;/g, '/* [stylespeak: @extend stripped] */');
  return out;
}

function findMatchingBrace(text, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  return i - 1;
}

/**
 * Combines a parent selector with a child selector following SCSS rules.
 * e.g. parent=".btn", child="&:hover"   → ".btn:hover"
 *      parent=".btn", child=".icon"     → ".btn .icon"
 *      parent=".btn", child="&.primary" → ".btn.primary"
 */
function combineSelectors(parent, child) {
  const childTrimmed = child.trim();
  if (childTrimmed.includes('&')) {
    // Replace & with each parent selector (handles multi-selector parents too)
    return parent
      .split(',')
      .map(p => {
        return child.split(',').map(c => {
          return c.trim().replace(/&/g, p.trim());
        }).join(', ');
      })
      .join(', ');
  }
  // No & — treat as descendant
  return parent
    .split(',')
    .map(p => child.split(',').map(c => p.trim() + ' ' + c.trim()).join(', '))
    .join(', ');
}

// ─── Core expander ────────────────────────────────────────────────────────────

/**
 * Recursively expands nested SCSS blocks into flat CSS rules.
 * @param {string} text — the CSS/SCSS block content (without outer braces)
 * @param {string|null} parentSelector — the selector context from the parent block
 * @returns {string} flat CSS
 */
function expandBlock(text, parentSelector) {
  let output = '';
  let ownDeclarations = '';
  let i = 0;

  while (i < text.length) {
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    // Comment
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    // At-rule
    if (text[i] === '@') {
      const braceIdx = text.indexOf('{', i);
      const semiIdx = text.indexOf(';', i);
      if (braceIdx === -1 || (semiIdx !== -1 && semiIdx < braceIdx)) {
        // Statement at-rule (@import, @charset etc.) — pass through
        const end = semiIdx === -1 ? text.length : semiIdx + 1;
        output += text.slice(i, end) + '\n';
        i = end;
        continue;
      }
      const atHeader = text.slice(i, braceIdx).trim();
      const closeIdx = findMatchingBrace(text, braceIdx);
      const innerContent = text.slice(braceIdx + 1, closeIdx);

      if (/^@(media|supports|layer|container)/i.test(atHeader)) {
        // Expand nested rules inside the at-rule, preserving the at-rule wrapper
        const expanded = expandBlock(innerContent, parentSelector);
        output += atHeader + ' {\n' + expanded + '}\n';
      } else {
        // Other at-rules — pass through as-is
        output += text.slice(i, closeIdx + 1) + '\n';
      }
      i = closeIdx + 1;
      continue;
    }

    // Closing brace (shouldn't appear at top level but guard anyway)
    if (text[i] === '}') { i++; continue; }

    // Find next { or ; to determine if this is a rule or a declaration
    let braceIdx = -1, semiIdx = -1;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') { braceIdx = j; break; }
      if (text[j] === ';') { semiIdx = j; break; }
    }

    if (braceIdx === -1 && semiIdx === -1) {
      // Remaining text is a declaration without semicolon
      ownDeclarations += text.slice(i).trim();
      break;
    }

    if (semiIdx !== -1 && (braceIdx === -1 || semiIdx < braceIdx)) {
      // This is a property declaration — belongs to the current rule
      ownDeclarations += text.slice(i, semiIdx + 1) + '\n';
      i = semiIdx + 1;
      continue;
    }

    // This is a nested rule
    const nestedSelectorText = text.slice(i, braceIdx).trim();
    const closeIdx = findMatchingBrace(text, braceIdx);
    const nestedContent = text.slice(braceIdx + 1, closeIdx);

    if (nestedSelectorText) {
      const resolvedSelector = parentSelector
        ? combineSelectors(parentSelector, nestedSelectorText)
        : nestedSelectorText;
      const expandedNested = expandBlock(nestedContent, resolvedSelector);
      output += expandedNested;
    }

    i = closeIdx + 1;
  }

  // Emit the own declarations as a rule block if we have a parent selector
  if (ownDeclarations.trim() && parentSelector) {
    output = parentSelector + ' {\n' + ownDeclarations + '}\n' + output;
  } else if (ownDeclarations.trim()) {
    output = ownDeclarations + '\n' + output;
  }

  return output;
}

/**
 * Main entry point. Takes raw SCSS text, returns flat CSS string.
 */
function expandSCSS(scssText) {
  const stripped = stripSCSSSpecific(scssText);
  return expandBlock(stripped, null);
}

module.exports = { expandSCSS, combineSelectors };
