# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-09

### Added
- **resolve_styles**: Resolves what CSS actually applies to a given selector — every property the selector receives, which rule wins for each property, and which rules were overridden with confidence levels (certain/likely/possible).
- **trace_property**: Traces a CSS property across all provided files — finds every rule that sets it, groups competing rules targeting overlapping selectors, shows who wins in each group.
- **CLI interface**: `node server.js resolve <selector> [file...] [--projectRoot <dir>]` and `node server.js trace <property> [file...] [--projectRoot <dir>]`.
- **MCP server mode**: Reads JSON-RPC from stdin, exposes two tools — `resolve_styles` and `trace_property`.
- **CSSOM builder** (`src/cssomBuilder.js`): Builds a CSS Object Model from file paths for cascade analysis.
- **Selector matcher** (`src/selectorMatcher.js`): Matches selectors against each other to determine competing relationships (e.g., `.btn` vs `.btn.primary`).
- **Specificity calculator** (`src/specificity.js`): Calculates CSS specificity scores and formats them as human-readable strings like "0,2,1".

### Changed
- **server.js**: Now serves both CLI mode (when run with arguments) and MCP server mode (stdin JSON-RPC). Handles `initialize`, `tools/list`, `tools/call`, and error responses.

## [0.1.0] - 2026-07-03

### Added
- **Initial release**: Basic CSS cascade analysis tools for AI agents.
- **Core modules**: `cssParser.js` (parses CSS files into a structured model), `specificity.js` (calculates specificity scores).
- **README.md** with usage examples and API documentation.

## [0.1.1] - 2026-07-09 (patch)

### Fixed
- **server.js**: Added proper error handling for unknown tools and malformed requests in MCP server mode.
