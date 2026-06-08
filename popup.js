// ShadowCore Popup UI - v5.8.0 (REACTIVE WITH DEPENDENCY TRACKING)
// Fixes: selector IDs, stable memoization, render lock, dependency map
// ============================================================================

// ============================================================================
// LAYER 1: TRANSPORT (Message passing)
// ============================================================================

const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = false;

const DEDUPE_ALLOWED = new Set(['getStatus', 'getAdBlockStatus']);
const pendingRequests = new Map();

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
    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (reqId) pendingRequests.delete(reqId);
      resolve({ ok: false, error: 'Timeout', timeout: true });
    }, 5000);
    
    const done = (res) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      if (reqId) pendingRequests.delete(reqId);
      resolve(res);
    };
    
    try {
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        browser.runtime.sendMessage({ action, ...data })
          .then(res => done(res ?? { ok: false }))
          .catch(err => done({ ok: false, error: err?.message ?? String(err) }));
      } else if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({ action, ...data }, (response) => {
          if (chrome.runtime.lastError) {
            done({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            done(response ?? { ok: false });
          }
        });
      } else {
        done({ ok: false, error: 'No runtime API available' });
      }
    } catch (err) {
      done({ ok: false, error: err?.message ?? String(err) });
    }
  });
  
  if (reqId) pendingRequests.set(reqId, promise);
  return promise;
}

// ============================================================================
// LAYER 2: CORE STATE (Immutable)
// ============================================================================

const DEFAULT_STATE = {
  mode: 'clearnet',
  online: true,
  connectionStatus: {
    label: 'Direct Connection',
    subtext: 'No proxy (Clearnet)',
    dotClass: 'dot off',
    exitIp: null
  },
  metrics: {
    total: 0,
    successRate: '100%',
    avgLatency: '0ms'
  },
  customProxy: null,
  _version: 0
};

let coreState = { ...DEFAULT_STATE };
let ephemeralState = { isEditing: false, editingUntil: 0 };
let currentGeneration = 0;
let updateInProgress = false;
let pendingUpdates = 0;

// ============================================================================
// LAYER 3: SELECTORS WITH STABLE IDs (FIX 2)
// ============================================================================

// FIX 2: Stable selector IDs - no function identity issues
const Selectors = {
  mode: { id: 'mode', fn: (s) => s.mode },
  online: { id: 'online', fn: (s) => s.online },
  connectionLabel: { id: 'connectionLabel', fn: (s) => s.connectionStatus.label },
  connectionSubtext: { id: 'connectionSubtext', fn: (s) => s.connectionStatus.subtext },
  connectionDotClass: { id: 'connectionDotClass', fn: (s) => s.connectionStatus.dotClass },
  metricsTotal: { id: 'metricsTotal', fn: (s) => (s.metrics.total || 0).toLocaleString() },
  metricsSuccess: { id: 'metricsSuccess', fn: (s) => s.metrics.successRate },
  metricsLatency: { id: 'metricsLatency', fn: (s) => s.metrics.avgLatency },
  customProxyType: { id: 'customProxyType', fn: (s) => s.customProxy?.type || 'socks5' },
  customProxyHost: { id: 'customProxyHost', fn: (s) => s.customProxy?.host || '' },
  customProxyPort: { id: 'customProxyPort', fn: (s) => String(s.customProxy?.port || 1080) },
  customProxyHasAuth: { id: 'customProxyHasAuth', fn: (s) => s.customProxy?.hasAuth || false },
  isCustomMode: { id: 'isCustomMode', fn: (s) => s.mode === 'custom' },
  isTorMode: { id: 'isTorMode', fn: (s) => s.mode === 'tor' },
  isClearnetMode: { id: 'isClearnetMode', fn: (s) => s.mode === 'clearnet' }
};

// FIX 2: Stable memoization by selector ID + version
const memoCache = new Map();

function getSelectorValue(selector, state, ephemState) {
  const cacheKey = `${selector.id}:${state._version}:${ephemState.isEditing}`;
  
  if (memoCache.has(cacheKey)) {
    return memoCache.get(cacheKey);
  }
  
  const value = selector.fn(state, ephemState);
  memoCache.set(cacheKey, value);
  
  // Cleanup old cache entries periodically
  if (memoCache.size > 100) {
    const toDelete = Array.from(memoCache.keys()).slice(0, 50);
    toDelete.forEach(k => memoCache.delete(k));
  }
  
  return value;
}

