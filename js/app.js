/* The Cub Cave — UI layer (Phase 2).
 *
 * Reads and writes go through CubCave.store; this file only renders and
 * handles input. Phase 3 swaps the store's backend for Google Drive without
 * touching anything here.
 */

'use strict';

(function () {

var store = CubCave.store;

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

/* ---------- dates ----------
 * releaseDate is a plain calendar date ("2026-10-07") with no timezone.
 * Never feed it to new Date(string) — that parses as UTC and can land on the
 * wrong day. Always build a local date from the parts.
 */

function pad(n) { return n < 10 ? '0' + n : String(n); }

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function parseLocalDate(iso) {
  var p = iso.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function daysUntil(iso) {
  var ms = parseLocalDate(iso) - parseLocalDate(todayISO());
  return Math.round(ms / 86400000);
}

function formatDay(iso) {
  return parseLocalDate(iso).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function formatTimestamp(isoDateTime) {
  var d = new Date(isoDateTime);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Returns { text, tone } for an upcoming entry's release date.
function describeRelease(iso) {
  if (!iso) return { text: 'No date set', tone: 'warn' };
  var n = daysUntil(iso);
  if (n < 0) return { text: 'Out now · ' + formatDay(iso), tone: 'live' };
  if (n === 0) return { text: 'Out today', tone: 'live' };
  if (n === 1) return { text: 'Out tomorrow', tone: 'soon' };
  if (n <= 14) return { text: 'In ' + n + ' days · ' + formatDay(iso), tone: 'soon' };
  return { text: formatDay(iso), tone: '' };
}

/* ---------- rendering ---------- */

var LIST_LABELS = {
  reading: 'Currently reading',
  next: 'Reading next',
  upcoming: 'Upcoming',
  read: 'Read'
};

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML — entry titles are user input.
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(action, id, label, options) {
  options = options || {};
  var btn = el('button', 'entry__btn' + (options.className ? ' ' + options.className : ''),
                options.text || label);
  btn.type = 'button';
  btn.dataset.action = action;
  btn.dataset.id = id;
  btn.setAttribute('aria-label', label);
  if (options.disabled) btn.disabled = true;
  return btn;
}

function createCard(entry, index, total) {
  var li = el('li', 'entry');
  li.dataset.id = entry.id;

  var main = el('div', 'entry__main');
  main.appendChild(el('div', 'entry__title', entry.title));

  // Meta line: series, then a status-appropriate date.
  var bits = [];
  if (entry.series) bits.push(entry.series);

  var meta = el('div', 'entry__meta');
  if (bits.length) meta.appendChild(document.createTextNode(bits.join(' · ')));

  if (entry.status === 'upcoming') {
    var rel = describeRelease(entry.releaseDate);
    if (bits.length) meta.appendChild(document.createTextNode(' · '));
    var badge = el('span', 'badge' + (rel.tone ? ' badge--' + rel.tone : ''), rel.text);
    meta.appendChild(badge);
  } else if (entry.status === 'read' && entry.dateRead) {
    var stamp = 'Read ' + formatTimestamp(entry.dateRead);
    meta.appendChild(document.createTextNode((bits.length ? ' · ' : '') + stamp));
  }

  if (meta.childNodes.length) main.appendChild(meta);
  if (entry.notes) main.appendChild(el('div', 'entry__notes', entry.notes));

  li.appendChild(main);

  var actions = el('div', 'entry__actions');

  if (entry.status === 'next') {
    actions.appendChild(actionButton('up', entry.id, 'Move up',
      { text: '↑', className: 'entry__btn--icon', disabled: index === 0 }));
    actions.appendChild(actionButton('down', entry.id, 'Move down',
      { text: '↓', className: 'entry__btn--icon', disabled: index === total - 1 }));
  }

  // One-tap moves along the natural path of a comic: upcoming → queue →
  // reading → read, plus a way back out of Read.
  if (entry.status === 'upcoming') {
    actions.appendChild(actionButton('queue', entry.id, 'Move to Reading next',
      { text: '→ Queue' }));
  } else if (entry.status === 'next') {
    actions.appendChild(actionButton('start', entry.id, 'Start reading now',
      { text: '▶ Start' }));
  } else if (entry.status === 'read') {
    actions.appendChild(actionButton('unread', entry.id, 'Move back to Currently reading',
      { text: '↩ Unread' }));
  }

  if (entry.status !== 'read') {
    actions.appendChild(actionButton('read', entry.id, 'Mark as read',
      { text: '✓ Read', className: 'entry__btn--go' }));
  }

  actions.appendChild(actionButton('edit', entry.id, 'Edit ' + entry.title, { text: 'Edit' }));

  li.appendChild(actions);
  return li;
}

function render() {
  store.STATUSES.forEach(function (status) {
    var list = document.querySelector('[data-list="' + status + '"]');
    var entries = store.byStatus(status);

    list.textContent = '';
    entries.forEach(function (entry, i) {
      list.appendChild(createCard(entry, i, entries.length));
    });

    var empty = document.querySelector('[data-empty="' + status + '"]');
    if (empty) empty.hidden = entries.length > 0;

    var count = document.querySelector('[data-count="' + status + '"]');
    if (count) count.textContent = String(entries.length);
  });

  refreshReleaseNotice();
}

// A quiet heads-up on the Upcoming tab when something has already dropped —
// the daily push (Phase 5) covers the phone, this covers opening the app.
function refreshReleaseNotice() {
  var due = store.byStatus('upcoming').filter(function (e) {
    return e.releaseDate && daysUntil(e.releaseDate) <= 0;
  });
  var sub = document.getElementById('shell-status');
  sub.textContent = due.length
    ? due.length + (due.length === 1 ? ' issue is out now' : ' issues are out now')
    : 'Comic reading tracker';
  sub.classList.toggle('app-bar__sub--live', due.length > 0);
}

/* ---------- entry actions ---------- */

document.querySelector('.content').addEventListener('click', function (event) {
  var btn = event.target.closest('[data-action]');
  if (!btn) return;

  var id = btn.dataset.id;
  var entry = store.find(id);
  if (!entry) return;

  switch (btn.dataset.action) {
    case 'up':
      store.moveInQueue(id, 'up');
      break;
    case 'down':
      store.moveInQueue(id, 'down');
      break;
    case 'read':
      store.markRead(id);
      toast('Moved “' + entry.title + '” to Read.');
      break;
    case 'queue':
      store.update(id, { status: 'next' });
      toast('Added to the queue.');
      break;
    case 'start':
      store.update(id, { status: 'reading' });
      toast('Now reading “' + entry.title + '”.');
      break;
    case 'unread':
      // update() clears dateRead on the way out of Read, so the entry doesn't
      // keep a stale "finished on" stamp.
      store.update(id, { status: 'reading' });
      toast('Moved back to Currently reading.');
      break;
    case 'edit':
      openForm(entry);
      break;
  }
});

/* ---------- add / edit form ---------- */

var dialog = document.getElementById('entry-dialog');
var form = document.getElementById('entry-form');
var fTitle = document.getElementById('f-title');
var fSeries = document.getElementById('f-series');
var fStatus = document.getElementById('f-status');
var fRelease = document.getElementById('f-release');
var fReleaseField = document.getElementById('f-release-field');
var fNotes = document.getElementById('f-notes');
var formError = document.getElementById('form-error');
var deleteBtn = document.getElementById('delete-btn');
var dialogTitle = document.getElementById('dialog-title');

var editingId = null;

// The release date only means anything for Upcoming, so only show it there.
// The stored value survives while hidden, so toggling status doesn't lose it.
function syncReleaseVisibility() {
  fReleaseField.hidden = fStatus.value !== 'upcoming';
}

fStatus.addEventListener('change', syncReleaseVisibility);

function openForm(entry) {
  editingId = entry ? entry.id : null;
  formError.hidden = true;
  disarmDelete();

  dialogTitle.textContent = entry ? 'Edit issue' : 'Add an issue';
  deleteBtn.hidden = !entry;

  fTitle.value = entry ? entry.title : '';
  fSeries.value = entry ? entry.series : '';
  fNotes.value = entry ? entry.notes : '';
  fRelease.value = entry && entry.releaseDate ? entry.releaseDate : '';
  fStatus.value = entry ? entry.status : currentTab();

  syncReleaseVisibility();
  dialog.showModal();

  // Don't autofocus on touch — it yanks the keyboard up over the sheet.
  if (!window.matchMedia('(pointer: coarse)').matches) fTitle.focus();
}

form.addEventListener('submit', function (event) {
  event.preventDefault();

  var title = fTitle.value.trim();
  if (!title) {
    formError.textContent = 'Give the issue a title.';
    formError.hidden = false;
    fTitle.focus();
    return;
  }

  var fields = {
    title: title,
    series: fSeries.value.trim(),
    status: fStatus.value,
    releaseDate: fRelease.value || null,
    notes: fNotes.value.trim()
  };

  if (editingId) {
    store.update(editingId, fields);
    toast('Saved.');
  } else {
    store.add(fields);
    toast('Added to ' + LIST_LABELS[fields.status] + '.');
    // Follow the entry to wherever it landed.
    selectTab(fields.status);
  }

  dialog.close();
});

/* Delete is a two-step button rather than a native confirm().
 *
 * window.confirm() silently returns false once a browser decides to suppress
 * page dialogs (Chrome's "prevent additional dialogs" tick-box), and it is
 * unreliable over a modal <dialog> in an installed PWA. That made Delete look
 * broken: the click registered, the confirm never appeared, nothing happened.
 * Arming the button keeps the safety step but relies only on our own UI. */

var deleteArmed = false;
var deleteTimer = null;

function disarmDelete() {
  deleteArmed = false;
  clearTimeout(deleteTimer);
  deleteBtn.textContent = 'Delete';
  deleteBtn.classList.remove('btn--armed');
}

deleteBtn.addEventListener('click', function () {
  var entry = store.find(editingId);
  if (!entry) return;

  if (!deleteArmed) {
    deleteArmed = true;
    deleteBtn.textContent = 'Tap again to delete';
    deleteBtn.classList.add('btn--armed');
    // Don't leave it armed indefinitely.
    deleteTimer = setTimeout(disarmDelete, 5000);
    return;
  }

  disarmDelete();
  store.remove(editingId);
  dialog.close();
  toast('Deleted “' + entry.title + '”.');
});

document.getElementById('cancel-btn').addEventListener('click', function () {
  dialog.close();
});

document.getElementById('add-entry-btn').addEventListener('click', function () {
  openForm(null);
});

/* ---------- tabs ---------- */

var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));

function currentTab() {
  var active = document.querySelector('.tab.is-active');
  return active ? active.dataset.tab : 'reading';
}

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
  tab.addEventListener('click', function () { selectTab(tab.dataset.tab); });
});

/* ---------- notifications ---------- */

var pushCard = document.getElementById('push-card');
var pushTitle = document.getElementById('push-title');
var pushText = document.getElementById('push-text');
var pushBtn = document.getElementById('push-btn');
var pushTestBtn = document.getElementById('push-test-btn');

// Each state says plainly what's true and what to do about it. "Denied" in
// particular has to explain itself, because the page can never re-prompt —
// only the browser's own settings can undo it.
var PUSH_COPY = {
  'ios-needs-install': {
    text: 'On iPhone and iPad, notifications only work once the app is added ' +
          'to the Home Screen. Tap Share, then "Add to Home Screen", and open ' +
          'it from there.',
    button: null
  },
  unsupported: {
    text: 'This browser can\'t do web notifications. The list above still ' +
          'shows what\'s out.',
    button: null
  },
  unconfigured: {
    text: 'Not set up yet — Firebase details are still missing from ' +
          'js/config.js.',
    button: null
  },
  available: {
    text: 'Get a notification on the day an issue on this list comes out.',
    button: 'Enable'
  },
  denied: {
    text: 'Notifications are blocked for this site. The app can\'t ask again — ' +
          're-allow them in your browser\'s site settings, then reload.',
    button: null
  },
  enabled: {
    text: 'On for this device. You\'ll get an alert on release day.',
    button: null
  }
};

function renderPushCard() {
  var state = CubCave.push.state();
  var copy = PUSH_COPY[state] || PUSH_COPY.unsupported;

  pushCard.hidden = false;
  pushCard.dataset.state = state;
  pushTitle.textContent = state === 'enabled'
    ? 'Release-day notifications are on'
    : 'Release-day notifications';
  pushText.textContent = copy.text;

  pushBtn.hidden = !copy.button;
  if (copy.button) pushBtn.textContent = copy.button;

  // A local test proves permission, the service worker and the display path
  // all work — without waiting for the scheduled job to exist.
  pushTestBtn.hidden = state !== 'enabled';
}

pushBtn.addEventListener('click', function () {
  pushBtn.disabled = true;
  pushText.textContent = 'Waiting for your permission…';

  CubCave.push.enable().then(function () {
    toast('Notifications enabled.');
    renderPushCard();
  }).catch(function (err) {
    var reason = err && err.message;
    if (reason === 'dismissed') toast('Permission dismissed — tap Enable to try again.');
    else if (reason === 'denied') toast('Notifications blocked in browser settings.');
    else if (reason === 'no-token') toast('Google didn\'t return a token. Try again.');
    else toast('Could not enable notifications: ' + reason);
    renderPushCard();
  }).then(function () {
    pushBtn.disabled = false;
  });
});

pushTestBtn.addEventListener('click', function () {
  CubCave.push.sendTestNotification()
    .then(function () { toast('Test notification sent.'); })
    .catch(function (err) { toast('Test failed: ' + (err && err.message)); });
});

CubCave.push.onChange(renderPushCard);

// Also re-render when the data changes — a document pulled from Drive can
// bring a stored token with it, which changes what this card should say.
store.subscribe(renderPushCard);

/* ---------- sync status ---------- */

var statusBar = document.querySelector('.status-bar');
var syncLabel = document.getElementById('sync-label');
var authBtn = document.getElementById('auth-btn');
var notice = document.getElementById('notice');
var noticeText = document.getElementById('notice-text');
var noticeBtn = document.getElementById('notice-btn');

// While a notice is awaiting a decision, incoming sync-status updates must not
// yank it off screen mid-tap.
var noticeLocked = false;

function showNotice(text, actionLabel, action, lock) {
  noticeText.textContent = text;
  if (actionLabel) {
    noticeBtn.textContent = actionLabel;
    noticeBtn.hidden = false;
    noticeBtn.onclick = action;
  } else {
    noticeBtn.hidden = true;
    noticeBtn.onclick = null;
  }
  noticeLocked = !!lock;
  notice.hidden = false;
}

function hideNotice(force) {
  if (noticeLocked && !force) return;
  noticeLocked = false;
  notice.hidden = true;
  noticeBtn.onclick = null;
}

function renderSyncStatus(state) {
  statusBar.dataset.status = state.status;
  syncLabel.textContent = state.message || state.status;

  // The sign-in button only appears when signing in would actually help.
  var signedOut = state.status === 'signed-out';
  authBtn.hidden = !(signedOut || CubCave.drive.isSignedIn());
  authBtn.textContent = signedOut ? 'Sign in' : 'Sign out';

  if (state.status === 'unconfigured') {
    showNotice(
      'Google Drive sync is not set up yet. Add your OAuth Client ID to ' +
      'js/config.js — until then, entries are saved on this device only.'
    );
  } else if (state.status === 'error') {
    showNotice(state.message, 'Retry', function () {
      hideNotice();
      CubCave.sync.reconcile();
    });
  } else {
    hideNotice();
  }
}

authBtn.addEventListener('click', function () {
  // Tapping again while the confirmation is up cancels it.
  if (noticeLocked) {
    hideNotice(true);
    return;
  }
  if (CubCave.drive.isSignedIn()) {
    // Same reasoning as Delete: confirm in our own UI, not a native dialog.
    showNotice(
      'Sign out? Your data stays in Drive, but is cleared from this device.',
      'Sign out',
      function () {
        hideNotice(true);
        CubCave.sync.signOut();
      },
      true
    );
  } else {
    CubCave.sync.signIn();
  }
});

// Standalone detection: matchMedia covers Android/desktop, navigator.standalone
// is the iOS Safari equivalent. Phase 4 needs this, because iOS only allows
// web push once the app has been added to the home screen.
var isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

document.getElementById('install-label').hidden = !isStandalone;

/* ---------- toast ---------- */

var toastEl = document.getElementById('toast');
var toastTimer = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
}

