#!/usr/bin/env node
/**
 * stylespeak — MCP server + CLI
 *
 * MCP mode: reads JSON-RPC from stdin, exposes two tools:
 *   resolve_styles  — what CSS applies to a selector, who wins, who loses
 *   trace_property  — every rule setting a property, competing groups, blast radius
 *
 * CLI mode: node server.js resolve .btn src/styles/main.css
 *           node server.js trace color --projectRoot src
 */

const readline = require('readline');
const { resolveStyles } = require('./resolveStyles');
const { traceProperty } = require('./traceProperty');

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
];

// ─── MCP server ──────────────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function runTool(name, args) {
  if (name === 'resolve_styles') return resolveStyles(args || {});
  if (name === 'trace_property') return traceProperty(args || {});
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
        serverInfo: { name: 'stylespeak', version: '0.3.0' },
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
    console.log('  node server.js trace <property> [file...] [--projectRoot <dir>]\n');
    console.log('Examples:');
    console.log('  node server.js resolve ".btn.primary" src/styles/main.css');
    console.log('  node server.js trace "color" --projectRoot src/styles');
    console.log('  node server.js resolve "#header a" src/styles/base.css src/styles/header.css');
    return;
  }

  const projectRootIdx = args.indexOf('--projectRoot');
  const projectRoot = projectRootIdx !== -1 ? args[projectRootIdx + 1] : null;
  const fileArgs = args.slice(1).filter(a => !a.startsWith('--') && a !== projectRoot);

  let result;
  if (command === 'resolve') {
    const selector = fileArgs[0];
    const files = fileArgs.slice(1);
    result = resolveStyles({ selector, files, projectRoot });
  } else if (command === 'trace') {
    const property = fileArgs[0];
    const files = fileArgs.slice(1);
    result = traceProperty({ property, files, projectRoot });
  } else {
    console.error(`Unknown command: ${command}. Use resolve or trace.`);
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