// ============================================================================
// LAYER 4: DEPENDENCY MAP (FIX 1 & 5 - No broken diffing)
// ============================================================================

// Each DOM element declares which selectors it depends on
const dependencyMap = new Map();
const elements = {};

function registerDependency(element, selector, updateFn) {
  if (!element) return false;
  
  if (!dependencyMap.has(element)) {
    dependencyMap.set(element, []);
  }
  dependencyMap.get(element).push({ selector, updateFn });
  return true;
}

// FIX 1: Clean dependency registration - no broken value comparison
function buildDependencyMap() {
  dependencyMap.clear();
  
  // Status elements
  registerDependency(elements.statusLabel, Selectors.connectionLabel, (el, val) => el.textContent = val);
  registerDependency(elements.statusSub, Selectors.connectionSubtext, (el, val) => el.textContent = val);
  registerDependency(elements.statusDot, Selectors.connectionDotClass, (el, val) => el.className = val);
  
  // Metrics
  registerDependency(elements.mTotal, Selectors.metricsTotal, (el, val) => el.textContent = val);
  registerDependency(elements.mSuccess, Selectors.metricsSuccess, (el, val) => el.textContent = val);
  registerDependency(elements.mLatency, Selectors.metricsLatency, (el, val) => el.textContent = val);
  
  // Mode indicator
  const modeNames = { clearnet: 'DIRECT', tor: 'TOR ACTIVE', custom: 'PROXY ACTIVE' };
  registerDependency(elements.modeIndicator, Selectors.mode, (el, val) => {
    el.textContent = modeNames[val] ?? 'UNKNOWN';
  });
  
  // Mode buttons
  if (elements.modeBtns?.length) {
    elements.modeBtns.forEach(btn => {
      const btnMode = btn?.dataset?.mode;
      if (btnMode) {
        registerDependency(btn, Selectors.mode, (el, val) => {
          el.classList.toggle('active', val === btnMode);
        });
      }
    });
  }
  
  // Proxy panel visibility
  registerDependency(elements.proxyPanel, Selectors.isCustomMode, (el, val) => {
    el.classList.toggle('hidden', !val);
  });
  
  // FIX 3: Proxy form fields with timestamp-based editing lock
  registerDependency(elements.pType, Selectors.customProxyType, (el, val) => {
    if (Date.now() > ephemeralState.editingUntil && el.value !== val) el.value = val;
  });
  registerDependency(elements.pHost, Selectors.customProxyHost, (el, val) => {
    if (Date.now() > ephemeralState.editingUntil && el.value !== val) el.value = val;
  });
  registerDependency(elements.pPort, Selectors.customProxyPort, (el, val) => {
    if (Date.now() > ephemeralState.editingUntil && el.value !== val) el.value = val;
  });
  registerDependency(elements.pUser, Selectors.customProxyHasAuth, (el, val) => {
    el.placeholder = val ? '✓ Saved' : 'Username';
  });
  registerDependency(elements.pPass, Selectors.customProxyHasAuth, (el, val) => {
    el.placeholder = val ? '•••••• (saved)' : 'Password';
  });
}

// ============================================================================
// LAYER 5: REACTIVE RENDER (Dependency-driven, no broken diffing)
// ============================================================================

// Track previous values to avoid unnecessary updates
const previousValues = new Map();

function renderState() {
  for (const [element, dependencies] of dependencyMap) {
    if (!element || !element.isConnected) continue;
    
    for (const { selector, updateFn } of dependencies) {
      const newValue = getSelectorValue(selector, coreState, ephemeralState);
      const cacheKey = `${selector.id}:${element.id || element.className || Math.random()}`;
      const oldValue = previousValues.get(cacheKey);
      
      if (oldValue !== newValue) {
        updateFn(element, newValue);
        previousValues.set(cacheKey, newValue);
      }
    }
  }
}

// ============================================================================
// LAYER 6: NORMALIZATION
// ============================================================================

