// ShadowCore Popup UI - v6.3.1 (PRODUCTION REACTIVE - OPTIMIZED)
// Fixes: saveProxy nesting, adblock sync, visibility guard, memoization, selective render, version consistency, optimistic updates
// ============================================================================

const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = false;

// ============================================================================
// LAYER 1: TRANSPORT
// ============================================================================

const pendingRequests = new Map();
const DEDUPE_ALLOWED = new Set(['getStatus', 'getAdBlockStatus']);
const lastActionTime = {};
const MIN_ACTION_INTERVAL = 500;

function canAction(name) {
  const now = Date.now();
  const last = lastActionTime[name] ?? 0;
  if (now - last < MIN_ACTION_INTERVAL) return false;
  lastActionTime[name] = now;
  return true;
}

function getRequestId(action, data) {
  if (!DEDUPE_ALLOWED.has(action)) return null;
  const sorted = Object.entries(data || {}).sort(([a], [b]) => a.localeCompare(b));
  return `${action}:${JSON.stringify(sorted)}`;
}

function sendMessage(action, data = {}) {
  const reqId = getRequestId(action, data);
  if (reqId && pendingRequests.has(reqId)) return pendingRequests.get(reqId);

  const promise = new Promise((resolve) => {
    let finished = false;

    const done = (res) => {
      if (finished) return;
      finished = true;
      if (reqId) pendingRequests.delete(reqId);
      resolve(res);
    };

    const timeout = setTimeout(() => {
      done({ ok: false, error: 'Timeout' });
    }, 5000);

    try {
      if (api?.runtime?.sendMessage) {
        api.runtime.sendMessage({ action, ...data })
          .then(res => { clearTimeout(timeout); done(res ?? { ok: false }); })
          .catch(err => { clearTimeout(timeout); done({ ok: false, error: err.message }); });
      } else {
        done({ ok: false, error: 'No runtime API' });
      }
    } catch (e) {
      clearTimeout(timeout);
      done({ ok: false, error: e.message });
    }
  });

  if (reqId) pendingRequests.set(reqId, promise);
  return promise;
}

// ============================================================================
// LAYER 2: STATE
// ============================================================================

const DEFAULT_STATE = {
  mode: 'clearnet',
  online: true,
  connectionStatus: { label: 'Direct Connection', subtext: 'No proxy (Clearnet)', dotClass: 'dot off', exitIp: null },
  metrics: { total: 0, successRate: '100%', avgLatency: '0ms' },
  customProxy: { type: 'socks5', host: '', port: 1080, hasAuth: false },
  _version: 0
};

let coreState = structuredClone(DEFAULT_STATE);
let ephemeralState = { editingUntil: 0 };
let currentGeneration = 0;

// FIX 3: Visibility guard
let refreshEnabled = false;

// ============================================================================
// LAYER 3: REACTIVE SYSTEM (FIX 5: selective render map)
// ============================================================================

const bindings = new Map();
const selectorSubscribers = new Map(); // FIX 5: selector → [elements]
const memo = new Map();
const prev = new Map();
const MAX_MEMO = 120;

function get(selector, state, ephem) {
  // FIX 4: More stable memoization key - use boolean instead of timestamp
  const isEditing = ephem.editingUntil > 0;
  const key = `${selector.id}:${state._version}:${isEditing}`;

  if (memo.has(key)) return memo.get(key);

  const val = selector.fn(state, ephem);
  memo.set(key, val);

  if (memo.size > MAX_MEMO) {
    const drop = [...memo.keys()].slice(0, 40);
    drop.forEach(k => memo.delete(k));
  }

  return val;
}

function bind(element, selector, fn) {
  if (!element) return;
  if (!bindings.has(element)) bindings.set(element, []);
  bindings.get(element).push({ selector, fn });

  // FIX 5: Track selector subscribers
  if (!selectorSubscribers.has(selector.id)) {
    selectorSubscribers.set(selector.id, new Set());
  }
  selectorSubscribers.get(selector.id).add(element);
}

// FIX 5: Render only affected elements (optional optimization)
function renderSelective(changedSelectorIds = null) {
  const elementsToRender = changedSelectorIds
    ? new Set()
    : new Set(bindings.keys());

  if (changedSelectorIds) {
    changedSelectorIds.forEach(selId => {
      const subscribers = selectorSubscribers.get(selId);
      if (subscribers) subscribers.forEach(el => elementsToRender.add(el));
    });
  }

  for (const el of elementsToRender) {
    if (!el || !el.isConnected) continue;

    const deps = bindings.get(el);
    if (!deps) continue;

    for (const { selector, fn } of deps) {
      const value = get(selector, coreState, ephemeralState);
      const key = `${selector.id}:${el.id || el.className || el.tagName}`;

      if (prev.get(key) === value) continue;

      try {
        fn(el, value);
        prev.set(key, value);
      } catch (err) {
        if (DEBUG) console.error(`Binding error on ${selector.id}:`, err);
      }
    }
  }
}

