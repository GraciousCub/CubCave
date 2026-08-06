/* The Cub Cave — app shell logic (Phase 1).
 *
 * Scope for this phase: register the service worker, switch between the four
 * list panels, and report online/installed state. Entry data, Drive sync,
 * push and recommendations all land in later phases.
 */

'use strict';

/* ---------- service worker ---------- */

if ('serviceWorker' in navigator) {
  // Relative path so the app works both at a domain root and under a GitHub
  // Pages project subpath (username.github.io/repo-name/).
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  });
}

/* ---------- tabs ---------- */

var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));

function selectTab(name) {
  tabs.forEach(function (tab) {
    var active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.panel').forEach(function (panel) {
    panel.hidden = panel.id !== 'panel-' + name;
  });

  try {
    localStorage.setItem('cubcave.tab', name);
  } catch (err) {
    /* Private mode or blocked storage — remembering the tab is optional. */
  }
}

tabs.forEach(function (tab) {
  tab.addEventListener('click', function () {
    selectTab(tab.dataset.tab);
  });
});

var savedTab = null;
try {
  savedTab = localStorage.getItem('cubcave.tab');
} catch (err) { /* ignore */ }

if (savedTab && document.getElementById('panel-' + savedTab)) {
  selectTab(savedTab);
}

/* ---------- empty states ---------- */

// Phase 1 has no entries, so every list is empty. Phase 2 replaces this with
// a real render pass driven by the entry data.
function refreshEmptyStates() {
  document.querySelectorAll('.entry-list').forEach(function (list) {
    var name = list.dataset.list;
    var count = list.children.length;
    var empty = document.querySelector('[data-empty="' + name + '"]');
    var badge = document.querySelector('[data-count="' + name + '"]');
    if (empty) empty.hidden = count > 0;
    if (badge) badge.textContent = String(count);
  });
}

refreshEmptyStates();

/* ---------- placeholder actions ---------- */

document.getElementById('add-entry-btn').addEventListener('click', function () {
  toast('Adding entries arrives in Phase 2.');
});

/* ---------- online / installed state ---------- */

var statusBar = document.querySelector('.status-bar');
var netLabel = document.getElementById('net-label');

function refreshNetState() {
  var online = navigator.onLine;
  statusBar.classList.toggle('is-offline', !online);
  netLabel.textContent = online ? 'Online' : 'Offline';
}

window.addEventListener('online', refreshNetState);
window.addEventListener('offline', refreshNetState);
refreshNetState();

// Standalone detection: matchMedia covers Android/desktop, navigator.standalone
// is the iOS Safari equivalent. Phase 4 needs this, because iOS only allows
// web push once the app has been added to the home screen.
var isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

document.getElementById('install-label').textContent =
  isStandalone ? 'Installed' : 'Browser tab';

/* ---------- toast ---------- */

var toastEl = document.getElementById('toast');
var toastTimer = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toastEl.hidden = true;
  }, 2600);
}