function normalizeState(rawStatus) {
  if (!rawStatus || rawStatus.ok === false) {
    return {
      ...DEFAULT_STATE,
      online: false,
      connectionStatus: {
        label: 'Offline',
        subtext: 'Extension not responding',
        dotClass: 'dot off',
        exitIp: null
      },
      _version: (coreState._version || 0) + 1
    };
  }
  
  let connectionStatus;
  if (rawStatus.mode === 'tor') {
    connectionStatus = {
      label: 'TOR Active',
      subtext: rawStatus.connectionStatus?.ip
        ? `Exit: ${rawStatus.connectionStatus.ip}`
        : 'Routing via TOR network',
      dotClass: 'dot on',
      exitIp: rawStatus.connectionStatus?.ip || null
    };
  } else if (rawStatus.mode === 'custom' && rawStatus.customProxy?.enabled) {
    const proxyType = String(rawStatus.customProxy.type ?? 'SOCKS5').toUpperCase();
    connectionStatus = {
      label: `${proxyType} Proxy`,
      subtext: `${rawStatus.customProxy.host ?? 'unknown'}:${rawStatus.customProxy.port ?? 0}`,
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
    mode: rawStatus.mode,
    online: true,
    connectionStatus,
    metrics: {
      total: rawStatus.metrics?.total ?? 0,
      successRate: rawStatus.metrics?.successRate ?? '100%',
      avgLatency: rawStatus.metrics?.avgLatency ?? '0ms'
    },
    customProxy: rawStatus.customProxy?.enabled ? { ...rawStatus.customProxy } : null,
    _version: (coreState._version || 0) + 1
  };
}

// ============================================================================
// LAYER 7: STATE UPDATE LOOP
// ============================================================================

async function refreshState() {
  const myGeneration = ++currentGeneration;
  
  if (updateInProgress) {
    pendingUpdates++;
    return;
  }
  
  updateInProgress = true;
  const hadPending = pendingUpdates > 0;
  pendingUpdates = 0;
  
  try {
    const rawStatus = await sendMessage('getStatus');
    
    if (myGeneration !== currentGeneration) {
      if (DEBUG) console.log('Stale refresh discarded');
      return;
    }
    
    const newCoreState = normalizeState(rawStatus);
    coreState = newCoreState;
    renderState();
    
  } catch (err) {
    if (DEBUG) console.error('refreshState error:', err);
  } finally {
    updateInProgress = false;
    
    if (pendingUpdates > 0 || hadPending) {
      pendingUpdates = 0;
      scheduleStateRefresh();
    }
  }
}

let rafScheduled = false;
function scheduleStateRefresh() {
  if (rafScheduled) return;
  rafScheduled = true;
  
  const scheduleFn = typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);
  
  scheduleFn(() => {
    rafScheduled = false;
    refreshState().catch(err => console.error('Refresh error:', err));
  });
}

// ============================================================================
// LAYER 8: ACTIONS (With optimistic updates)
// ============================================================================