// push.js shows a toast for messages that arrive while the app is open.
CubCave.showToast = toast;

/* ---------- boot ---------- */

store.subscribe(render);

// Paint from the local mirror first so the app is usable immediately, then
// let sync reconcile with Drive in the background.
store.load();

var savedTab = null;
try {
  savedTab = localStorage.getItem('cubcave.tab');
} catch (err) { /* ignore */ }

if (savedTab && document.getElementById('panel-' + savedTab)) selectTab(savedTab);

render();

renderPushCard();

// If notifications are already on, quietly re-check the FCM token — they
// rotate, and a stale one means alerts stop arriving with no visible symptom.
// Deferred so it never competes with first paint.
setTimeout(function () { CubCave.push.refreshIfEnabled(); }, 1500);

CubCave.sync.onStatus(renderSyncStatus);
CubCave.drive.onAuthChange(function () { renderSyncStatus(CubCave.sync.status()); });

// The Google script is async, so wait for it before starting sync.
var gisScript = document.getElementById('gis-script');
if (CubCave.drive.gisLoaded()) {
  CubCave.sync.start();
} else {
  gisScript.addEventListener('load', function () { CubCave.sync.start(); });
  gisScript.addEventListener('error', function () {
    // Offline or blocked: the app still works, backed by the local mirror.
    CubCave.sync.start();
  });
}

// Dates drift while the app sits open on a phone for days; recheck on return.
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) render();
});

// Flush any debounced write before the app is backgrounded or closed.
window.addEventListener('pagehide', function () { store.saveNow(); });

})();