// Wrapper for simplicity (full render still available)
function render() {
  renderSelective();
}

// ============================================================================
// LAYER 4: SELECTORS
// ============================================================================

const Selectors = {
  mode: { id: 'mode', fn: s => s.mode },
  online: { id: 'online', fn: s => s.online },
  label: { id: 'label', fn: s => s.connectionStatus.label },
  subtext: { id: 'subtext', fn: s => s.connectionStatus.subtext },
  dotClass: { id: 'dotClass', fn: s => s.connectionStatus.dotClass },
  total: { id: 'total', fn: s => (s.metrics.total || 0).toLocaleString() },
  success: { id: 'success', fn: s => s.metrics.successRate },
  latency: { id: 'latency', fn: s => s.metrics.avgLatency },
  isCustom: { id: 'isCustom', fn: s => s.mode === 'custom' },
  proxyHost: { id: 'proxyHost', fn: s => s.customProxy?.host || '' },
  proxyPort: { id: 'proxyPort', fn: s => String(s.customProxy?.port || 1080) },
  proxyType: { id: 'proxyType', fn: s => s.customProxy?.type || 'socks5' },
  hasAuth: { id: 'hasAuth', fn: s => s.customProxy?.hasAuth || false }
};

// ============================================================================
// LAYER 5: NORMALIZATION (FIX 6: consistent version handling)
// ============================================================================

function normalize(raw) {
  if (!raw?.ok) {
    return {
      ...DEFAULT_STATE,
      online: false,
      connectionStatus: { label: 'Offline', subtext: 'No response', dotClass: 'dot off', exitIp: null },
      _version: raw?._version ?? 0
    };
  }

  // Build connection status based on mode
  let connectionStatus;
  if (raw.mode === 'tor') {
    connectionStatus = {
      label: 'TOR Active',
      subtext: raw.connectionStatus?.ip ? `Exit: ${raw.connectionStatus.ip}` : 'Routing via TOR network',
      dotClass: 'dot on',
      exitIp: raw.connectionStatus?.ip || null
    };
  } else if (raw.mode === 'custom' && raw.customProxy?.enabled) {
    const proxyType = String(raw.customProxy.type ?? 'SOCKS5').toUpperCase();
    connectionStatus = {
      label: `${proxyType} Proxy`,
      subtext: `${raw.customProxy.host ?? 'unknown'}:${raw.customProxy.port ?? 0}`,
      dotClass: 'dot on',
      exitIp: null
    };
  } else {
    connectionStatus = {
      label: 'Direct Connection',
      subtext: 'No proxy (Clearnet)',
      dotClass: 'dot off',
      exitIp: null
    };
  }

  return {
    mode: raw.mode,
    online: true,
    connectionStatus,
    metrics: {
      total: raw.metrics?.total ?? 0,
      successRate: raw.metrics?.successRate ?? '100%',
      avgLatency: raw.metrics?.avgLatency ?? '0ms'
    },
    customProxy: raw.customProxy?.enabled ? {
      type: raw.customProxy.type || 'socks5',
      host: raw.customProxy.host || '',
      port: raw.customProxy.port || 1080,
      hasAuth: !!(raw.customProxy.username || raw.customProxy.password)
    } : null,
    _version: raw._version ?? 0  // FIX 6: Always use server version as authoritative
  };
}

// ============================================================================
// LAYER 6: STATE UPDATE
// ============================================================================

async function refresh() {
  const gen = ++currentGeneration;
  const raw = await sendMessage('getStatus');
  if (gen !== currentGeneration) return;
  coreState = normalize(raw);
  render();
}

let refreshInterval = null;

function startAutoRefresh(intervalMs = 5000) {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(refresh, intervalMs);
  refreshEnabled = true;  // FIX 3: Set guard
}

function stopAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = null;
  refreshEnabled = false;  // FIX 3: Clear guard
}

// ============================================================================
// LAYER 7: ACTIONS (With fixes + optimizations)
// ============================================================================