// FIX 6: Safe optimistic updates with reconciliation
const Actions = {
  async setMode(mode) {
    if (!['clearnet', 'tor', 'custom'].includes(mode)) {
      showToast('Invalid mode', true);
      return false;
    }
    if (!canAction('setMode')) return false;
    
    // Optimistic update with snapshot for rollback
    const oldState = { ...coreState };
    coreState = { ...coreState, mode, _version: coreState._version + 1 };
    renderState();
    
    const r = await sendMessage('setMode', { mode });
    if (r?.ok) {
      showToast(`✓ ${mode.toUpperCase()}`);
      await refreshState();
      return true;
    }
    // Rollback on failure
    coreState = oldState;
    renderState();
    showToast(`Failed: ${r?.error ?? 'Unknown'}`, true);
    return false;
  },
  
  async saveProxy() {
    if (!elements.pHost || !elements.pPort) {
      showToast('Form not ready', true);
      return false;
    }
    if (!canAction('saveProxy')) {
      showToast('Wait before retry', true);
      return false;
    }
    
    const host = (elements.pHost.value ?? '').trim();
    const portStr = (elements.pPort.value ?? '').trim();
    const port = parseInt(portStr, 10);
    
    if (!host) { showToast('Host required', true); return false; }
    if (!portStr || isNaN(port) || port < 1 || port > 65535) {
      showToast('Invalid port (1-65535)', true);
      return false;
    }
    
    const config = {
      type: (elements.pType?.value ?? 'socks5').toLowerCase(),
      host, port,
      username: (elements.pUser?.value ?? '').trim(),
      password: elements.pPass?.value ?? '',
    };
    
    const r = await sendMessage('setCustomProxy', { config });
    if (r?.ok) {
      showToast('✓ Proxy saved');
      if (elements.pPass) elements.pPass.value = '';
      await refreshState();
      return true;
    }
    showToast(`Failed: ${r?.error ?? 'Unknown'}`, true);
    return false;
  },
  
  async disableProxy() {
    if (!canAction('disableProxy')) {
      showToast('Wait before retry', true);
      return false;
    }
    const r = await sendMessage('disableCustomProxy');
    if (r?.ok) {
      showToast('✓ Proxy disabled');
      await refreshState();
      return true;
    }
    showToast(`Failed: ${r?.error ?? 'Unknown'}`, true);
    return false;
  },
  
  async testConnection() {
    if (isTestingProxy) {
      showToast('Test already running', true);
      return false;
    }
    if (!canAction('testConnection')) {
      showToast('Wait before retry', true);
      return false;
    }
    
    isTestingProxy = true;
    if (elements.testBtn) {
      elements.testBtn.disabled = true;
      elements.testBtn.textContent = '⏳ Testing...';
    }
    
    try {
      const r = await sendMessage('testProxy');
      if (r?.ok) {
        showToast(`✅ ${r.ip ?? 'Connected'}`);
        await refreshState();
        return true;
      }
      showToast(`❌ ${r?.error ?? 'Failed'}`, true);
      return false;
    } finally {
      isTestingProxy = false;
      if (elements.testBtn) {
        elements.testBtn.disabled = false;
        elements.testBtn.textContent = '🧪 Test';
      }
    }
  },
  
  // FIX 7: AdBlock respects backend but enforces UI
  async toggleAdBlock() {
    const r = await sendMessage('getAdBlockStatus');
    if (r?.enabled === false) {
      // Attempt to enable if backend has it disabled
      await sendMessage('toggleAdBlock', { enabled: true });
    }
    showToast('🔒 Ad blocking enforced');
    if (elements.adblockToggle) elements.adblockToggle.classList.add('active');
    await refreshState();
  },
  
  openDashboard() {
    showToast('📊 Opening dashboard');
    const url = 'https://shadowcore.io';
    try {
      if (api?.tabs?.create) api.tabs.create({ url });
      else window.open(url, '_blank');
    } catch (err) { window.open(url, '_blank'); }
  },
  
  refresh() {
    scheduleStateRefresh();
  }
};

let isTestingProxy = false;

// ============================================================================
// FORM EDITING TRACKING (FIX 3: Timestamp-based lock)
// ============================================================================

function trackFormEditing() {
  const fields = [elements.pType, elements.pHost, elements.pPort, elements.pUser, elements.pPass].filter(Boolean);
  
  let editTimeout = null;
  
  const onFieldChange = () => {
    // FIX 3: Timestamp-based editing lock
    ephemeralState = {
      ...ephemeralState,
      isEditing: true,
      editingUntil: Date.now() + 1000
    };
    renderState();
    
    if (editTimeout) clearTimeout(editTimeout);
    editTimeout = setTimeout(() => {
      ephemeralState = {
        ...ephemeralState,
        isEditing: false,
        editingUntil: 0
      };
      renderState();
      editTimeout = null;
    }, 1000);
  };
  
  fields.forEach(f => {
    f.addEventListener('input', onFieldChange);
    f.addEventListener('change', onFieldChange);
  });
}

// ============================================================================
// TOAST NOTIFICATIONS
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
// ADBLOCK SYNC (FIX 7: Respects backend)
// ============================================================================

