# StyleSpeak - MCP and CLI

A companion MCP server and CLI to [stylesafe](https://www.npmjs.com/package/stylesafe) that makes CSS legible to AI agents — resolving cascade, tracing properties, predicting change impact, and explaining what applies and why before an agent touches a single line of styles.

## The problem

AI coding agents write CSS without being able to see its effect. They modify a rule, assume it worked, and move on — unaware that a higher-specificity rule elsewhere already overrides it, a combinator rule in another file is silently winning, or a CSS variable resolves to something entirely different than expected. stylespeak gives agents a structured knowledge layer to consult *before* making changes.

## What it does

**`resolve_styles`** — answers "what CSS actually applies to this selector?"

Given a selector and a set of files, returns every CSS property the selector would receive, which rule wins for each, and which rules were overridden — with confidence levels since no real DOM is available. CSS custom properties (`var()`) are resolved to their actual values, including chained variables, fallbacks, and media-context overrides.

**`trace_property`** — answers "everywhere this property is set, who wins?"

Given a property name and a set of files, returns every rule that sets it, groups competing rules that target overlapping selectors, and shows the full cascade chain for each group — with resolved variable values included.

**`impact_preview`** — answers "if I change this, what else breaks?"

Given a selector, property, and optional new value, predicts the full blast radius of the change before it's made — showing which selectors will see a different value, which are shielded by higher specificity, which cascade relationships are uncertain, and which downstream rules are affected through CSS variable chains or property inheritance. Works without a browser.

**`style_manifest`** — answers "what does this entire project's CSS look like at a glance?"

Builds a compressed, structured summary of a project's entire CSS knowledge — selectors, properties, variables, competition groups, and risk hotspots — that an agent can load once at the start of a session and keep in context instead of repeatedly querying individual files.

**`live_resolve`** — answers "what does the browser actually compute for this selector?"

Queries a running Chromium browser via CDP and returns exact computed styles and matched rules. No heuristics, no confidence levels — the browser resolved it. Requires Chrome running with `--remote-debugging-port=9222`.

## Quick start

### As a CLI tool

```bash
npm install -g @patrizzos/stylespeak
```

```bash
stylespeak resolve ".btn.primary" src/styles/main.css
stylespeak trace "color" --projectRoot src/styles
stylespeak impact ".btn" "background-color" src/styles/main.css --newValue "#ff0000"
stylespeak manifest --projectRoot src/styles
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
- `impact_preview({ selector, property, newValue?, files, projectRoot })`
- `style_manifest({ files?, projectRoot?, maxSelectors? })`
- `live_resolve({ selector, port?, tabUrl? })`

## Example output

### impact_preview

```bash
stylespeak impact ".btn" "background-color" src/styles/buttons.css --newValue "#ff0000"
```

```json
{
  "change": {
    "selector": ".btn",
    "property": "background-color",
    "currentValue": "var(--color-primary)",
    "newValue": "#ff0000"
  },
  "blastRadius": {
    "total": 3,
    "valueChanges": 1,
    "shielded": 1,
    "risks": 0,
    "variableDownstream": 0,
    "inheritanceDownstream": 1
  },
  "riskLevel": "low",
  "safeToChange": true,
  "impacts": [
    {
      "type": "value-change",
      "affectedSelector": ".btn",
      "currentValue": "var(--color-primary)",
      "newValue": "#ff0000",
      "confidence": "certain"
    },
    {
      "type": "shielded",
      "affectedSelector": ".btn.primary",
      "shieldingValue": "darkblue",
      "confidence": "certain",
      "reason": ".btn.primary has higher specificity — elements with both classes won't be affected"
    }
  ],
  "summary": "1 selector will see a different value, 1 selector is shielded by higher specificity.",
  "agentNote": "Change appears safe to make. Shielded selectors are safe — higher-specificity rules protect those elements."
}
```

### resolve_styles

```bash
stylespeak resolve ".btn" src/styles/buttons.css
```

```json
{
  "properties": {
    "background-color": {
      "winner": {
        "value": "var(--color-primary)",
        "resolvedValue": "#2563eb",
        "variableChain": ["--color-primary → #2563eb"],
        "selector": ".btn",
        "specificity": "(0,0,1,0)"
      },
      "confidence": "certain"
    }
  },
  "variables": { "--color-primary": { "value": "#2563eb", "selector": ":root" } }
}
```

## Confidence levels

| Level | Meaning |
|---|---|
| `certain` | Exact selector match — rule definitively applies |
| `likely` | Rule tokens are a subset of the queried selector — applies in most cases |
| `possible` | Combinator rule — depends on DOM ancestry, unknown without rendering |
| `exact` | Returned by `live_resolve` only — browser-resolved, no heuristics |

## CSS custom property resolution

As of v0.2, stylespeak fully resolves CSS custom properties (`var()`) in all output:

- `value` — the raw value as written (`var(--color-primary)`)
- `resolvedValue` — the actual resolved value (`#2563eb`)
- `variableChain` — the full resolution path, including chained variables
- `conditionalValues` — media-context overrides where the variable resolves differently

Supported: simple, fallback, nested fallback, chained, scoped, media-context, circular reference protection.

## How it pairs with stylesafe

**stylesafe** catches problems in your CSS — conflicts, dead rules, Tailwind clashes — before they ship.

**stylespeak** explains your CSS — resolving cascade, tracing properties, predicting impact, resolving variables — so agents understand before they act.

Use stylesafe as a post-edit check. Use stylespeak as a pre-edit consultation. Together they give AI coding agents a complete feedback loop on styles.

## Live browser inspection

`live_resolve` requires a Chromium browser running with remote debugging enabled:

```bash
# Windows
chrome.exe --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

> **Security note:** Never run `--remote-debugging-port` on a machine exposed to untrusted networks or in production. This flag opens a local API that any process on the machine can connect to.

## File format support

| Format | Support level |
|---|---|
| `.css` | Full |
| `.scss` | Full — nesting, `&` references, `@media` passthrough |
| `.module.css` / `.module.scss` | Full — locally scoped classes detected and tagged |
| vanilla-extract / Linaria / StyleX | Supported via compiled CSS output |
| styled-components / Emotion | Not supported — dynamic runtime styles |
| CSS-in-JS object syntax | Not supported (post v1.0 roadmap) |

## Architecture

```
src/
  cssParser.js            — CSS tokenizer with SCSS nesting support
  specificity.js          — standard (id, class, type) specificity calculator
  cssomBuilder.js         — in-memory cascade model builder
  selectorMatcher.js      — heuristic selector matching with confidence levels
  variableResolver.js     — CSS custom property resolution
  cssModulesAnalyzer.js   — CSS Modules local scope detection
  scssNestingExpander.js  — SCSS nesting pre-processor
  astComponentGraph.js    — AST component graph for graph-aware matching
  resolveStyles.js        — resolve_styles tool
  traceProperty.js        — trace_property tool
  impactPreview.js        — impact_preview tool
  styleManifest.js        — style_manifest project-wide knowledge builder
  cdpBridge.js            — Chrome DevTools Protocol WebSocket client
  liveResolve.js          — live_resolve tool
  server.js               — MCP server (stdio JSON-RPC) + CLI entry point
```

Zero external dependencies. Requires Node.js 21+.

## Roadmap

- **v0.2** ✅ — CSS custom property resolution
- **v0.3** ✅ — SCSS nesting, CSS Modules scope awareness, AST component graph
- **v1.0** ✅ — Chrome DevTools Protocol live resolution
- **v1.1** ✅ — impact_preview: blast radius prediction before making a change
- **v1.2** ✅ — style_manifest: compressed project-wide CSS knowledge for agent context
