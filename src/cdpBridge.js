/**
 * CDP Bridge — stylespeak v1.0
 *
 * Low-level Chrome DevTools Protocol client using Node 22+'s built-in
 * WebSocket global. Zero external dependencies.
 *
 * Workflow:
 *   1. HTTP GET http://localhost:{port}/json — discovers open tabs
 *   2. Pick target tab (active or by URL pattern)
 *   3. Open WebSocket to tab's webSocketDebuggerUrl
 *   4. Send/receive CDP commands via JSON message protocol
 *   5. Close connection when done
 *
 * Each CDP command has a unique numeric ID. Responses carry the same ID.
 * Events (no ID) are emitted separately and tracked for async flows.
 */

const http = require('http');

const DEFAULT_PORT = 9222;
const CONNECTION_TIMEOUT_MS = 5000;

// ─── Tab discovery ────────────────────────────────────────────────────────────

/**
 * Fetches the list of open tabs from the CDP endpoint.
 * Returns an array of tab descriptors: { id, title, url, webSocketDebuggerUrl, type }
 */
function discoverTabs(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/json`, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data);
          resolve(tabs.filter(t => t.type === 'page'));
        } catch {
          reject(new Error('Failed to parse CDP tab list'));
        }
      });
    });
    req.on('error', err => {
      if (err.code === 'ECONNREFUSED') {
        reject(new CdpNotRunningError(port));
      } else {
        reject(err);
      }
    });
    req.setTimeout(CONNECTION_TIMEOUT_MS, () => {
      req.destroy();
      reject(new CdpNotRunningError(port));
    });
  });
}

/**
 * Selects the best tab to inspect.
 * If tabUrl is provided, picks the first tab whose URL contains it.
 * Otherwise picks the first available page tab.
 */
function selectTab(tabs, tabUrl) {
  if (!tabs || tabs.length === 0) return null;
  if (tabUrl) {
    const match = tabs.find(t => t.url && t.url.includes(tabUrl));
    if (match) return match;
  }
  return tabs[0];
}

// ─── CDP Session ──────────────────────────────────────────────────────────────

class CdpSession {
  constructor(ws) {
    this._ws = ws;
    this._nextId = 1;
    this._pending = new Map(); // id → { resolve, reject }
    this._closed = false;

    ws.addEventListener('message', evt => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });

    ws.addEventListener('close', () => {
      this._closed = true;
      for (const { reject } of this._pending.values()) {
        reject(new Error('CDP WebSocket closed'));
      }
      this._pending.clear();
    });

    ws.addEventListener('error', err => {
      for (const { reject } of this._pending.values()) {
        reject(err);
      }
      this._pending.clear();
    });
  }

  send(method, params = {}) {
    if (this._closed) return Promise.reject(new Error('CDP session is closed'));
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (!this._closed) this._ws.close();
  }
}

/**
 * Opens a CDP session to a specific tab's WebSocket debugger URL.
 */
function openSession(tab) {
  return new Promise((resolve, reject) => {
    const wsUrl = tab.webSocketDebuggerUrl;
    if (!wsUrl) return reject(new Error('Tab has no webSocketDebuggerUrl — it may already be inspected by DevTools'));

    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP WebSocket connection timed out'));
    }, CONNECTION_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(new CdpSession(ws));
    });

    ws.addEventListener('error', err => {
      clearTimeout(timeout);
      reject(new Error('CDP WebSocket error: ' + (err.message || 'unknown')));
    });
  });
}

// ─── High-level helpers ───────────────────────────────────────────────────────

/**
 * Queries a CSS selector against the real DOM and returns the matching node ID.
 * Returns null if no element matches.
 */
async function findNode(session, selector) {
  const { root } = await session.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  return nodeId || null;
}

/**
 * Main entry: connects to Chrome, inspects a selector, returns raw CDP data.
 * Caller is responsible for closing the session.
 */
async function inspect(selector, { port = DEFAULT_PORT, tabUrl = null } = {}) {
  const tabs = await discoverTabs(port);
  const tab = selectTab(tabs, tabUrl);

  if (!tab) {
    throw new Error(
      'No inspectable tabs found. Make sure Chrome is open with at least one page loaded.'
    );
  }

  const session = await openSession(tab);

  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');

    const nodeId = await findNode(session, selector);
    if (!nodeId) {
      session.close();
      return { nodeId: null, tab, selector };
    }

    const [matchedStyles, computedStyles, inlineStyles] = await Promise.all([
      session.send('CSS.getMatchedStylesForNode', { nodeId }),
      session.send('CSS.getComputedStyleForNode', { nodeId }),
      session.send('CSS.getInlineStylesForNode', { nodeId }).catch(() => ({ inlineStyle: null })),
    ]);

    session.close();

    return {
      nodeId,
      tab: { title: tab.title, url: tab.url },
      selector,
      matchedStyles,
      computedStyles,
      inlineStyles,
    };
  } catch (err) {
    session.close();
    throw err;
  }
}

// ─── Error types ──────────────────────────────────────────────────────────────

class CdpNotRunningError extends Error {
  constructor(port) {
    super(
      'Chrome DevTools Protocol is not reachable at localhost:' + port + '. ' +
      'Start Chrome with remote debugging enabled:\n\n' +
      '  Windows:  chrome.exe --remote-debugging-port=' + port + '\n' +
      '  macOS:    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=' + port + '\n' +
      '  Linux:    google-chrome --remote-debugging-port=' + port + '\n' +
      '  Edge:     msedge --remote-debugging-port=' + port + '\n' +
      '  Brave:    brave-browser --remote-debugging-port=' + port + '\n\n' +
      'Then navigate to your app and try again. ' +
      'Alternatively use resolve_styles for static analysis without a running browser.'
    );
    this.name = 'CdpNotRunningError';
    this.port = port;
    this.code = 'CDP_NOT_RUNNING';
  }
}

module.exports = { inspect, discoverTabs, selectTab, CdpNotRunningError, DEFAULT_PORT };
