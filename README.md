# StyleSpeak

A companion MCP server and CLI to [stylesafe](https://www.npmjs.com/package/stylesafe) that makes CSS legible to AI agents — resolving cascade, tracing properties, and explaining what applies and why before an agent touches a single line of styles.

## The problem

AI coding agents write CSS without being able to see its effect. They modify a rule, assume it worked, and move on — unaware that a higher-specificity rule elsewhere already overrides it, or that a combinator rule in another file is silently winning. stylespeak gives agents a structured knowledge layer to consult *before* making changes.

## What it does

**`resolve_styles`** — answers "what CSS actually applies to this selector?"

Given a selector and a set of files, returns every CSS property the selector would receive, which rule wins for each, and which rules were overridden — with confidence levels since no real DOM is available.

**`trace_property`** — answers "everywhere this property is set, who wins?"

Given a property name and a set of files, returns every rule that sets it, groups competing rules that target overlapping selectors, and shows the full cascade chain for each group. Use this to understand the blast radius of a change before making it.

## Quick start

### As a CLI tool

```bash
npm install -g stylespeak
```

Resolve what applies to a selector:
```bash
stylespeak resolve ".btn.primary" src/styles/main.css
stylespeak resolve "#header a" src/styles/base.css src/styles/header.css
stylespeak resolve ".card-title" --projectRoot src/styles
```

Trace a property across files:
```bash
stylespeak trace "color" src/styles/main.css
stylespeak trace "background-color" --projectRoot src/styles
```

### As an MCP server

Add to your MCP client config (Cursor: `.cursor/mcp.json`, VS Code: `.vscode/mcp.json`):

```json
{
  "mcpServers": {
    "stylespeak": {
      "command": "node",
      "args": ["/absolute/path/to/stylespeak/src/server.js"]
    }
  }
}
```

Once connected, agents can call:
- `resolve_styles({ selector, files, projectRoot })`
- `trace_property({ property, files, projectRoot })`

## Example output

```bash
stylespeak resolve ".btn.primary" src/styles/buttons.css
```

```json
{
  "query": { "selector": ".btn.primary", "filesAnalyzed": ["buttons.css"] },
  "properties": {
    "background-color": {
      "winner": {
        "value": "darkblue",
        "selector": ".btn.primary",
        "specificity": "(0,0,2,0)",
        "source": { "file": "buttons.css", "line": 9 }
      },
      "overridden": [
        {
          "value": "blue",
          "selector": ".btn",
          "specificity": "(0,0,1,0)",
          "reason": "lower specificity"
        }
      ],
      "confidence": "certain"
    }
  },
  "summary": "Found 6 properties applying to \".btn.primary\" from 5 matched rule(s).",
  "agentNote": "1 property is certain. 2 properties are likely. 3 properties are possible (combinator rules — depends on DOM context). 3 properties have overridden rules — review before modifying."
}
```

## Confidence levels

Since stylespeak performs static analysis without a real DOM, every resolved property carries a confidence level:

| Level | Meaning |
|---|---|
| `certain` | Exact selector match — rule definitively applies |
| `likely` | Rule tokens are a subset of the queried selector — applies in most cases |
| `possible` | Combinator rule (e.g. `.sidebar .btn`) — depends on DOM ancestry, unknown without rendering |

An agent should treat `certain` and `likely` results as ground truth, and `possible` results as conditional — they may apply depending on where the element lives in the DOM.

## Use cases

- **Before editing styles** — call `resolve_styles` to understand the full cascade context first
- **Before changing a property** — call `trace_property` to see the blast radius across all files
- **Debugging "why isn't my CSS working"** — trace the property to find the higher-specificity rule that's winning
- **Style audits** — run across a project directory to map what's actually applying where

## CLI options

Both commands accept:
- One or more file paths as positional arguments
- `--projectRoot <dir>` to analyze all CSS/SCSS files in a directory recursively

```bash
stylespeak resolve ".btn" src/main.css src/components.css
stylespeak trace "padding" --projectRoot src/styles
```

## How it pairs with stylesafe

**stylesafe** catches problems in your CSS — conflicts, dead rules, Tailwind clashes — before they ship.

**stylespeak** explains your CSS — resolving cascade, tracing properties, mapping what applies and why — so agents understand before they act.

Use stylesafe as a post-edit check. Use stylespeak as a pre-edit consultation. Together they give AI coding agents a complete feedback loop on styles.

## GitHub Actions

```yaml
name: style check

on: [pull_request]

jobs:
  stylespeak:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g stylespeak
      - run: stylespeak trace "color" --projectRoot src/styles
```

## Architecture

```
src/
  cssParser.js        — dependency-free CSS tokenizer with line number tracking
  specificity.js      — standard (id, class, type) specificity calculator
  cssomBuilder.js     — builds in-memory cascade model from multiple files
  selectorMatcher.js  — heuristic selector matching with confidence levels
  resolveStyles.js    — resolve_styles tool implementation
  traceProperty.js    — trace_property tool implementation
  server.js           — MCP server (stdio JSON-RPC) + CLI entry point
```

Zero external dependencies. Requires Node.js 18+.

## Roadmap

- **v0.2** — CSS custom property (variable) resolution, CSS Modules scope awareness
- **v0.3** — AST component graph analysis for more accurate selector matching without a DOM
- **v1.0** — Chrome DevTools Protocol integration for live cascade resolution against a running browser
