// ShadowCore Popup UI - v5.0.0 (REFACTORED FOR ROBUSTNESS)
// Improvements: Promise safety, proper token validation, race condition elimination, 
// atomic DOM updates, form state isolation, comprehensive error boundaries
// ============================================================================

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let currentMode = 'clearnet';
let currentStatus = null;
let adblockEnabled = true;

// Update coordination (atomic + token-based)
let updateInProgress = false;
let updateToken = 0;
let pendingUpdateToken = null;

// Timer management
let statusUpdateTimeout = null;
let toastTimeout = null;
const activeTimeouts = new Set();

// Anti-spam (per-action)
const lastActionTime = {};
const MIN_ACTION_INTERVAL = 500;

// Concurrency guards
let isTestingProxy = false;
let listenersAttached = false;

// Promise deduplication (never resolve with stale data)
const pendingRequests = new Map();

// Form state isolation (prevent read/write conflicts)
const formState = {
  isEditing: false,
  editTimeout: null,
  lastEditTime: 0
};

// API
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = false;

// DOM Elements
const elements = {};

// ============================================================================
// INITIALIZATION
// ============================================================================

function cacheElements() {
  const elementMap = {
    statusDot: 'statusDot',
    statusLabel: 'statusLabel',
    statusSub: 'statusSub',
    testBtn: 'testBtn',
    proxyPanel: 'proxyPanel',
    pType: 'pType',
    pHost: 'pHost',
    pPort: 'pPort',
    pUser: 'pUser',
    pPass: 'pPass',
    disableProxyBtn: 'disableProxy',
    saveProxyBtn: 'saveProxy',
    mTotal: 'mTotal',
    mSuccess: 'mSuccess',
    mLatency: 'mLatency',
    modeIndicator: 'modeIndicator',
    openDashboard: 'openDashboard',
    adblockToggle: 'adblockToggle',
    toast: 'toast'
  };

  for (const [key, id] of Object.entries(elementMap)) {
    const el = document.getElementById(id);
    if (el) {
      elements[key] = el;
    } else if (DEBUG) {
      console.warn(`Missing: ${id}`);
    }
  }

  elements.modeBtns = document.querySelectorAll('.mode-btn');
}

/**
 * Track form editing with debounce to prevent race conditions
 */
function trackFormEditing() {
  const formFields = [elements.pType, elements.pHost, elements.pPort, elements.pUser, elements.pPass].filter(Boolean);

  const onFieldChange = () => {
    formState.isEditing = true;
    formState.lastEditTime = Date.now();

    // Clear previous timeout
    if (formState.editTimeout) {
      clearTimeout(formState.editTimeout);
      activeTimeouts.delete(formState.editTimeout);
    }

    // Debounce: mark editing as done after 1 second of inactivity
    formState.editTimeout = setTimeout(() => {
      formState.isEditing = false;
      activeTimeouts.delete(formState.editTimeout);
      formState.editTimeout = null;
    }, 1000);

    activeTimeouts.add(formState.editTimeout);
  };

  formFields.forEach(field => {
    if (field) {
      field.addEventListener('input', onFieldChange);
      field.addEventListener('change', onFieldChange);
      field.addEventListener('focus', onFieldChange);
    }
  });
}

function canAction(actionName) {
  const now = Date.now();
  const lastTime = lastActionTime[actionName] ?? 0;

  if (now - lastTime < MIN_ACTION_INTERVAL) {
    return false;
  }

  lastActionTime[actionName] = now;
  return true;
}

// ============================================================================
// UI UPDATE FUNCTIONS
// ============================================================================

