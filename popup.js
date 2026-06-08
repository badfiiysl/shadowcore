// ShadowCore Popup UI - v6.0.0 (PRODUCTION REACTIVE - ALL CRITICAL FIXES)
// Dirty selector tracking, server-authoritative versioning, proper cleanup, strict contracts
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
// LAYER 2: CORE STATE (Immutable, server-authoritative)
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
let ephemeralState = { editingUntil: 0 }; // FIX 4: timestamp only, not boolean
let currentGeneration = 0;
let updateInProgress = false;
let pendingUpdates = 0;

// FIX 6: Track dirty selectors for reactive rendering
const dirtySelectors = new Set();

// ============================================================================
// LAYER 3: SELECTORS WITH STRICT CONTRACT (FIX 1)
// ============================================================================

// FIX 1: Enforce strict contract - all selectors are objects with id + fn
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

// Validate selector contract
Object.values(Selectors).forEach(sel => {
  if (!sel.id || typeof sel.fn !== 'function') {
    throw new Error(`Invalid selector: ${JSON.stringify(sel)}`);
  }
});

// FIX 1 & 3: Enforce strict getter with timestamp-based memoization
const get = (selector, state, ephem) => {
  const cacheKey = `${selector.id}:${state._version}:${ephem.editingUntil}`;
  const cached = memoCache.get(cacheKey);
  if (cached !== undefined) return cached;
  
  const value = selector.fn(state, ephem);
  memoCache.set(cacheKey, value);
  
  if (memoCache.size > MAX_CACHE_SIZE) {
    const toDelete = Array.from(memoCache.keys()).slice(0, Math.floor(MAX_CACHE_SIZE / 2));
    toDelete.forEach(k => memoCache.delete(k));
  }
  
  return value;
};

const memoCache = new Map();
const MAX_CACHE_SIZE = 100;

// ============================================================================
// LAYER 4: DEPENDENCY MAP (One-concern elements)
// ============================================================================

const dependencyMap = new Map();
const elements = {};
const eventListeners = []; // FIX 7: Track listeners for cleanup

function registerDependency(element, selector, updateFn) {
  if (!element) return false;
  
  if (!dependencyMap.has(element)) {
    dependencyMap.set(element, { selector, updateFn });
  }
  return true;
}

