# StyleSpeak - MCP and CLI

A companion MCP server and CLI to [stylesafe](https://www.npmjs.com/package/stylesafe) that makes CSS legible to AI agents — resolving cascade, tracing properties, explaining what applies and why, and resolving CSS custom properties before an agent touches a single line of styles.

## The problem

AI coding agents write CSS without being able to see its effect. They modify a rule, assume it worked, and move on — unaware that a higher-specificity rule elsewhere already overrides it, a combinator rule in another file is silently winning, or a CSS variable resolves to something entirely different than expected. stylespeak gives agents a structured knowledge layer to consult *before* making changes.

## What it does

**`resolve_styles`** — answers "what CSS actually applies to this selector?"

Given a selector and a set of files, returns every CSS property the selector would receive, which rule wins for each, and which rules were overridden — with confidence levels since no real DOM is available. CSS custom properties (`var()`) are resolved to their actual values, including chained variables, fallbacks, and media-context overrides.

**`trace_property`** — answers "everywhere this property is set, who wins?"

Given a property name and a set of files, returns every rule that sets it, groups competing rules that target overlapping selectors, and shows the full cascade chain for each group — with resolved variable values included. Use this to understand the blast radius of a change before making it.

## Quick start

### As a CLI tool

```bash
npm install -g @patrizzos/stylespeak
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
- `resolve_styles({ selector, files, projectRoot, componentFiles? })`
- `trace_property({ property, files, projectRoot })`

## Example output

```bash
stylespeak resolve ".btn" src/styles/buttons.css
```

```json
{
  "query": { "selector": ".btn", "filesAnalyzed": ["buttons.css"] },
  "properties": {
    "background-color": {
      "winner": {
        "value": "var(--color-primary)",
        "resolvedValue": "#2563eb",
        "variableChain": ["--color-primary → #2563eb"],
        "conditionalValues": [
          {
            "mediaContext": "@media (prefers-color-scheme: dark)",
            "resolvedValue": "#93c5fd"
          }
        ],
        "selector": ".btn",
        "specificity": "(0,0,1,0)",
        "source": { "file": "buttons.css", "line": 4 }
      },
      "overridden": [],
      "confidence": "certain"
    }
  },
  "variables": {
    "--color-primary": {
      "value": "#2563eb",
      "resolvedValue": "#2563eb",
      "selector": ":root"
    }
  },
  "summary": "Found 4 properties applying to \".btn\" from 2 matched rule(s).",
  "agentNote": "2 properties are certain. 2 properties use CSS custom properties — resolved values shown alongside raw var() references."
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

## CSS custom property resolution

As of v0.2, stylespeak fully resolves CSS custom properties (`var()`) in all output. For every value that references a variable, the response includes:

- `value` — the raw value as written (`var(--color-primary)`)
- `resolvedValue` — the actual resolved value (`#2563eb`)
- `variableChain` — the full resolution path, including chained variables
- `conditionalValues` — media-context overrides where the variable resolves differently

A top-level `variables` map in every response shows all custom properties found across the analyzed files, their resolved values, and any scoped or media-context overrides.

Supported resolution features:
- Simple: `var(--name)`
- Fallback: `var(--name, fallback-value)`
- Nested fallback: `var(--name, var(--other, default))`
- Chained: `--a: var(--b)` → resolves `--b` transitively
- Scoped: element-scoped variables override `:root` for matching selectors
- Media-context: `@media` overrides surfaced as `conditionalValues`
- Circular reference protection (max depth 10)

## Use cases

- **Before editing styles** — call `resolve_styles` to understand the full cascade context first
- **Before changing a property** — call `trace_property` to see the blast radius across all files
- **Debugging "why isn't my CSS working"** — trace the property to find the higher-specificity rule that's winning
- **Understanding CSS variables** — see exactly what a `var()` resolves to, including dark mode and responsive overrides
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

**stylespeak** explains your CSS — resolving cascade, tracing properties, resolving variables, mapping what applies and why — so agents understand before they act.

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
      - run: npm install -g @patrizzos/stylespeak
      - run: stylespeak trace "color" --projectRoot src/styles
```

## Architecture

```
src/
  cssParser.js            — dependency-free CSS tokenizer with SCSS nesting support (v0.3)
  specificity.js          — standard (id, class, type) specificity calculator
  cssomBuilder.js         — builds in-memory cascade model from multiple files
  selectorMatcher.js      — heuristic selector matching with confidence levels
  variableResolver.js     — CSS custom property resolution (v0.2)
  cssModulesAnalyzer.js   — CSS Modules local scope detection and tagging (v0.3)
  scssNestingExpander.js  — SCSS nesting pre-processor (v0.3)
  astComponentGraph.js    — AST component graph for graph-aware matching (v0.3)
  resolveStyles.js        — resolve_styles tool implementation
  traceProperty.js        — trace_property tool implementation
  server.js               — MCP server (stdio JSON-RPC) + CLI entry point
```

Zero external dependencies. Requires Node.js 18+.

## File format support

| Format | Support level |
|---|---|
| `.css` | Full |
| `.scss` | Full — nesting, `&` references, `@media` passthrough (v0.3) |
| `.module.css` / `.module.scss` | Full — locally scoped classes detected and tagged (v0.3) |
| styled-components / Emotion | Not supported — dynamic runtime styles cannot be statically analyzed |
| vanilla-extract / Linaria / StyleX | Fully supported via compiled CSS output — point stylespeak at the build output |
| CSS-in-JS (object syntax) | Not supported (post v1.0 roadmap) |

## Roadmap

- **v0.2** ✅ — CSS custom property resolution (simple, chained, fallback, scoped, media-context)
- **v0.3** ✅ — SCSS nesting support, CSS Modules local scope awareness, AST component graph analysis
- **v1.0** — Chrome DevTools Protocol integration for live cascade resolution against a running browser