function updateConnectionStatus(status) {
  if (!status) {
    if (elements.statusLabel) elements.statusLabel.textContent = 'Offline';
    if (elements.statusDot) elements.statusDot.className = 'dot off';
    if (elements.statusSub) elements.statusSub.textContent = 'Extension not responding';
    return;
  }

  if (status.mode === 'tor') {
    if (elements.statusDot) elements.statusDot.className = 'dot on';
    if (elements.statusLabel) elements.statusLabel.textContent = 'TOR Active';
    if (elements.statusSub) {
      elements.statusSub.textContent = status.connectionStatus?.ip
        ? `Exit: ${status.connectionStatus.ip}`
        : 'Routing via TOR network';
    }
  } else if (status.mode === 'custom' && status.customProxy?.enabled) {
    if (elements.statusDot) elements.statusDot.className = 'dot on';
    if (elements.statusLabel) {
      const type = status.customProxy.type ?? 'SOCKS5';
      elements.statusLabel.textContent = `${type.toUpperCase()} Proxy`;
    }
    if (elements.statusSub) {
      elements.statusSub.textContent = `${status.customProxy.host ?? 'unknown'}:${status.customProxy.port ?? 0}`;
    }
  } else {
    if (elements.statusDot) elements.statusDot.className = 'dot off';
    if (elements.statusLabel) elements.statusLabel.textContent = 'Direct Connection';
    if (elements.statusSub) elements.statusSub.textContent = 'No proxy (Clearnet)';
  }
}

function updateMetrics(status) {
  if (!status?.metrics) return;

  const metrics = status.metrics;
  if (elements.mTotal) elements.mTotal.textContent = (metrics.total ?? 0).toLocaleString();
  if (elements.mSuccess) elements.mSuccess.textContent = metrics.successRate ?? '100%';
  if (elements.mLatency) elements.mLatency.textContent = metrics.avgLatency ?? '0ms';
}