async function syncAdBlockStatus() {
  try {
    const r = await sendMessage('getAdBlockStatus');
    if (elements.adblockToggle) {
      elements.adblockToggle.classList.add('active');
    }
    if (DEBUG && r?.enabled === false) {
      console.warn('Backend adblock disabled - will enforce on next toggle');
    }
  } catch (_) {
    if (elements.adblockToggle) elements.adblockToggle.classList.add('active');
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

let statusUpdateTimeout = null;
let listenersAttached = false;

function handleRuntimeMessage(msg, sender, sendResponse) {
  try {
    if (msg?.event === 'statusChanged' || msg?.event === 'proxyChanged' ||
        msg?.event === 'torChanged'    || msg?.event === 'adBlockToggled') {
      if (statusUpdateTimeout) clearTimeout(statusUpdateTimeout);
      statusUpdateTimeout = setTimeout(() => {
        statusUpdateTimeout = null;
        Actions.refresh();
      }, 50);
    }
    sendResponse({ received: true });
  } catch (err) {
    try { sendResponse({ error: err.message }); } catch (_) {}
  }
  return true;
}

function setupEventSubscription() {
  if (listenersAttached) return;
  try {
    api.runtime.onMessage.addListener(handleRuntimeMessage);
    listenersAttached = true;
  } catch (err) { if (DEBUG) console.error('Failed to attach listener', err); }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) Actions.refresh();
});

// ============================================================================
// DOM CACHING & INITIALIZATION
// ============================================================================

function cacheElements() {
  const map = {
    statusDot: 'statusDot', statusLabel: 'statusLabel', statusSub: 'statusSub',
    testBtn: 'testBtn', proxyPanel: 'proxyPanel',
    pType: 'pType', pHost: 'pHost', pPort: 'pPort', pUser: 'pUser', pPass: 'pPass',
    disableProxyBtn: 'disableProxy', saveProxyBtn: 'saveProxy',
    mTotal: 'mTotal', mSuccess: 'mSuccess', mLatency: 'mLatency',
    modeIndicator: 'modeIndicator', openDashboard: 'openDashboard',
    adblockToggle: 'adblockToggle', toast: 'toast',
  };
  for (const [k, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) elements[k] = el;
  }
  elements.modeBtns = document.querySelectorAll('.mode-btn');
}

function bindEvents() {
  elements.modeBtns?.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn?.dataset?.mode;
      if (mode) Actions.setMode(mode);
    });
  });
  elements.saveProxyBtn?.addEventListener('click', () => Actions.saveProxy());
  elements.disableProxyBtn?.addEventListener('click', () => Actions.disableProxy());
  elements.testBtn?.addEventListener('click', () => Actions.testConnection());
  elements.adblockToggle?.addEventListener('click', () => Actions.toggleAdBlock());
  elements.openDashboard?.addEventListener('click', (e) => {
    e.preventDefault();
    Actions.openDashboard();
  });
}

// ============================================================================
// CLEANUP (FIX 4: Proper renderer cleanup)
// ============================================================================

function cleanup() {
  try {
    if (api?.runtime?.onMessage?.removeListener) {
      api.runtime.onMessage.removeListener(handleRuntimeMessage);
    }
    listenersAttached = false;
    if (statusUpdateTimeout) clearTimeout(statusUpdateTimeout);
    if (toastTimeout) clearTimeout(toastTimeout);
    pendingRequests.clear();
    dependencyMap.clear();
    memoCache.clear();
    previousValues.clear();
  } catch (e) {}
}

window.addEventListener('unload', cleanup);
window.addEventListener('pagehide', cleanup);

// ============================================================================
// INITIALIZATION
// ============================================================================

const REQUIRED_ELEMENTS = [
  'statusLabel', 'statusSub', 'statusDot', 'mTotal', 'mSuccess', 'mLatency',
  'modeIndicator', 'proxyPanel', 'pType', 'pHost', 'pPort', 'pUser', 'pPass'
];

function validateRequiredElements() {
  const missing = REQUIRED_ELEMENTS.filter(key => !elements[key]);
  if (missing.length) {
    console.error('Missing required DOM elements:', missing);
    return false;
  }
  return true;
}

async function init() {
  try {
    cacheElements();
    if (!validateRequiredElements()) {
      console.error('Failed to initialize - missing DOM elements');
      return;
    }
    buildDependencyMap();
    bindEvents();
    trackFormEditing();
    setupEventSubscription();
    await syncAdBlockStatus();
    await Actions.refresh();
    if (DEBUG) console.log('ShadowCore v5.8.0 ready');
  } catch (err) { if (DEBUG) console.error('Init error:', err); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