const Actions = {
  async setMode(mode) {
    if (!['clearnet', 'tor', 'custom'].includes(mode)) {
      showToast('Invalid mode', true);
      return false;
    }
    if (!canAction('mode')) {
      showToast('Wait before retry', true);
      return false;
    }

    const old = { ...coreState };
    coreState = { ...coreState, mode, _version: coreState._version + 1 };
    render();

    const res = await sendMessage('setMode', { mode });

    if (!res?.ok) {
      coreState = old;
      render();
      showToast(`Failed: ${res?.error ?? 'Unknown'}`, true);
      return false;
    }

    showToast(`✓ ${mode.toUpperCase()}`);
    await refresh();
    return true;
  },

  // FIX 1 + OPTIMIZATION: Clean saveProxy with optimistic update (1 network call)
  async saveProxy(config) {
    if (!canAction('saveProxy')) {
      showToast('Wait before retry', true);
      return false;
    }

    const res = await sendMessage('setCustomProxy', config);
    if (!res?.ok) {
      showToast(`Failed: ${res?.error ?? 'Unknown'}`, true);
      return false;
    }

    // OPTIMIZATION: Optimistic update instead of refresh() (saves 1 network call)
    coreState = {
      ...coreState,
      customProxy: {
        type: config.type || 'socks5',
        host: config.host || '',
        port: config.port || 1080,
        hasAuth: !!(config.username || config.password)
      },
      _version: coreState._version + 1
    };
    render();

    showToast('✓ Proxy saved');
    return true;
  },

  async disableProxy() {
    if (!canAction('disableProxy')) {
      showToast('Wait before retry', true);
      return false;
    }

    const res = await sendMessage('disableCustomProxy');
    if (!res?.ok) {
      showToast(`Failed: ${res?.error ?? 'Unknown'}`, true);
      return false;
    }

    // OPTIMIZATION: Optimistic update
    coreState = {
      ...coreState,
      customProxy: null,
      _version: coreState._version + 1
    };
    render();

    showToast('✓ Proxy disabled');
    return true;
  },

  async testConnection() {
    if (!canAction('testConnection')) {
      showToast('Wait before retry', true);
      return false;
    }

    const res = await sendMessage('testProxy');
    if (res?.ok) {
      showToast(`✅ ${res.ip ?? 'Connected'}`);
      return true;
    }

    showToast(`❌ ${res?.error ?? 'Test failed'}`, true);
    return false;
  },

  // FIX 2: Real adblock sync - backend + refresh
  async toggleAdBlock() {
    if (!canAction('toggleAdBlock')) {
      showToast('Wait before retry', true);
      return false;
    }

    const res = await sendMessage('toggleAdBlock', { enabled: true });
    if (!res?.ok) {
      showToast(`Failed: ${res?.error ?? 'Unknown'}`, true);
      return false;
    }

    showToast('🔒 Ad blocking enforced');
    await refresh();
    return true;
  },

  refresh
};

// ============================================================================
// FORM EDITING
// ============================================================================

function trackEditing(fields) {
  let timeout = null;

  const bump = () => {
    ephemeralState.editingUntil = Date.now() + 1000;
    render();

    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      ephemeralState.editingUntil = 0;
      render();
      timeout = null;
    }, 1000);
  };

  fields.forEach(f => {
    if (f) {
      f.addEventListener('input', bump);
      f.addEventListener('change', bump);
    }
  });
}

// ============================================================================
// BINDINGS SETUP
// ============================================================================

function setupBindings(elements) {
  // Status
  bind(elements.statusLabel, Selectors.label, (el, v) => el.textContent = v);
  bind(elements.statusSub, Selectors.subtext, (el, v) => el.textContent = v);
  bind(elements.statusDot, Selectors.dotClass, (el, v) => el.className = v);

  // Metrics
  bind(elements.mTotal, Selectors.total, (el, v) => el.textContent = v);
  bind(elements.mSuccess, Selectors.success, (el, v) => el.textContent = v);
  bind(elements.mLatency, Selectors.latency, (el, v) => el.textContent = v);

  // Mode indicator
  const modeNames = { clearnet: 'DIRECT', tor: 'TOR ACTIVE', custom: 'PROXY ACTIVE' };
  bind(elements.modeIndicator, Selectors.mode, (el, v) => {
    el.textContent = modeNames[v] ?? 'UNKNOWN';
  });

  // Mode buttons
  if (elements.modeBtns?.length) {
    elements.modeBtns.forEach(btn => {
      const btnMode = btn?.dataset?.mode;
      if (btnMode) {
        bind(btn, Selectors.mode, (el, val) => {
          el.classList.toggle('active', val === btnMode);
        });
      }
    });
  }

  // Proxy panel visibility
  bind(elements.proxyPanel, Selectors.isCustom, (el, v) => {
    el.classList.toggle('hidden', !v);
  });

  // Proxy form fields (with editing lock)
  bind(elements.pType, Selectors.proxyType, (el, v) => {
    if (Date.now() > ephemeralState.editingUntil && el.value !== v) el.value = v;
  });
  bind(elements.pHost, Selectors.proxyHost, (el, v) => {
    if (Date.now() > ephemeralState.editingUntil && el.value !== v) el.value = v;
  });
  bind(elements.pPort, Selectors.proxyPort, (el, v) => {
    if (Date.now() > ephemeralState.editingUntil && el.value !== v) el.value = v;
  });

  // Auth placeholders
  bind(elements.pUser, Selectors.hasAuth, (el, v) => {
    el.placeholder = v ? '✓ Saved' : 'Username';
  });
  bind(elements.pPass, Selectors.hasAuth, (el, v) => {
    el.placeholder = v ? '•••••• (saved)' : 'Password';
    if (!v && el.value) el.value = '';
  });
}