function updateModeButtons(status) {
  if (!status || !elements.modeBtns?.length) return;

  elements.modeBtns.forEach(btn => {
    const mode = btn?.dataset?.mode;
    if (!mode) return;

    if (mode === status.mode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  const modeNames = { clearnet: 'DIRECT', tor: 'TOR ACTIVE', custom: 'PROXY ACTIVE' };
  if (elements.modeIndicator) {
    elements.modeIndicator.textContent = modeNames[status.mode] ?? 'UNKNOWN';
  }
}

/**
 * Update proxy panel with form state isolation:
 * - Never update form while user is editing
 * - Validate all customProxy fields before update
 * - Safe null/undefined coercion
 */
function updateProxyPanel(status) {
  if (!status || !elements.proxyPanel) return;

  if (status.mode === 'custom') {
    elements.proxyPanel.classList.remove('hidden');

    // Only update form if not being edited
    if (!formState.isEditing && status.customProxy) {
      const proxy = status.customProxy;

      // Validate all required fields exist before update
      if (!proxy.type || !proxy.host || proxy.port === undefined) {
        console.warn('Invalid proxy config:', proxy);
        return;
      }

      const safeType = String(proxy.type).toLowerCase();
      const safeHost = String(proxy.host);
      const safePort = String(proxy.port);

      // Update only if changed (prevent unnecessary reflows)
      if (elements.pType && elements.pType.value !== safeType) {
        elements.pType.value = safeType;
      }

      if (elements.pHost && elements.pHost.value !== safeHost) {
        elements.pHost.value = safeHost;
      }

      if (elements.pPort && elements.pPort.value !== safePort) {
        elements.pPort.value = safePort;
      }

      // Update auth indicators safely
      if (elements.pUser) {
        elements.pUser.placeholder = proxy.hasAuth ? '✓ Saved' : 'Username';
      }

      if (elements.pPass) {
        elements.pPass.placeholder = proxy.hasAuth ? '•••••• (saved)' : 'Password';
      }
    }
  } else {
    elements.proxyPanel.classList.add('hidden');
  }
}

// ============================================================================
// MAIN UPDATE FUNCTION (Atomic token validation)
// ============================================================================

async function updateUI() {
  if (updateInProgress) {
    // Queue this update to run after current one completes
    pendingUpdateToken = ++updateToken;
    return;
  }

  // Increment token BEFORE network call (atomic)
  const myToken = ++updateToken;
  updateInProgress = true;

  const timeoutId = setTimeout(() => {
    updateInProgress = false;
    activeTimeouts.delete(timeoutId);

    // If a newer update was queued, run it now
    if (pendingUpdateToken !== null && pendingUpdateToken > myToken) {
      pendingUpdateToken = null;
      updateUI();
    }
  }, 5000);

  activeTimeouts.add(timeoutId);

  try {
    const status = await sendMessage('getStatus');

    // CRITICAL: Validate token BEFORE any UI updates
    // If a newer update has started, discard this response
    if (myToken !== updateToken) {
      if (DEBUG) console.log(`Stale update discarded (token: ${myToken}, current: ${updateToken})`);
      return;
    }

    if (!status || status.ok === false) {
      updateConnectionStatus(null);
      return;
    }

    currentStatus = status;
    currentMode = status.mode;

    // Batch all UI updates atomically
    updateConnectionStatus(status);
    updateMetrics(status);
    updateModeButtons(status);
    updateProxyPanel(status);
  } catch (err) {
    console.error('updateUI error:', err);
    updateConnectionStatus(null);
  } finally {
    clearTimeout(timeoutId);
    activeTimeouts.delete(timeoutId);
    updateInProgress = false;

    // Check if another update was queued while we were running
    if (pendingUpdateToken !== null && pendingUpdateToken > myToken) {
      pendingUpdateToken = null;
      queueMicrotask(() => {
        updateUI();
      });
    }
  }
}

// ============================================================================
// EVENT HANDLERS (WITH ERROR BOUNDARIES)
// ============================================================================

function handleRuntimeMessage(msg, sender, sendResponse) {
  try {
    if (
      msg?.event === 'statusChanged' ||
      msg?.event === 'proxyChanged' ||
      msg?.event === 'torChanged' ||
      msg?.event === 'adBlockToggled'
    ) {
      // Cancel previous debounce
      if (statusUpdateTimeout) {
        clearTimeout(statusUpdateTimeout);
        activeTimeouts.delete(statusUpdateTimeout);
      }

      const timeoutId = setTimeout(() => {
        activeTimeouts.delete(timeoutId);
        statusUpdateTimeout = null;
        updateUI();
      }, 50);

      statusUpdateTimeout = timeoutId;
      activeTimeouts.add(timeoutId);
    }

    sendResponse({ received: true });
  } catch (err) {
    console.error('handleRuntimeMessage error:', err);
    try {
      sendResponse({ error: err.message });
    } catch (e) {
      // Ignore response errors
    }
  }

  return true;
}

function setupEventSubscription() {
  if (listenersAttached) return;

  try {
    api.runtime.onMessage.addListener(handleRuntimeMessage);
    listenersAttached = true;
  } catch (err) {
    console.error('Failed to attach runtime listener:', err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    updateUI();
  }
});

// ============================================================================
// CLEANUP
// ============================================================================

window.addEventListener('unload', () => {
  try {
    if (api?.runtime?.onMessage?.removeListener) {
      api.runtime.onMessage.removeListener(handleRuntimeMessage);
    }
    listenersAttached = false;

    if (statusUpdateTimeout) clearTimeout(statusUpdateTimeout);
    if (toastTimeout) clearTimeout(toastTimeout);
    if (formState.editTimeout) clearTimeout(formState.editTimeout);

    // Clear all tracked timeouts
    activeTimeouts.forEach(id => clearTimeout(id));
    activeTimeouts.clear();

    pendingRequests.clear();
    currentStatus = null;
  } catch (e) {
    // Ignore
  }
});

// ============================================================================
// MESSAGE API (Promise safety + cross-browser compatibility)
// ============================================================================

/**
 * Send message with:
 * - Promise deduplication (share inflight requests)
 * - Proper timeout handling (never double-fire)
 * - Cross-browser compatibility (Firefox + Chrome)
 * - Explicit finished flag to prevent race conditions
 */
function sendMessage(action, data = {}) {
  const requestId = `${action}:${JSON.stringify(data)}`;

  // If this request is already in flight, return the same promise
  if (pendingRequests.has(requestId)) {
    return pendingRequests.get(requestId);
  }

  // Create new promise
  const promise = new Promise((resolve) => {
    let finished = false;

    const timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        pendingRequests.delete(requestId);
        activeTimeouts.delete(timeoutId);
        resolve({ ok: false, error: 'Timeout', timeout: true });
      }
    }, 5000);

    activeTimeouts.add(timeoutId);

    try {
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
        // Firefox / WebExtensions API
        browser.runtime.sendMessage({ action, ...data })
          .then(res => {
            if (!finished) {
              finished = true;
              clearTimeout(timeoutId);
              activeTimeouts.delete(timeoutId);
              pendingRequests.delete(requestId);
              resolve(res ?? { ok: false });
            }
          })
          .catch(err => {
            if (!finished) {
              finished = true;
              clearTimeout(timeoutId);
              activeTimeouts.delete(timeoutId);
              pendingRequests.delete(requestId);
              resolve({ ok: false, error: err?.message ?? String(err) });
            }
          });
      } else if (typeof chrome !== 'undefined' && chrome.runtime) {
        // Chrome universal callback (MV2 & MV3 compatible)
        chrome.runtime.sendMessage({ action, ...data }, (response) => {
          if (!finished) {
            finished = true;
            clearTimeout(timeoutId);
            activeTimeouts.delete(timeoutId);
            pendingRequests.delete(requestId);

            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(response ?? { ok: false });
            }
          }
        });
      } else {
        throw new Error('No runtime API available');
      }
    } catch (err) {
      if (!finished) {
        finished = true;
        clearTimeout(timeoutId);
        activeTimeouts.delete(timeoutId);
        pendingRequests.delete(requestId);
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    }
  });

  // Store promise for deduplication
  pendingRequests.set(requestId, promise);

  return promise;
}

