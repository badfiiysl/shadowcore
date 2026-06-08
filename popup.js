// ShadowCore Popup UI - v5.1.0 (PRODUCTION HARDENED)
// Fixes: Token race elimination, promise dedup stability, safe timeout wrapper,
// throttled updates, form editing precision, metrics reset, cross-browser cleanup
// ============================================================================

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let currentMode = 'clearnet';
let currentStatus = null;
let adblockEnabled = true;

// Update coordination (finally-only, no timeout-based unlocking)
let updateInProgress = false;
let updateQueued = false; // Simple boolean: update is pending
const updateQueue = []; // Store token if needed for debugging

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
let uiScheduled = false; // Throttle UI updates

// Form state isolation (input/change only, not focus)
const formState = {
  isEditing: false,
  editTimeout: null
};

// Promise deduplication (skip for sensitive actions)
const pendingRequests = new Map();
const SENSITIVE_ACTIONS = new Set(['setCustomProxy', 'toggleAdBlock']);

// API
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DEBUG = false;

// DOM Elements
const elements = {};

// ============================================================================
// LOGGER (Structured, debug-aware)
// ============================================================================

const logger = {
  log: (level, msg, data) => {
    if (!DEBUG) return;
    const timestamp = new Date().toISOString().slice(11, -1);
    const prefix = `[${timestamp}] [${level}]`;
    if (data) {
      console.log(`${prefix} ${msg}`, data);
    } else {
      console.log(`${prefix} ${msg}`);
    }
  },
  info: (msg, data) => logger.log('INFO', msg, data),
  warn: (msg, data) => logger.log('WARN', msg, data),
  error: (msg, data) => logger.log('ERROR', msg, data),
  debug: (msg, data) => logger.log('DEBUG', msg, data)
};

// ============================================================================
// SAFE TIMEOUT WRAPPER (Prevents stale callbacks)
// ============================================================================

/**
 * Wraps setTimeout with cleanup to prevent stale callbacks.
 * Callback is skipped if timeout is cleared before firing.
 */
function safeTimeout(fn, delay) {
  let fired = false;
  const id = setTimeout(() => {
    if (!fired) {
      fired = true;
      activeTimeouts.delete(id);
      try {
        fn();
      } catch (err) {
        logger.error('safeTimeout callback error', err);
      }
    }
  }, delay);

  activeTimeouts.add(id);
  return id;
}

/**
 * Clear a safe timeout and prevent callback execution.
 */
function clearSafeTimeout(id) {
  if (id) {
    clearTimeout(id);
    activeTimeouts.delete(id);
  }
}

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
      logger.warn(`Missing DOM element: ${id}`);
    }
  }

  elements.modeBtns = document.querySelectorAll('.mode-btn');
}

/**
 * Track form editing with debounce (input/change only, not focus).
 * Prevents programmatic updates from being blocked unnecessarily.
 */