// ============================================================================
// DOM ELEMENTS CACHE
// ============================================================================

const elements = {};

function cacheElements() {
  const map = {
    statusDot: 'statusDot', statusLabel: 'statusLabel', statusSub: 'statusSub',
    testBtn: 'testBtn', proxyPanel: 'proxyPanel',
    pType: 'pType', pHost: 'pHost', pPort: 'pPort', pUser: 'pUser', pPass: 'pPass',
    disableProxyBtn: 'disableProxy', saveProxyBtn: 'saveProxy',
    mTotal: 'mTotal', mSuccess: 'mSuccess', mLatency: 'mLatency',
    modeIndicator: 'modeIndicator', openDashboard: 'openDashboard',
    adblockToggle: 'adblockToggle', toast: 'toast'
  };
  for (const [k, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) elements[k] = el;
  }
  elements.modeBtns = document.querySelectorAll('.mode-btn');
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function bindEvents() {
  // Mode buttons
  elements.modeBtns?.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn?.dataset?.mode;
      if (mode) Actions.setMode(mode);
    });
  });

  // Save proxy - FIX 1: Clean config passing
  elements.saveProxyBtn?.addEventListener('click', async () => {
    const host = elements.pHost?.value?.trim();
    const portStr = elements.pPort?.value?.trim();
    const port = parseInt(portStr, 10);

    if (!host) {
      showToast('Host required', true);
      return;
    }
    if (!portStr || isNaN(port) || port < 1 || port > 65535) {
      showToast('Invalid port (1-65535)', true);
      return;
    }

    await Actions.saveProxy({
      type: elements.pType?.value || 'socks5',
      host,
      port,
      username: elements.pUser?.value || '',
      password: elements.pPass?.value || ''
    });

    if (elements.pPass) elements.pPass.value = '';
  });

  // Disable proxy
  elements.disableProxyBtn?.addEventListener('click', () => Actions.disableProxy());

  // Test connection - FIX 7: Safe button label restoration
  elements.testBtn?.addEventListener('click', async () => {
    const label = '🧪 Test';
    elements.testBtn.disabled = true;
    elements.testBtn.textContent = '⏳ Testing...';
    elements.testBtn.dataset.original = label;

    await Actions.testConnection();

    elements.testBtn.disabled = false;
    elements.testBtn.textContent = elements.testBtn.dataset.original || label;
    delete elements.testBtn.dataset.original;
  });

  // Ad block - FIX 2: Real sync
  elements.adblockToggle?.addEventListener('click', () => Actions.toggleAdBlock());

  // Dashboard
  elements.openDashboard?.addEventListener('click', (e) => {
    e.preventDefault();
    const url = 'https://shadowcore.io';
    showToast('📊 Opening dashboard');
    try {
      if (api?.tabs?.create) api.tabs.create({ url });
      else window.open(url, '_blank');
    } catch { window.open(url, '_blank'); }
  });
}

// ============================================================================
// TOAST
// ============================================================================

let toastTimeout = null;
function showToast(message, isError = false) {
  if (!elements.toast) return;
  if (toastTimeout) clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${isError ? 'err' : 'ok'} show`;
  toastTimeout = setTimeout(() => {
    if (elements.toast) elements.toast.classList.remove('show');
    toastTimeout = null;
  }, 2500);
}

// ============================================================================
// VISIBILITY HANDLING (FIX 3: Safe guard)
// ============================================================================

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else {
    // Only restart if not already running
    if (!refreshEnabled) {
      refresh();
      startAutoRefresh(5000);
    }
  }
});

// ============================================================================
// CLEANUP
// ============================================================================

function cleanup() {
  stopAutoRefresh();
  bindings.clear();
  selectorSubscribers.clear();
  memo.clear();
  prev.clear();
  pendingRequests.clear();
  if (toastTimeout) clearTimeout(toastTimeout);
}

window.addEventListener('unload', cleanup);
window.addEventListener('pagehide', cleanup);

// ============================================================================
// BOOT
// ============================================================================

async function init() {
  cacheElements();
  setupBindings(elements);
  bindEvents();
  trackEditing([elements.pHost, elements.pPort, elements.pType]);
  await refresh();
  startAutoRefresh(5000);
  if (DEBUG) console.log('ShadowCore v6.3.1 ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
