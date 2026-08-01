#!/usr/bin/env node
/**
 * stylespeak — MCP server + CLI
 *
 * MCP mode: exposes four tools:
 *   resolve_styles  — what CSS applies to a selector, who wins, who loses
 *   trace_property  — every rule setting a property, competing groups, blast radius
 *   live_resolve    — exact resolution via Chrome DevTools Protocol
 *   impact_preview  — blast radius of a proposed CSS change before making it
 *
 * CLI mode: node server.js resolve .btn src/styles/main.css
 *           node server.js trace color --projectRoot src
 *           node server.js impact .btn background-color src/styles/main.css
 */

const readline = require('readline');
const { resolveStyles } = require('./resolveStyles');
const { traceProperty } = require('./traceProperty');
const { liveResolve } = require('./liveResolve');
const { impactPreview } = require('./impactPreview');

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'resolve_styles',
    description:
      'Resolves what CSS actually applies to a given selector. Returns every property ' +
      'the selector would receive, which rule wins for each property, and which rules ' +
      'were overridden — with confidence levels (certain/likely/possible) since no real ' +
      'DOM is available. Call this before modifying styles for an element to understand ' +
      'the full cascade context first.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to resolve, e.g. ".btn.primary", "#header a:hover"',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to CSS/SCSS files to analyze.',
        },
        projectRoot: {
          type: 'string',
          description: 'Optional: path to a project root. All CSS/SCSS files will be discovered recursively.',
        },
        componentFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: absolute paths to JSX/TSX files. When provided, builds an AST component graph to upgrade selector confidence from possible to likely where ancestry is confirmed.',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'trace_property',
    description:
      'Traces a CSS property across all provided files — finding every rule that sets it, ' +
      'grouping competing rules that target overlapping selectors, and showing who wins in ' +
      'each group. Use this to understand the blast radius of a property before changing it, ' +
      'or to find out why a property value isn\'t applying as expected.',
    inputSchema: {
      type: 'object',
      properties: {
        property: {
          type: 'string',
          description: 'CSS property name to trace, e.g. "color", "background-color", "padding"',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to CSS/SCSS files to analyze.',
        },
        projectRoot: {
          type: 'string',
          description: 'Optional: path to a project root. All CSS/SCSS files will be discovered recursively.',
        },
      },
      required: ['property'],
    },
  },
  {
    name: 'live_resolve',
    description:
      'Resolves CSS for a selector by querying a live running browser via Chrome DevTools Protocol (CDP). ' +
      'Returns exact computed styles and every matched rule in cascade order — no static analysis, no heuristics, ' +
      'confidence is always exact. Requires Chrome or any Chromium browser (Edge, Brave, Arc) running with ' +
      '--remote-debugging-port=9222. Use this when you need ground truth. ' +
      'Fall back to resolve_styles when no browser is running.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to resolve against the live DOM, e.g. ".btn.primary", "#header a"',
        },
        port: {
          type: 'number',
          description: 'CDP port (default: 9222). Change if you started Chrome with a different port.',
        },
        tabUrl: {
          type: 'string',
          description: 'Optional URL substring to target a specific tab. If omitted, uses the first available tab.',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'impact_preview',
    description:
      'Predicts the blast radius of a proposed CSS change before it is made. ' +
      'Given a selector, property, and optional new value, returns every competing rule ' +
      'in the codebase that would be affected — showing which selectors will see a different ' +
      'value, which are shielded by higher specificity, which cascade relationships are uncertain, ' +
      'and which downstream rules are affected through CSS variable chains or inheritance. ' +
      'Works without a browser. Use this before making any CSS change to understand the full impact.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'The CSS selector you are about to change, e.g. ".btn", ":root"',
        },
        property: {
          type: 'string',
          description: 'The CSS property you are about to change, e.g. "background-color", "--color-primary"',
        },
        newValue: {
          type: 'string',
          description: 'Optional: the new value you plan to set. Enables before/after comparison in variable chain impacts.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to CSS/SCSS files to analyze.',
        },
        projectRoot: {
          type: 'string',
          description: 'Optional: path to a project root. All CSS/SCSS files will be discovered recursively.',
        },
      },
      required: ['selector', 'property'],
    },
  },
];

// ─── MCP server ──────────────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function runTool(name, args) {
  if (name === 'resolve_styles') return resolveStyles(args || {});
  if (name === 'trace_property') return traceProperty(args || {});
  if (name === 'live_resolve') return liveResolve(args || {});
  if (name === 'impact_preview') return impactPreview(args || {});
  throw new Error(`Unknown tool: ${name}`);
}

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'stylespeak', version: '1.1.0' },
      },
    });
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const result = runTool(name, args);
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
    } catch (err) {
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
      });
    }
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// ─── CLI mode ────────────────────────────────────────────────────────────────

function runCLI(args) {
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log('stylespeak — CSS knowledge layer for AI agents\n');
    console.log('Usage:');
    console.log('  node server.js resolve <selector> [file...] [--projectRoot <dir>]');
    console.log('  node server.js trace <property> [file...] [--projectRoot <dir>]');
    console.log('  node server.js impact <selector> <property> [file...] [--projectRoot <dir>] [--newValue <value>]\n');
    console.log('Examples:');
    console.log('  node server.js resolve ".btn.primary" src/styles/main.css');
    console.log('  node server.js trace "color" --projectRoot src/styles');
    console.log('  node server.js impact ".btn" "background-color" src/styles/main.css --newValue "#ff0000"');
    return;
  }

  const projectRootIdx = args.indexOf('--projectRoot');
  const projectRoot = projectRootIdx !== -1 ? args[projectRootIdx + 1] : null;
  const newValueIdx = args.indexOf('--newValue');
  const newValue = newValueIdx !== -1 ? args[newValueIdx + 1] : null;
  const fileArgs = args.slice(1).filter(a =>
    !a.startsWith('--') && a !== projectRoot && a !== newValue
  );

  let result;
  if (command === 'resolve') {
    const selector = fileArgs[0];
    const files = fileArgs.slice(1);
    result = resolveStyles({ selector, files, projectRoot });
  } else if (command === 'trace') {
    const property = fileArgs[0];
    const files = fileArgs.slice(1);
    result = traceProperty({ property, files, projectRoot });
  } else if (command === 'impact') {
    const selector = fileArgs[0];
    const property = fileArgs[1];
    const files = fileArgs.slice(2);
    result = impactPreview({ selector, property, newValue, files, projectRoot });
  } else {
    console.error('Unknown command: ' + command + '. Use resolve, trace, or impact.');
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);

if (cliArgs.length > 0) {
  runCLI(cliArgs);
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try { handleRequest(JSON.parse(trimmed)); } catch { /* ignore malformed */ }
  });
}
