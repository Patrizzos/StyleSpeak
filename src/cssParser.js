/**
 * CSS Parser for stylescope.
 * Improved over stylesafe's version with:
 *  - Line number tracking for every rule (for source location in output)
 *  - At-rule context preservation (@media, @layer, @supports)
 *  - Returns { rules } where each rule has { selectors, declarations, source: { file, line }, mediaContext }
 */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
}

function getLineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function parseDeclarations(block) {
  const decls = [];
  const parts = block.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = trimmed.slice(0, colonIdx).trim().toLowerCase();
    let value = trimmed.slice(colonIdx + 1).trim();
    if (!prop) continue;
    const important = /!important\s*$/i.test(value);
    if (important) value = value.replace(/!important\s*$/i, '').trim();
    decls.push({ prop, value, important });
  }
  return decls;
}

function findMatchingBrace(css, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return i - 1;
}

function parseCSS(cssText, filename = '<input>') {
  const css = stripComments(cssText);
  const rules = [];
  let i = 0;
  const atStack = [];

  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;

    if (css[i] === '@') {
      const braceIdx = css.indexOf('{', i);
      const semiIdx = css.indexOf(';', i);
      if (braceIdx === -1 || (semiIdx !== -1 && semiIdx < braceIdx)) {
        i = semiIdx === -1 ? css.length : semiIdx + 1;
        continue;
      }
      const atHeader = css.slice(i, braceIdx).trim();
      atStack.push(atHeader);
      i = braceIdx + 1;
      continue;
    }

    if (css[i] === '}') {
      if (atStack.length > 0) atStack.pop();
      i++;
      continue;
    }

    const braceIdx = css.indexOf('{', i);
    if (braceIdx === -1) break;

    const selectorText = css.slice(i, braceIdx).trim();
    if (!selectorText) { i = braceIdx + 1; continue; }

    const closeIdx = findMatchingBrace(css, braceIdx);
    const declBlock = css.slice(braceIdx + 1, closeIdx);
    const declarations = parseDeclarations(declBlock);
    const selectors = selectorText.split(',').map(s => s.trim()).filter(Boolean);
    const line = getLineNumber(css, i);

    rules.push({
      selectors,
      declarations,
      mediaContext: atStack.length > 0 ? atStack.join(' > ') : null,
      source: { file: filename, line },
    });

    i = closeIdx + 1;
  }

  return rules;
}

const { expandSCSS } = require('./scssNestingExpander');

const SCSS_EXTENSIONS = new Set(['.scss', '.sass']);

function parseFile(cssText, filename) {
  const ext = require('path').extname(filename || '').toLowerCase();
  const text = SCSS_EXTENSIONS.has(ext) ? expandSCSS(cssText) : cssText;
  return parseCSS(text, filename);
}

module.exports = { parseCSS, parseFile };
