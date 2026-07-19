/**
 * AST Component Graph — stylespeak v0.3
 *
 * Builds a static component relationship map from JSX/TSX files using
 * regex-based parsing (zero external dependencies). Determines which
 * components render inside which other components, and which CSS class
 * names are therefore guaranteed to be DOM-ancestors of other class names.
 *
 * This map is used by selectorMatcher to upgrade 'possible' confidence
 * matches to 'likely' when the graph confirms the ancestor relationship exists.
 *
 * Handles:
 *   - Named imports: import { Button } from './Button'
 *   - Default imports: import Card from './Card'
 *   - JSX element usage in render output
 *   - className string literals on JSX elements
 *   - Multi-level ancestry (transitive relationships)
 *
 * Does NOT handle:
 *   - Dynamic imports
 *   - Computed class names (cn(), template literals)
 *   - Re-exports / barrel files (treated as opaque)
 *   - Context providers / portals (classes may render outside component tree)
 */

const fs = require('fs');
const path = require('path');

const JSX_EXTENSIONS = new Set(['.jsx', '.tsx', '.js', '.ts']);

// ─── File discovery ───────────────────────────────────────────────────────────

function discoverComponentFiles(dir) {
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
      } else if (JSX_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ─── Per-file extraction ──────────────────────────────────────────────────────

/**
 * Extracts from a single JSX/TSX file:
 *  - componentName: the name of the component defined in this file
 *  - imports: [ { name, source } ] — components imported
 *  - usedElements: Set of JSX element names used in render output
 *  - classNames: Set of class name tokens used in this component
 */
function extractComponentInfo(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const source = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(filePath, path.extname(filePath));

  // Component name — try to find the exported default or named component
  let componentName = basename;
  const exportMatch = source.match(/export\s+(?:default\s+)?(?:function|class|const)\s+([A-Z][\w]*)/);
  if (exportMatch) componentName = exportMatch[1];

  // Imports — extract named and default imports from relative paths
  const imports = [];
  const importPattern = /import\s+(?:(\{[^}]+\})|([A-Z][\w]*))\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const named = match[1];
    const defaultImport = match[2];
    const importSource = match[3];

    if (defaultImport) {
      imports.push({ name: defaultImport, source: importSource });
    }
    if (named) {
      const names = named.replace(/[{}]/g, '').split(',').map(n => n.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
      names.forEach(n => imports.push({ name: n, source: importSource }));
    }
  }

  // Used JSX elements — find <ComponentName and <componentName in JSX
  const usedElements = new Set();
  const jsxPattern = /<([A-Za-z][A-Za-z0-9.]*)[^>]*(?:\/?>|>)/g;
  while ((match = jsxPattern.exec(source)) !== null) {
    const el = match[1].split('.')[0]; // handle <Component.Sub>
    if (el && el[0] === el[0].toUpperCase()) usedElements.add(el); // uppercase = component
  }

  // Class names — extract from className="..." and class="..."
  const classNames = new Set();
  const classPattern = /(?:className|class)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  while ((match = classPattern.exec(source)) !== null) {
    const classes = (match[1] || match[2] || '').split(/\s+/).filter(Boolean);
    classes.forEach(c => classNames.add('.' + c));
  }

  return { componentName, filePath, imports, usedElements, classNames };
}

// ─── Graph builder ────────────────────────────────────────────────────────────

/**
 * Builds the full component graph from a set of JSX/TSX files.
 *
 * Returns:
 *   componentMap: Map<componentName, componentInfo>
 *   ancestorMap:  Map<childClass, Set<ancestorClass>>
 *     — for each CSS class, which other CSS classes are guaranteed ancestors
 */
function buildComponentGraph(filePaths) {
  const componentMap = new Map();
  const infoList = [];

  // Extract info from all files
  for (const filePath of filePaths) {
    const info = extractComponentInfo(filePath);
    if (info) {
      componentMap.set(info.componentName, info);
      infoList.push(info);
    }
  }

  // Build parent → children relationship
  // "Parent renders Child" means Child's classes can appear inside Parent's classes
  const rendersMap = new Map(); // componentName → Set<childComponentName>
  for (const info of infoList) {
    const children = new Set();
    for (const el of info.usedElements) {
      if (componentMap.has(el)) children.add(el);
    }
    rendersMap.set(info.componentName, children);
  }

  // Build CSS class ancestry map
  // If ParentComponent uses .sidebar and renders ChildComponent which uses .btn,
  // then .btn is a descendant of .sidebar
  const ancestorMap = new Map(); // childClass → Set<ancestorClass>

  function getDescendantClasses(componentName, visited = new Set()) {
    if (visited.has(componentName)) return new Set();
    visited.add(componentName);
    const info = componentMap.get(componentName);
    if (!info) return new Set();

    const all = new Set(info.classNames);
    const children = rendersMap.get(componentName) || new Set();
    for (const child of children) {
      for (const cls of getDescendantClasses(child, visited)) all.add(cls);
    }
    return all;
  }

  for (const info of infoList) {
    const children = rendersMap.get(info.componentName) || new Set();
    for (const child of children) {
      const childInfo = componentMap.get(child);
      if (!childInfo) continue;

      // All classes in child (and its descendants) are DOM-descendants of parent's classes
      const descendantClasses = getDescendantClasses(child);
      for (const descendantClass of descendantClasses) {
        if (!ancestorMap.has(descendantClass)) ancestorMap.set(descendantClass, new Set());
        for (const parentClass of info.classNames) {
          ancestorMap.get(descendantClass).add(parentClass);
        }
      }
    }
  }

  return { componentMap, ancestorMap };
}

/**
 * Checks whether the graph confirms that ancestorClass is a DOM ancestor
 * of descendantClass. Used by selectorMatcher to upgrade 'possible' to 'likely'.
 */
function graphConfirmsAncestry(ancestorClass, descendantClass, ancestorMap) {
  if (!ancestorMap || !ancestorMap.has(descendantClass)) return false;
  return ancestorMap.get(descendantClass).has(ancestorClass);
}

module.exports = { buildComponentGraph, discoverComponentFiles, graphConfirmsAncestry, extractComponentInfo };