function trackFormEditing() {
  const formFields = [elements.pType, elements.pHost, elements.pPort, elements.pUser, elements.pPass].filter(Boolean);

  const onFieldChange = () => {
    formState.isEditing = true;

    clearSafeTimeout(formState.editTimeout);

    // Debounce: mark editing as done after 1 second of inactivity
    formState.editTimeout = safeTimeout(() => {
      formState.isEditing = false;
      formState.editTimeout = null;
      logger.debug('Form edit timeout - marking as not editing');
    }, 1000);
  };

  formFields.forEach(field => {
    if (field) {
      // Only input/change, not focus (prevents aggressive blocking)
      field.addEventListener('input', onFieldChange);
      field.addEventListener('change', onFieldChange);
    }
  });

  logger.debug('Form editing tracking initialized');
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
    
    // FIX: Also reset metrics when offline
    updateMetrics(null);
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

/**
 * FIXED: Clear metrics if no data, don't silently ignore or stale-display.
 */
function updateMetrics(status) {
  if (!status?.metrics) {
    // Clear old metrics to prevent stale display
    if (elements.mTotal) elements.mTotal.textContent = '0';
    if (elements.mSuccess) elements.mSuccess.textContent = '0%';
    if (elements.mLatency) elements.mLatency.textContent = '0ms';
    return;
  }

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
        logger.warn('Invalid proxy config', proxy);
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
// MAIN UPDATE FUNCTION (Fixed token race, finally-only unlock)
// ============================================================================

/**
 * FIXED: Token system with no timeout-based unlocking.
 * Relies entirely on finally block for clean unlock.
 */
async function updateUI() {
  if (updateInProgress) {
    updateQueued = true;
    logger.debug('Update queued (one already in progress)');
    return;
  }

  // Increment token before network call (atomic)
  const myToken = ++updateQueue[0] ?? (updateQueue[0] = 0);
  updateInProgress = true;
  updateQueued = false;

  logger.debug(`Update started (token: ${myToken})`);

  try {
    const status = await sendMessage('getStatus');

    // CRITICAL: Validate token BEFORE any UI updates
    if (myToken !== updateQueue[0]) {
      logger.debug(`Stale update discarded (token: ${myToken}, current: ${updateQueue[0]})`);
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

    logger.debug('UI updated successfully');
  } catch (err) {
    logger.error('updateUI error', err);
    updateConnectionStatus(null);
  } finally {
    // FIXED: No timeout-based unlocking. Only finally unlocks.
    updateInProgress = false;

    // If another update was queued, schedule it
    if (updateQueued) {
      updateQueued = false;
      logger.debug('Scheduled queued update');
      scheduleUpdateUI();
    }
  }
}

/**
 * FIXED: Throttle UI updates to prevent re-entrancy loops.
 * Only one update can be scheduled at a time.
 */
function scheduleUpdateUI() {
  if (uiScheduled) {
    logger.debug('Update already scheduled');
    return;
  }

  uiScheduled = true;

  queueMicrotask(async () => {
    uiScheduled = false;
    await updateUI();
  });
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
      logger.debug(`Runtime event: ${msg.event}`);

      // Cancel previous debounce
      clearSafeTimeout(statusUpdateTimeout);

      statusUpdateTimeout = safeTimeout(() => {
        statusUpdateTimeout = null;
        scheduleUpdateUI();
      }, 50);
    }

    sendResponse({ received: true });
  } catch (err) {
    logger.error('handleRuntimeMessage error', err);
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
    logger.debug('Runtime message listener attached');
  } catch (err) {
    logger.error('Failed to attach runtime listener', err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    logger.debug('Popup became visible, updating UI');
    scheduleUpdateUI();
  }
});

// ============================================================================
// CLEANUP
// ============================================================================

function cleanup() {
  try {
    if (api?.runtime?.onMessage?.removeListener) {
      api.runtime.onMessage.removeListener(handleRuntimeMessage);
    }
    listenersAttached = false;

    clearSafeTimeout(statusUpdateTimeout);
    clearSafeTimeout(toastTimeout);
    clearSafeTimeout(formState.editTimeout);

    // Clear all tracked timeouts
    activeTimeouts.forEach(id => clearTimeout(id));
    activeTimeouts.clear();

    pendingRequests.clear();
    currentStatus = null;

    logger.info('Cleanup complete');
  } catch (e) {
    logger.error('Cleanup error', e);
  }
}

window.addEventListener('unload', cleanup);

// FIXED: Also handle pagehide for Firefox reliability
window.addEventListener('pagehide', cleanup);

// ============================================================================
// MESSAGE API (Promise dedup with sensitive action skip)
// ============================================================================

/**
 * Generate stable request ID, skipping for sensitive actions.
 */
function getRequestId(action, data) {
  // Skip dedup for sensitive actions (password, auth, toggles)
  if (SENSITIVE_ACTIONS.has(action)) {
    return null;
  }

  // Stable key: sort data entries to avoid key-order instability
  const sortedEntries = Object.entries(data).sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  return `${action}:${JSON.stringify(sortedEntries)}`;
}

/**
 * Send message with:
 * - Promise deduplication (skip for sensitive actions)
 * - Cross-browser compatibility (Firefox + Chrome)
 * - Explicit finished flag to prevent double-fire
 */
function sendMessage(action, data = {}) {
  const requestId = getRequestId(action, data);

  // If this request is already in flight, return the same promise
  if (requestId && pendingRequests.has(requestId)) {
    logger.debug(`Request dedup hit: ${action}`);
    return pendingRequests.get(requestId);
  }

  // Create new promise
  const promise = new Promise((resolve) => {
    let finished = false;

    const timeoutId = safeTimeout(() => {
      if (!finished) {
        finished = true;
        if (requestId) pendingRequests.delete(requestId);
        logger.warn(`Request timeout: ${action}`);
        resolve({ ok: false, error: 'Timeout', timeout: true });
      }
    }, 5000);

    try {
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
        // Firefox / WebExtensions API
        browser.runtime.sendMessage({ action, ...data })
          .then(res => {
            if (!finished) {
              finished = true;
              clearSafeTimeout(timeoutId);
              if (requestId) pendingRequests.delete(requestId);
              logger.debug(`Response received: ${action}`, res);
              resolve(res ?? { ok: false });
            }
          })
          .catch(err => {
            if (!finished) {
              finished = true;
              clearSafeTimeout(timeoutId);
              if (requestId) pendingRequests.delete(requestId);
              logger.error(`Promise error: ${action}`, err);
              resolve({ ok: false, error: err?.message ?? String(err) });
            }
          });
      } else if (typeof chrome !== 'undefined' && chrome.runtime) {
        // Chrome universal callback (MV2 & MV3 compatible)
        chrome.runtime.sendMessage({ action, ...data }, (response) => {
          if (!finished) {
            finished = true;
            clearSafeTimeout(timeoutId);
            if (requestId) pendingRequests.delete(requestId);

            if (chrome.runtime.lastError) {
              logger.error(`Chrome error: ${action}`, chrome.runtime.lastError);
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              logger.debug(`Response received: ${action}`, response);
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
        clearSafeTimeout(timeoutId);
        if (requestId) pendingRequests.delete(requestId);
        logger.error(`Send error: ${action}`, err);
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    }
  });

  // Store promise for deduplication (only if requestId exists)
  if (requestId) {
    pendingRequests.set(requestId, promise);
  }

  return promise;
}

function showToast(message, isError = false) {
  if (!elements.toast) return;

  try {
    clearSafeTimeout(toastTimeout);

    elements.toast.textContent = message;
    elements.toast.className = `toast ${isError ? 'err' : 'ok'} show`;

    toastTimeout = safeTimeout(() => {
      try {
        if (elements.toast) {
          elements.toast.classList.remove('show');
        }
      } catch (e) {
        // DOM may be gone
      }
      toastTimeout = null;
    }, 2500);
  } catch (err) {
    logger.error('showToast error', err);
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
    logger.debug(`Setting mode to: ${mode}`);
    const response = await sendMessage('setMode', { mode });
    if (response?.ok) {
      showToast(`✓ ${mode.toUpperCase()}`);
      scheduleUpdateUI();
    } else {
      showToast(`Failed: ${response?.error ?? 'Unknown'}`, true);
    }
  } catch (err) {
    logger.error('setMode error', err);
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

    logger.debug('Saving proxy config', { ...config, password: '[REDACTED]' });
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
    logger.error('saveProxy error', err);
    showToast('Error saving proxy', true);
  }
}

async function disableProxy() {
  if (!canAction('disableProxy')) {
    showToast('Wait before retry', true);
    return;
  }

  try {
    logger.debug('Disabling proxy');
    const response = await sendMessage('disableCustomProxy');
    if (response?.ok) {
      showToast('✓ Proxy disabled');
      await setMode('clearnet');
    } else {
      showToast(`Failed: ${response?.error ?? 'Unknown'}`, true);
    }
  } catch (err) {
    logger.error('disableProxy error', err);
    showToast('Error disabling proxy', true);
  }
}

async function toggleAdBlock() {
  try {
    const newState = !adblockEnabled;
    logger.debug(`Toggling ad block to: ${newState}`);
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
    logger.error('toggleAdBlock error', err);
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
    logger.error('getAdBlockStatus error', err);
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
    logger.debug('Testing proxy connection');
    const response = await sendMessage('testProxy');
    if (response?.ok) {
      showToast(`✅ ${response.ip ?? 'Connected'}`);
      scheduleUpdateUI();
    } else {
      showToast(`❌ ${response?.error ?? 'Failed'}`, true);
    }
  } catch (err) {
    logger.error('testConnection error', err);
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
    logger.error('openDashboard error', err);
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

  logger.debug('Event listeners bound');
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  try {
    logger.info('🚀 ShadowCore v5.1.0 starting...');

    cacheElements();
    bindEvents();
    trackFormEditing();
    setupEventSubscription();

    scheduleUpdateUI();
    await getAdBlockStatus();

    logger.info('✅ Ready');
  } catch (err) {
    logger.error('Initialization error', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