function showToast(message, isError = false) {
  if (!elements.toast) return;

  try {
    if (toastTimeout) {
      clearTimeout(toastTimeout);
      activeTimeouts.delete(toastTimeout);
    }

    elements.toast.textContent = message;
    elements.toast.className = `toast ${isError ? 'err' : 'ok'} show`;

    toastTimeout = setTimeout(() => {
      try {
        if (elements.toast) {
          elements.toast.classList.remove('show');
        }
      } catch (e) {
        // DOM may be gone
      }
      activeTimeouts.delete(toastTimeout);
      toastTimeout = null;
    }, 2500);

    activeTimeouts.add(toastTimeout);
  } catch (err) {
    console.error('showToast error:', err);
  }
}

// ============================================================================
// ACTIONS
// ============================================================================

async function setMode(mode) {
  if (!['clearnet', 'tor', 'custom'].includes(mode)) {
    showToast('Invalid mode', true);
    return;
  }

  if (!canAction('setMode')) {
    return;
  }

  try {
    const response = await sendMessage('setMode', { mode });
    if (response?.ok) {
      showToast(`✓ ${mode.toUpperCase()}`);
      await updateUI();
    } else {
      showToast(`Failed: ${response?.error ?? 'Unknown'}`, true);
    }
  } catch (err) {
    console.error('setMode error:', err);
    showToast('Error setting mode', true);
  }
}

/**
 * Save proxy with comprehensive validation and form state isolation
 */
async function saveProxy() {
  if (!elements.pHost || !elements.pPort) {
    showToast('Form not ready', true);
    return;
  }

  if (!canAction('saveProxy')) {
    showToast('Wait before retry', true);
    return;
  }

  try {
    const host = (elements.pHost.value ?? '').trim();
    const portStr = (elements.pPort.value ?? '').trim();
    const port = parseInt(portStr, 10);

    if (!host) {
      showToast('Host required', true);
      return;
    }

    if (!portStr || isNaN(port) || port < 1 || port > 65535) {
      showToast('Invalid port (1-65535)', true);
      return;
    }

    const config = {
      type: (elements.pType?.value ?? 'socks5').toLowerCase(),
      host: host,
      port: port,
      username: (elements.pUser?.value ?? '').trim(),
      password: elements.pPass?.value ?? ''
    };

    const response = await sendMessage('setCustomProxy', { config });
    if (response?.ok) {
      showToast('✓ Proxy saved');

      // Clear sensitive field only, keep host/port for user reference
      if (elements.pPass) {
        elements.pPass.value = '';
      }

      await setMode('custom');
    } else {
      showToast(`Failed: ${response?.error ?? 'Unknown'}`, true);
    }
  } catch (err) {
    console.error('saveProxy error:', err);
    showToast('Error saving proxy', true);
  }
}

