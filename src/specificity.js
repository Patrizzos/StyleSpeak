/**
 * CSS Specificity calculator.
 * Returns [inline, id, class, type] as a 4-tuple.
 * Handles :where() (zero specificity), :not()/:is()/:has() (argument specificity).
 */

function calculateSpecificity(selector) {
  let sel = selector.trim();
  let id = 0, cls = 0, typ = 0;

  // pseudo-elements count as type
  sel = sel.replace(/::?(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|cue)\b/gi, () => { typ++; return ''; });

  // :where() contributes zero
  sel = sel.replace(/:where\([^)]*\)/gi, '');

  // :not(), :is(), :has() — recurse into args (simplified: treat contents as normal)
  sel = sel.replace(/:(not|is|has)\(([^)]*)\)/gi, (_, _n, inner) => ` ${inner} `);

  // IDs
  sel = sel.replace(/#[\w-]+/g, () => { id++; return ''; });

  // classes, attributes, pseudo-classes
  sel = sel.replace(/\.[\w-]+/g, () => { cls++; return ''; });
  sel = sel.replace(/\[[^\]]*\]/g, () => { cls++; return ''; });
  sel = sel.replace(/:[\w-]+(\([^)]*\))?/g, () => { cls++; return ''; });

  // type selectors
  const typeMatches = sel.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g);
  if (typeMatches) {
    for (const m of typeMatches) {
      const tag = m.replace(/^[\s>+~]+/, '');
      if (tag && tag !== '*') typ++;
    }
  }

  return [0, id, cls, typ];
}

function compareSpecificity(a, b) {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function specificityToString(s) {
  return `(${s[0]},${s[1]},${s[2]},${s[3]})`;
}

module.exports = { calculateSpecificity, compareSpecificity, specificityToString };