function buildDependencyMap() {
  dependencyMap.clear();
  
  // FIX 5: One selector per element (single concern)
  registerDependency(elements.statusLabel, Selectors.connectionLabel, (el, val) => el.textContent = val);
  registerDependency(elements.statusSub, Selectors.connectionSubtext, (el, val) => el.textContent = val);
  registerDependency(elements.statusDot, Selectors.connectionDotClass, (el, val) => el.className = val);
  
  registerDependency(elements.mTotal, Selectors.metricsTotal, (el, val) => el.textContent = val);
  registerDependency(elements.mSuccess, Selectors.metricsSuccess, (el, val) => el.textContent = val);
  registerDependency(elements.mLatency, Selectors.metricsLatency, (el, val) => el.textContent = val);
  
  const modeNames = { clearnet: 'DIRECT', tor: 'TOR ACTIVE', custom: 'PROXY ACTIVE' };
  registerDependency(elements.modeIndicator, Selectors.mode, (el, val) => {
    el.textContent = modeNames[val] ?? 'UNKNOWN';
  });
  
  registerDependency(elements.proxyPanel, Selectors.isCustomMode, (el, val) => {
    el.classList.toggle('hidden', !val);
  });
  
  // Mode buttons - register each separately
  if (elements.modeBtns?.length) {
    elements.modeBtns.forEach((btn, idx) => {
      if (btn?.dataset?.mode) {
        const btnMode = btn.dataset.mode;
        const btnElement = btn;
        // Create unique tracking for each button
        if (!dependencyMap.has(btnElement)) {
          dependencyMap.set(btnElement, { 
            selector: Selectors.mode, 
            updateFn: (el, val) => el.classList.toggle('active', val === btnMode),
            buttonMode: btnMode
          });
        }
      }
    });
  }
  
  // Form fields - only update if not currently editing
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
// LAYER 5: REACTIVE RENDER (FIX 2, 6 - Dirty tracking only)
// ============================================================================

const previousValues = new Map();

function renderState() {
  // FIX 6: Only render if selector is dirty OR first render
  if (dirtySelectors.size === 0 && previousValues.size > 0) {
    return; // Nothing changed, skip render
  }
  
  for (const [element, dep] of dependencyMap) {
    if (!element || !element.isConnected) continue;
    
    const { selector, updateFn } = dep;
    
    // FIX 6: Only render if dirty
    if (previousValues.size > 0 && !dirtySelectors.has(selector.id)) {
      continue;
    }
    
    // FIX 1: Use strict getter
    const newValue = get(selector, coreState, ephemeralState);
    
    // FIX 2: Cache key is stable, no selector object comparison
    const elementKey = element.id || `${element.tagName}:${element.className}`;
    const cacheKey = `${selector.id}:${elementKey}`;
    const oldValue = previousValues.get(cacheKey);
    
    // FIX 2: Only update if value actually changed
    if (oldValue !== newValue) {
      updateFn(element, newValue);
      previousValues.set(cacheKey, newValue);
    }
  }
  
  // FIX 6: Clear dirty set after render
  dirtySelectors.clear();
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
      _version: rawStatus?._version ?? 0
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
    _version: rawStatus._version ?? 0  // FIX 8: Server version is authoritative
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
    
    // FIX 6: Mark which selectors changed
    if (coreState._version !== newCoreState._version) {
      // Entire state changed, mark all dirty
      Object.values(Selectors).forEach(sel => dirtySelectors.add(sel.id));
    } else {
      // Partial update - compare values to find dirty selectors
      Object.entries(Selectors).forEach(([_, selector]) => {
        const oldVal = get(selector, coreState, ephemeralState);
        const newVal = get(selector, newCoreState, ephemeralState);
        if (oldVal !== newVal) {
          dirtySelectors.add(selector.id);
        }
      });
    }
    
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
// LAYER 8: ACTIONS (Server-authoritative versioning)
// ============================================================================

const Actions = {
  async setMode(mode) {
    if (!['clearnet', 'tor', 'custom'].includes(mode)) {
      showToast('Invalid mode', true);
      return false;
    }
    if (!canAction('setMode')) return false;
    
    // FIX 8: Optimistic update doesn't mutate version - let server define it
    const oldState = { ...coreState };
    coreState = { ...coreState, mode };
    dirtySelectors.add('mode');
    renderState();
    
    const r = await sendMessage('setMode', { mode });
    if (r?.ok) {
      showToast(`✓ ${mode.toUpperCase()}`);
      await refreshState();
      return true;
    }
    coreState = oldState;
    dirtySelectors.add('mode');
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
  
  async toggleAdBlock() {
    const r = await sendMessage('getAdBlockStatus');
    if (r?.enabled === false) {
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
// FORM EDITING TRACKING (FIX 4: Timestamp only)
// ============================================================================

function trackFormEditing() {
  const fields = [elements.pType, elements.pHost, elements.pPort, elements.pUser, elements.pPass].filter(Boolean);
  
  let editTimeout = null;
  
  const onFieldChange = () => {
    // FIX 4: Use timestamp for all editing state
    const now = Date.now();
    ephemeralState = { editingUntil: now + 1000 };
    
    // Mark form fields as dirty
    dirtySelectors.add('customProxyType');
    dirtySelectors.add('customProxyHost');
    dirtySelectors.add('customProxyPort');
    dirtySelectors.add('customProxyHasAuth');
    
    renderState();
    
    if (editTimeout) clearTimeout(editTimeout);
    editTimeout = setTimeout(() => {
      ephemeralState = { editingUntil: 0 };
      dirtySelectors.add('customProxyType');
      dirtySelectors.add('customProxyHost');
      dirtySelectors.add('customProxyPort');
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
// ADBLOCK SYNC
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
// EVENT HANDLERS (FIX 7: Track listener refs)
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
    eventListeners.push({ type: 'runtime', handler: handleRuntimeMessage });
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
    const clickHandler = () => {
      const mode = btn?.dataset?.mode;
      if (mode) Actions.setMode(mode);
    };
    btn.addEventListener('click', clickHandler);
    eventListeners.push({ type: 'click', element: btn, handler: clickHandler });
  });
  
  const saveHandler = () => Actions.saveProxy();
  elements.saveProxyBtn?.addEventListener('click', saveHandler);
  eventListeners.push({ type: 'click', element: elements.saveProxyBtn, handler: saveHandler });
  
  const disableHandler = () => Actions.disableProxy();
  elements.disableProxyBtn?.addEventListener('click', disableHandler);
  eventListeners.push({ type: 'click', element: elements.disableProxyBtn, handler: disableHandler });
  
  const testHandler = () => Actions.testConnection();
  elements.testBtn?.addEventListener('click', testHandler);
  eventListeners.push({ type: 'click', element: elements.testBtn, handler: testHandler });
  
  const adblockHandler = () => Actions.toggleAdBlock();
  elements.adblockToggle?.addEventListener('click', adblockHandler);
  eventListeners.push({ type: 'click', element: elements.adblockToggle, handler: adblockHandler });
  
  const dashboardHandler = (e) => {
    e.preventDefault();
    Actions.openDashboard();
  };
  elements.openDashboard?.addEventListener('click', dashboardHandler);
  eventListeners.push({ type: 'click', element: elements.openDashboard, handler: dashboardHandler });
}

// ============================================================================
// CLEANUP (FIX 7: Proper listener detachment)
// ============================================================================

function cleanup() {
  try {
    // FIX 7: Detach all tracked listeners
    eventListeners.forEach(({ type, element, handler }) => {
      if (type === 'runtime') {
        if (api?.runtime?.onMessage?.removeListener) {
          api.runtime.onMessage.removeListener(handler);
        }
      } else if (element && handler) {
        element.removeEventListener(type, handler);
      }
    });
    eventListeners.length = 0;
    
    listenersAttached = false;
    if (statusUpdateTimeout) clearTimeout(statusUpdateTimeout);
    if (toastTimeout) clearTimeout(toastTimeout);
    
    pendingRequests.clear();
    dependencyMap.clear();
    memoCache.clear();
    previousValues.clear();
    dirtySelectors.clear();
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
    
    // Initial render - mark all dirty
    Object.values(Selectors).forEach(sel => dirtySelectors.add(sel.id));
    await Actions.refresh();
    
    if (DEBUG) console.log('ShadowCore v6.0.0 ready');
  } catch (err) { if (DEBUG) console.error('Init error:', err); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