async function disableProxy() {
  if (!canAction('disableProxy')) {
    showToast('Wait before retry', true);
    return;
  }

  try {
    const response = await sendMessage('disableCustomProxy');
    if (response?.ok) {
      showToast('✓ Proxy disabled');
      await setMode('clearnet');
    } else {
      showToast(`Failed: ${response?.error ?? 'Unknown'}`, true);
    }
  } catch (err) {
    console.error('disableProxy error:', err);
    showToast('Error disabling proxy', true);
  }
}

async function toggleAdBlock() {
  try {
    const newState = !adblockEnabled;
    const response = await sendMessage('toggleAdBlock', { enabled: newState });

    if (response?.ok && elements.adblockToggle) {
      adblockEnabled = newState;

      if (adblockEnabled) {
        elements.adblockToggle.classList.add('active');
        showToast('✓ Ad blocking ON');
      } else {
        elements.adblockToggle.classList.remove('active');
        showToast('✓ Ad blocking OFF');
      }
    } else {
      showToast(`Failed: ${response?.error ?? 'Unknown'}`, true);
    }
  } catch (err) {
    console.error('toggleAdBlock error:', err);
    showToast('Error toggling ad block', true);
  }
}

async function getAdBlockStatus() {
  try {
    const response = await sendMessage('getAdBlockStatus');
    if (response?.enabled !== undefined) {
      adblockEnabled = response.enabled;
      if (elements.adblockToggle) {
        if (adblockEnabled) {
          elements.adblockToggle.classList.add('active');
        } else {
          elements.adblockToggle.classList.remove('active');
        }
      }
    }
  } catch (err) {
    console.error('getAdBlockStatus error:', err);
  }
}

async function testConnection() {
  if (isTestingProxy) {
    showToast('Test already running', true);
    return;
  }

  if (!canAction('testConnection')) {
    showToast('Wait before retry', true);
    return;
  }

  isTestingProxy = true;

  if (elements.testBtn) {
    elements.testBtn.disabled = true;
    elements.testBtn.textContent = '⏳ Testing...';
  }

  try {
    const response = await sendMessage('testProxy');
    if (response?.ok) {
      showToast(`✅ ${response.ip ?? 'Connected'}`);
      await updateUI();
    } else {
      showToast(`❌ ${response?.error ?? 'Failed'}`, true);
    }
  } catch (err) {
    console.error('testConnection error:', err);
    showToast('❌ Test failed', true);
  } finally {
    isTestingProxy = false;

    if (elements.testBtn) {
      elements.testBtn.disabled = false;
      elements.testBtn.textContent = '🧪 Test';
    }
  }
}

function openDashboard() {
  showToast('📊 DevTools (F12)');
  sendMessage('openDashboard').catch(err => {
    console.error('openDashboard error:', err);
  });
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function bindEvents() {
  if (elements.modeBtns?.length) {
    elements.modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn?.dataset?.mode;
        if (mode) setMode(mode);
      });
    });
  }

  if (elements.saveProxyBtn) {
    elements.saveProxyBtn.addEventListener('click', saveProxy);
  }

  if (elements.disableProxyBtn) {
    elements.disableProxyBtn.addEventListener('click', disableProxy);
  }

  if (elements.testBtn) {
    elements.testBtn.addEventListener('click', testConnection);
  }

  if (elements.adblockToggle) {
    elements.adblockToggle.addEventListener('click', toggleAdBlock);
  }

  if (elements.openDashboard) {
    elements.openDashboard.addEventListener('click', (e) => {
      e.preventDefault();
      openDashboard();
    });
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  try {
    if (DEBUG) console.log('🚀 ShadowCore v5.0.0 starting...');

    cacheElements();
    bindEvents();
    trackFormEditing();
    setupEventSubscription();

    await updateUI();
    await getAdBlockStatus();

    if (DEBUG) console.log('✅ Ready');
  } catch (err) {
    console.error('Initialization error:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
