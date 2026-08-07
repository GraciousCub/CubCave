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

/* ---------- grouping by series ---------- */

// Entries with no series still need somewhere to live.
function seriesKeyOf(entry) {
  return (entry.series || '').trim() || 'Other';
}

/* Sort by issue number, not by title text — otherwise "#10" lands before
 * "#9". Falls back to the number in the title when the field is empty
 * (entries typed by hand before search existed). */
function issueNumberValue(entry) {
  var raw = entry.issueNumber;
  if (!raw) {
    var match = String(entry.title || '').match(/#\s*([0-9]+(?:\.[0-9]+)?)/);
    raw = match ? match[1] : '';
  }
  var value = parseFloat(raw);
  return isNaN(value) ? Infinity : value;
}

function sortIssues(entries) {
  return entries.slice().sort(function (a, b) {
    var diff = issueNumberValue(a) - issueNumberValue(b);
    if (diff && isFinite(diff)) return diff;
    return String(a.releaseDate || '').localeCompare(String(b.releaseDate || ''));
  });
}

function entriesInSeries(name) {
  return store.all().filter(function (e) { return seriesKeyOf(e) === name; });
}

function groupBySeries(entries) {
  var groups = {};
  var order = [];
  entries.forEach(function (entry) {
    var key = seriesKeyOf(entry);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(entry);
  });
  /* Your arranged order wins where you've set one; anything you haven't
   * arranged keeps the order the list naturally produced (soonest release,
   * most recently finished, and so on). Array.sort is stable, so those keep
   * their relative positions. */
  var manual = store.getSeriesOrder();
  order.sort(function (a, b) {
    var ia = manual.indexOf(a);
    var ib = manual.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return { groups: groups, order: order };
}

/* ---------- cover art ---------- */

function initialsOf(name) {
  return String(name || '?')
    // Drop the "(2025)" the series label carries, then anything that isn't a
    // word — otherwise "Batman (2025)" initialises to "B(".
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/^(the|a)\s+/i, '')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map(function (word) { return word.charAt(0); })
    .join('').toUpperCase() || '?';
}

// A series is represented by its earliest issue's cover.
function coverForSeries(entries) {
  var sorted = sortIssues(entries);
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].coverUrl) return sorted[i].coverUrl;
  }
  return '';
}

function artElement(coverUrl, label) {
  var art = el('div', 'tile__art');

  if (!coverUrl) {
    art.appendChild(el('div', 'tile__fallback', initialsOf(label)));
    return art;
  }

  var img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // Covers are hotlinked from the comic database; some hosts reject requests
  // carrying a referrer.
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', function () {
    // Offline, moved, or blocked — show initials rather than a broken image.
    img.remove();
    art.appendChild(el('div', 'tile__fallback', initialsOf(label)));
  });
  img.src = coverUrl;
  art.appendChild(img);
  return art;
}

/* ---------- tiles ---------- */

function statusBadge(entry) {
  if (entry.status === 'read') return { text: 'Read', tone: '' };
  if (entry.status === 'upcoming') return describeRelease(entry.releaseDate);
  if (entry.status === 'reading') return { text: 'Reading', tone: 'soon' };
  return { text: 'Queued', tone: '' };
}

function createSeriesTile(name, inThisList, allIssues, queuePosition) {
  var tile = el('div', 'tile tile--series');

  var open = el('button', 'tile__open');
  open.type = 'button';
  open.setAttribute('aria-label', 'Open ' + name);

  var art = artElement(coverForSeries(allIssues), name);

  // How many of this series are in the list you're looking at.
  art.appendChild(el('span', 'tile__count', String(inThisList.length)));
  open.appendChild(art);

  var label = el('div', 'tile__label');
  label.appendChild(el('div', 'tile__title', name));
  label.appendChild(el('div', 'tile__meta',
    allIssues.length + (allIssues.length === 1 ? ' issue tracked' : ' issues tracked')));
  open.appendChild(label);

  open.addEventListener('click', function () { openSeriesView(name); });
  tile.appendChild(open);

  // Read by the drag handler to know what it's moving.
  tile.dataset.series = name;
  return tile;
}

/* ---------- drag to reorder ----------
 *
 * Series tiles can be rearranged on any list, and the order is shared across
 * all of them.
 *
 * Touch needs care: a tile is also a button, and the list scrolls. So a drag
 * starts only after a press is HELD (350ms) without moving — a swipe scrolls
 * as normal, a tap opens the series, and a hold picks it up. With a mouse,
 * moving past a few pixels is enough, since there's nothing to scroll past.
 *
 * The dragged tile is moved in the DOM as you go, so the grid reflows and you
 * can see where it will land.
 */

var HOLD_MS = 350;
var MOVE_TOLERANCE = 10;

function enableSeriesDrag(grid) {
  var candidate = null;
  var dragging = null;
  var holdTimer = null;
  var startX = 0;
  var startY = 0;
  var suppressClick = false;

  function cancelHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
    candidate = null;
  }

  function beginDrag(tile, pointerId) {
    dragging = tile;
    candidate = null;
    tile.classList.add('is-dragging');
    grid.classList.add('is-reordering');
    try { tile.setPointerCapture(pointerId); } catch (err) { /* not fatal */ }
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function endDrag() {
    if (!dragging) return;
    dragging.classList.remove('is-dragging');
    grid.classList.remove('is-reordering');

    // Persist whatever order the DOM now shows.
    var names = Array.prototype.map.call(
      grid.querySelectorAll('.tile--series'), function (t) { return t.dataset.series; });
    var moved = dragging.dataset.series;
    var index = names.indexOf(moved);
    var before = index + 1 < names.length ? names[index + 1] : null;

    dragging = null;
    store.moveSeriesBefore(moved, before);
  }

  grid.addEventListener('pointerdown', function (event) {
    if (event.button != null && event.button !== 0) return;
    var tile = event.target.closest('.tile--series');
    if (!tile || grid.querySelectorAll('.tile--series').length < 2) return;

    candidate = tile;
    startX = event.clientX;
    startY = event.clientY;
    suppressClick = false;

    if (event.pointerType === 'touch') {
      holdTimer = setTimeout(function () {
        if (candidate) beginDrag(candidate, event.pointerId);
      }, HOLD_MS);
    }
  });

  grid.addEventListener('pointermove', function (event) {
    if (!dragging) {
      if (!candidate) return;
      var dx = Math.abs(event.clientX - startX);
      var dy = Math.abs(event.clientY - startY);

      if (event.pointerType === 'touch') {
        // Movement before the hold completes means they're scrolling.
        if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) cancelHold();
        return;
      }
      if (dx > 6 || dy > 6) beginDrag(candidate, event.pointerId);
      return;
    }

    event.preventDefault();
    suppressClick = true;

    var under = document.elementFromPoint(event.clientX, event.clientY);
    var target = under && under.closest ? under.closest('.tile--series') : null;
    if (!target || target === dragging || target.parentNode !== grid) return;

    // Insert before or after depending on which half was entered.
    var box = target.getBoundingClientRect();
    var after = (event.clientX - box.left) > box.width / 2;
    grid.insertBefore(dragging, after ? target.nextSibling : target);
  });

  function finish(event) {
    cancelHold();
    if (dragging) {
      if (event) event.preventDefault();
      endDrag();
    }
  }

  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', finish);

  // A drag ends over a tile, which would otherwise open that series.
  grid.addEventListener('click', function (event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);
}

function createIssueTile(entry) {
  var tile = el('div', 'tile tile--issue');
  tile.dataset.id = entry.id;

  var open = el('button', 'tile__open');
  open.type = 'button';
  open.setAttribute('aria-label', 'Edit ' + entry.title);

  // Fall back to the SERIES initials, not the title's — "Batman #10" would
  // otherwise initialise to "B1".
  var art = artElement(entry.coverUrl, entry.series || entry.title);
  var badge = statusBadge(entry);
  art.appendChild(el('span', 'tile__badge' + (badge.tone ? ' tile__badge--' + badge.tone : ''),
                     badge.text));
  open.appendChild(art);

  var label = el('div', 'tile__label');
  label.appendChild(el('div', 'tile__title',
    entry.issueNumber ? '#' + entry.issueNumber : entry.title));
  label.appendChild(el('div', 'tile__meta',
    entry.status === 'read'
      ? (entry.dateRead ? 'Read ' + formatTimestamp(entry.dateRead) : 'Read')
      : (entry.releaseDate ? formatDay(entry.releaseDate) : 'No date')));
  open.appendChild(label);

  open.addEventListener('click', function () { openForm(entry); });
  tile.appendChild(open);

  var actions = el('div', 'tile__actions');
  if (entry.status === 'upcoming') {
    actions.appendChild(actionButton('queue', entry.id, 'Move to Reading next', { text: '→ Queue' }));
  } else if (entry.status === 'next') {
    actions.appendChild(actionButton('start', entry.id, 'Start reading now', { text: '▶ Start' }));
  } else if (entry.status === 'read') {
    actions.appendChild(actionButton('unread', entry.id, 'Move back to Currently reading', { text: '↩ Unread' }));
  }
  if (entry.status !== 'read') {
    actions.appendChild(actionButton('read', entry.id, 'Mark as read',
      { text: '✓ Read', className: 'entry__btn--go' }));
  }
  tile.appendChild(actions);

  return tile;
}

/* ---------- views ---------- */

var openSeries = null;   // series name while the detail view is showing

var seriesView = document.getElementById('series-view');
var seriesViewTitle = document.getElementById('series-view-title');
var seriesViewMeta = document.getElementById('series-view-meta');
var seriesIssues = document.getElementById('series-issues');
var seriesReadAllBtn = document.getElementById('series-read-all-btn');
var seriesDeleteBtn = document.getElementById('series-delete-btn');
var seriesFollowBtn = document.getElementById('series-follow-btn');

// The database's id for a series, taken from any issue that was imported.
function seriesIdentity(name) {
  var withId = entriesInSeries(name).filter(function (e) { return e.seriesId; })[0];
  return withId ? { seriesId: withId.seriesId, source: withId.seriesSource || 'metron' } : null;
}

function renderFollowButton() {
  var identity = seriesIdentity(openSeries);
  var following = store.getSubscriptions().some(function (s) {
    return s.seriesName === openSeries ||
           (identity && s.seriesId === identity.seriesId);
  });

  // Nothing to follow if the series was never matched to a database entry.
  seriesFollowBtn.hidden = !identity && !following;
  seriesFollowBtn.textContent = following ? 'Following ✓' : 'Follow';
  seriesFollowBtn.classList.toggle('btn--on', following);
  seriesFollowBtn.dataset.following = following ? '1' : '';
}

seriesFollowBtn.addEventListener('click', function () {
  if (!openSeries) return;

  if (seriesFollowBtn.dataset.following) {
    store.getSubscriptions().forEach(function (sub) {
      if (sub.seriesName === openSeries) store.removeSubscription(sub.id);
    });
    toast('Stopped following ' + openSeries + '.');
    return;
  }

  var identity = seriesIdentity(openSeries);
  if (!identity) return;
  store.addSubscription({
    source: identity.source,
    seriesId: identity.seriesId,
    seriesName: openSeries
  });
  toast('Following ' + openSeries + ' — new issues will be added automatically.');
});

function openSeriesView(name) {
  openSeries = name;
  disarmReadAll();
  disarmDeleteSeries();
  render();
  document.querySelector('.content').scrollTop = 0;
}

function closeSeriesView() {
  openSeries = null;
  disarmReadAll();
  disarmDeleteSeries();
  render();
}

function applyViewVisibility() {
  var showingSeries = !!openSeries;
  document.getElementById('tabs').hidden = showingSeries;
  seriesView.hidden = !showingSeries;
  document.querySelectorAll('.panel').forEach(function (panel) {
    panel.hidden = showingSeries || panel.id !== 'panel-' + currentTab();
  });
}

function renderLibrary() {
  store.STATUSES.forEach(function (status) {
    var grid = document.querySelector('[data-grid="' + status + '"]');
    var entries = store.byStatus(status);
    var grouped = groupBySeries(entries);

    grid.textContent = '';
    grouped.order.forEach(function (name) {
      grid.appendChild(createSeriesTile(name, grouped.groups[name], entriesInSeries(name)));
    });

    // Once per grid, not once per render.
    if (!grid.dataset.dragReady) {
      grid.dataset.dragReady = '1';
      enableSeriesDrag(grid);
    }

    var empty = document.querySelector('[data-empty="' + status + '"]');
    if (empty) empty.hidden = entries.length > 0;

    // The tab badge counts issues, not series — more useful at a glance.
    var count = document.querySelector('[data-count="' + status + '"]');
    if (count) count.textContent = String(entries.length);
  });
}

function renderSeriesView() {
  var issues = sortIssues(entriesInSeries(openSeries));

  // Everything in it was deleted while it was open.
  if (!issues.length) {
    closeSeriesView();
    return;
  }

  seriesViewTitle.textContent = openSeries;

  var counts = {};
  issues.forEach(function (e) { counts[e.status] = (counts[e.status] || 0) + 1; });
  var parts = [issues.length + (issues.length === 1 ? ' issue' : ' issues')];
  store.STATUSES.forEach(function (status) {
    if (counts[status]) parts.push(counts[status] + ' ' + LIST_LABELS[status].toLowerCase());
  });
  seriesViewMeta.textContent = parts.join(' · ');

  seriesIssues.textContent = '';
  issues.forEach(function (entry) { seriesIssues.appendChild(createIssueTile(entry)); });

  // Nothing to mark means no button.
  var today = todayISO();
  var markable = issues.filter(function (e) {
    return e.status !== 'read' && !(e.releaseDate && e.releaseDate > today);
  });
  seriesReadAllBtn.hidden = !markable.length;
  seriesReadAllBtn.dataset.count = String(markable.length);

  renderFollowButton();
}

function render() {
  applyViewVisibility();
  if (openSeries) renderSeriesView();
  else renderLibrary();
  refreshReleaseNotice();
}

/* ---------- whole-series actions ---------- */

var readAllArmed = false;
var readAllTimer = null;

function disarmReadAll() {
  readAllArmed = false;
  clearTimeout(readAllTimer);
  seriesReadAllBtn.textContent = 'Mark released issues read';
  seriesReadAllBtn.classList.remove('btn--armed');
}

seriesReadAllBtn.addEventListener('click', function () {
  var count = Number(seriesReadAllBtn.dataset.count || 0);
  if (!count) return;

  // Two-step, like Delete: marking a dozen issues read by accident is
  // tedious to undo one at a time.
  if (!readAllArmed) {
    readAllArmed = true;
    seriesReadAllBtn.textContent = 'Tap again: mark ' + count +
      (count === 1 ? ' issue read' : ' issues read');
    seriesReadAllBtn.classList.add('btn--armed');
    readAllTimer = setTimeout(disarmReadAll, 5000);
    return;
  }

  disarmReadAll();
  var marked = store.markSeriesRead(openSeries, todayISO());
  toast('Marked ' + marked + (marked === 1 ? ' issue' : ' issues') + ' read.');
});

/* Deleting a series takes every issue of it with it, and unfollows. Two-step
 * for the same reason Delete is: this is the most destructive button in the
 * app and there's no undo. */

var deleteSeriesArmed = false;
var deleteSeriesTimer = null;

function disarmDeleteSeries() {
  deleteSeriesArmed = false;
  clearTimeout(deleteSeriesTimer);
  seriesDeleteBtn.textContent = 'Delete series';
  seriesDeleteBtn.classList.remove('btn--armed');
}

seriesDeleteBtn.addEventListener('click', function () {
  if (!openSeries) return;

  var count = entriesInSeries(openSeries).length;

  if (!deleteSeriesArmed) {
    deleteSeriesArmed = true;
    seriesDeleteBtn.textContent = 'Tap again: delete ' + count +
      (count === 1 ? ' issue' : ' issues');
    seriesDeleteBtn.classList.add('btn--armed');
    deleteSeriesTimer = setTimeout(disarmDeleteSeries, 5000);
    return;
  }

  var name = openSeries;
  disarmDeleteSeries();
  var removed = store.removeSeries(name);

  // removeSeries fires a change, which re-renders and — finding the series
  // empty — drops back to the grid on its own.
  toast('Deleted ' + name + ' (' + removed.issues +
        (removed.issues === 1 ? ' issue' : ' issues') +
        (removed.unfollowed ? ', unfollowed' : '') + ').');
});

document.getElementById('series-back-btn').addEventListener('click', closeSeriesView);

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

/* Cover art and issue number picked up from a search result. Held aside
 * because the form has no fields for them — they aren't things to type. */
var pendingFromSearch = null;

/* ---------- which database to search ---------- */

/* Metron knows about issues that haven't come out; Comic Vine has the deeper
 * back catalogue. Left unset, the server tries Metron and falls back — the
 * toggle pins it to one so you can tell where a result came from. */
var SOURCES = [
  { id: '', label: 'Auto', title: 'Metron, falling back to Comic Vine', icon: null },
  { id: 'metron', label: 'M', title: 'Metron only', icon: 'https://metron.cloud/favicon.ico' },
  { id: 'comicvine', label: 'CV', title: 'Comic Vine only',
    icon: 'https://comicvine.gamespot.com/favicon.ico' }
];

var activeSource = '';
try {
  activeSource = localStorage.getItem('cubcave.source') || '';
} catch (err) { /* ignore */ }

var sourceListeners = [];

function setSource(id) {
  activeSource = id;
  try { localStorage.setItem('cubcave.source', id); } catch (err) { /* ignore */ }
  sourceListeners.forEach(function (fn) { fn(id); });
}

function buildSourceToggle(container, onChange) {
  function paint() {
    container.textContent = '';
    SOURCES.forEach(function (source) {
      var button = el('button', 'source-toggle__btn' +
        (activeSource === source.id ? ' is-active' : ''));
      button.type = 'button';
      button.title = source.title;
      button.setAttribute('aria-label', source.title);
      button.setAttribute('aria-pressed', String(activeSource === source.id));

      if (source.icon) {
        var img = document.createElement('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        // Their favicons are hotlinked; fall back to a monogram if blocked
        // or offline.
        img.addEventListener('error', function () {
          img.remove();
          button.appendChild(el('span', 'source-toggle__text', source.label));
        });
        img.src = source.icon;
        button.appendChild(img);
      } else {
        button.appendChild(el('span', 'source-toggle__text', source.label));
      }

      button.addEventListener('click', function () {
        setSource(source.id);
        if (onChange) onChange();
      });

      container.appendChild(button);
    });
  }

  sourceListeners.push(paint);
  paint();
}

/* ---------- live comic search ---------- */

var suggestBox = document.getElementById('title-suggest');
var suggestStatus = document.getElementById('suggest-status');

var SUGGEST_STATUS = {
  searching: 'Searching…',
  'too-short': 'Keep typing to search the comic database.',
  'signed-out': 'Sign in to search the comic database.',
  offline: 'Offline — search unavailable.',
  unconfigured: ''    // not deployed: stay silent rather than nag
};

CubCave.search.bindCurrentText(function () { return fTitle.value; });

function hideSuggestions() {
  suggestBox.hidden = true;
  suggestBox.textContent = '';
  fTitle.setAttribute('aria-expanded', 'false');
}

function setSuggestStatus(text) {
  suggestStatus.textContent = text || '';
  suggestStatus.hidden = !text;
}

var issueResults = [];
var issueShown = PAGE_SIZE;

function renderSuggestions(results) {
  issueResults = results || [];
  issueShown = PAGE_SIZE;
  repaintSuggestions();
}

function repaintSuggestions() {
  suggestBox.textContent = '';

  if (!issueResults.length) {
    hideSuggestions();
    setSuggestStatus('No matches — type the title yourself.');
    return;
  }

  issueResults.slice(0, issueShown).forEach(function (item) {
    var row = el('button', 'suggest__item');
    row.type = 'button';
    row.setAttribute('role', 'option');

    row.appendChild(el('span', 'suggest__title', item.title));

    var bits = [];
    if (item.storyTitle) bits.push(item.storyTitle);
    if (item.releaseDate) {
      bits.push(formatDay(item.releaseDate) +
        // Cover dates are the printed month, often weeks after it hits shops.
        // Say so, rather than quietly storing a date that won't match reality.
        (item.dateIsApproximate ? ' (cover date)' : ''));
    } else {
      bits.push('no release date');
    }
    row.appendChild(el('span', 'suggest__meta', bits.join(' · ')));

    /* click, not pointerdown: pointerdown fires as soon as a finger lands, so
     * scrolling the list selected whichever result the swipe started on. */
    row.addEventListener('click', function () { applySuggestion(item); });

    suggestBox.appendChild(row);
  });

  appendMoreButton(suggestBox, issueResults.length, issueShown, function () {
    issueShown += PAGE_SIZE;
    repaintSuggestions();
  });

  suggestBox.hidden = false;
  fTitle.setAttribute('aria-expanded', 'true');
  setSuggestStatus('');
}

function applySuggestion(item) {
  fTitle.value = item.title;
  if (item.series) fSeries.value = item.series;
  if (item.releaseDate) fRelease.value = item.releaseDate;

  // Carried through the form so the tile has cover art and sorts correctly.
  pendingFromSearch = {
    coverUrl: item.coverUrl || '',
    issueNumber: item.issueNumber || '',
    sourceId: item.source && item.sourceId ? item.source + ':' + item.sourceId : null
  };

  // Only force the list when the comic genuinely hasn't come out yet.
  // A back issue could belong in any list, so leave that choice alone.
  if (item.releaseDate && daysUntil(item.releaseDate) > 0) {
    fStatus.value = 'upcoming';
  }
  syncReleaseVisibility();

  CubCave.search.cancel();
  hideSuggestions();

  var note = item.releaseDate
    ? (item.dateIsApproximate ? 'Filled in — date is a cover date, worth checking.' : 'Filled in from the comic database.')
    : 'Filled in — no release date on record.';
  setSuggestStatus(note);
}

buildSourceToggle(document.getElementById('title-source'), function () {
  // Re-run the current query against the newly chosen database.
  if (fTitle.value.trim()) fTitle.dispatchEvent(new Event('input'));
});

fTitle.addEventListener('input', function () {
  CubCave.search.onInput(fTitle.value, {
    onState: function (state) {
      hideSuggestions();
      setSuggestStatus(SUGGEST_STATUS[state] || '');
    },
    onResults: renderSuggestions,
    onError: function (message) {
      hideSuggestions();
      setSuggestStatus(message);
    }
  }, { source: activeSource });
});

fTitle.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && !suggestBox.hidden) {
    // Dismiss the list without closing the whole sheet.
    event.stopPropagation();
    CubCave.search.cancel();
    hideSuggestions();
  }
});

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
  pendingFromSearch = null;

  // Never carry a previous search's results into a freshly opened sheet.
  CubCave.search.cancel();
  hideSuggestions();
  setSuggestStatus('');

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

  if (pendingFromSearch) {
    fields.coverUrl = pendingFromSearch.coverUrl;
    fields.issueNumber = pendingFromSearch.issueNumber;
    if (pendingFromSearch.sourceId) fields.sourceId = pendingFromSearch.sourceId;
  }

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

  // Changing list leaves any open series behind.
  openSeries = null;
  applyViewVisibility();

  try {
    localStorage.setItem('cubcave.tab', name);
  } catch (err) {
    /* Private mode or blocked storage — remembering the tab is optional. */
  }
}

tabs.forEach(function (tab) {
  tab.addEventListener('click', function () { selectTab(tab.dataset.tab); });
});

/* ---------- followed series ---------- */

var followList = document.getElementById('follow-list');
var followText = document.getElementById('follow-text');
var seriesDialog = document.getElementById('series-dialog');
var seriesInput = document.getElementById('f-series-search');
var seriesSuggest = document.getElementById('series-suggest');
var seriesStatus = document.getElementById('series-status');
var backfillBtn = document.getElementById('backfill-btn');

function renderFollowing() {
  var subs = store.getSubscriptions();
  followList.textContent = '';

  followText.textContent = subs.length
    ? 'New issues are added to Upcoming automatically.'
    : 'Add a series and its issues are pulled in — including ones not released yet.';

  // Only offer the backfill when there's actually something to fix.
  var missing = store.all().filter(function (e) { return !e.coverUrl; }).length;
  backfillBtn.hidden = !missing;
  if (missing && !backfillBtn.disabled) {
    backfillBtn.textContent = 'Find covers for ' + missing +
      (missing === 1 ? ' issue' : ' issues');
  }

  subs.forEach(function (sub) {
    var li = el('li', 'follow-item');
    li.appendChild(el('span', 'follow-item__name', sub.seriesName));

    var remove = el('button', 'entry__btn', 'Unfollow');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Unfollow ' + sub.seriesName);
    remove.addEventListener('click', function () {
      store.removeSubscription(sub.id);
      toast('Unfollowed ' + sub.seriesName + '.');
    });

    li.appendChild(remove);
    followList.appendChild(li);
  });
}

function setSeriesStatus(text) {
  seriesStatus.textContent = text || '';
  seriesStatus.hidden = !text;
}

var PAGE_SIZE = 8;
var seriesResults = [];
var seriesShown = PAGE_SIZE;

function renderSeriesResults(results) {
  seriesResults = results || [];
  seriesShown = PAGE_SIZE;
  repaintSeriesResults();
}

/* Separate from the above on purpose: the search layer calls onResults with
 * (results, query), so a second positional "keep the page" argument would
 * silently receive the query string. */
function repaintSeriesResults() {
  seriesSuggest.textContent = '';

  if (!seriesResults.length) {
    seriesSuggest.hidden = true;
    setSeriesStatus('No series found.');
    return;
  }

  seriesResults.slice(0, seriesShown).forEach(function (item) {
    var row = el('button', 'suggest__item');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.appendChild(el('span', 'suggest__title', item.seriesName));
    row.appendChild(el('span', 'suggest__meta',
      item.issueCount + (item.issueCount === 1 ? ' issue on record' : ' issues on record')));

    /* click, not pointerdown: pointerdown fires the moment a finger touches
     * the screen, so scrolling the list picked whichever result you happened
     * to start the swipe on. */
    row.addEventListener('click', function () { followSeries(item); });

    seriesSuggest.appendChild(row);
  });

  appendMoreButton(seriesSuggest, seriesResults.length, seriesShown, function () {
    seriesShown += PAGE_SIZE;
    repaintSeriesResults();
  });

  seriesSuggest.hidden = false;
  setSeriesStatus('');
}

function appendMoreButton(container, total, shown, onMore) {
  if (shown >= total) return;
  var remaining = total - shown;
  var more = el('button', 'suggest__more',
    'More (' + remaining + ' left)');
  more.type = 'button';
  more.addEventListener('click', function (event) {
    event.stopPropagation();
    onMore();
  });
  container.appendChild(more);
}

/* Adding a series brings in its whole run and follows it, so future issues
 * keep arriving. Issues not yet released are marked Upcoming automatically;
 * everything else lands in the queue for you to mark as you go. */
/* Importing does NOT follow the series. Following is its own decision, made
 * from the series view — adding a finished run shouldn't sign you up for
 * notifications about it. */
function followSeries(item) {
  seriesSuggest.hidden = true;
  setSeriesStatus('Adding ' + item.seriesName + ' — fetching issues…');

  CubCave.search.allIssuesForSeries(item.seriesId, item.source).then(function (issues) {
    var today = todayISO();
    var batch = [];
    var skipped = 0;

    issues.forEach(function (issue) {
      var sourceId = 'metron:' + issue.sourceId;
      if (store.hasSourceId(sourceId)) { skipped += 1; return; }

      batch.push({
        title: issue.title,
        series: issue.series,
        // Not out yet decides itself; the rest is for you to mark.
        status: (issue.releaseDate && issue.releaseDate > today) ? 'upcoming' : 'next',
        releaseDate: issue.releaseDate,
        notes: '',
        sourceId: sourceId,
        coverUrl: issue.coverUrl || '',
        issueNumber: issue.issueNumber || '',
        // Remembered so the series can be followed later without searching.
        seriesId: item.seriesId,
        seriesSource: item.source
      });
    });

    var added = store.addMany(batch);
    var upcoming = batch.filter(function (b) { return b.status === 'upcoming'; }).length;

    var message;
    if (added) {
      message = 'Added ' + added + (added === 1 ? ' issue' : ' issues');
      if (upcoming) message += ', ' + upcoming + ' not out yet';
      message += '.';
    } else if (skipped) {
      message = 'Already up to date — all ' + skipped + ' issues are tracked.';
    } else {
      message = 'Nothing on record yet. New issues will be added as they appear.';
    }
    setSeriesStatus(message);
    toast(message);
  }).catch(function (err) {
    // The follow itself is saved regardless — the daily job picks it up even
    // if this import failed.
    setSeriesStatus('Following ' + item.seriesName +
                    ', but could not fetch issues now: ' + err.message);
  });
}

/* ---------- cover backfill ---------- */

/* Entries added before covers were stored have no art. Rather than a lookup
 * per issue, this resolves one series at a time — a series search to find its
 * id, then its issues in one request — and matches on issue number. */
function backfillCovers() {
  var missing = store.all().filter(function (e) { return !e.coverUrl; });
  if (!missing.length) {
    toast('Every issue already has a cover.');
    return Promise.resolve(0);
  }

  var bySeries = {};
  missing.forEach(function (entry) {
    var key = seriesKeyOf(entry);
    if (key === 'Other') return;      // nothing to look the series up by
    (bySeries[key] = bySeries[key] || []).push(entry);
  });

  var names = Object.keys(bySeries);
  if (!names.length) {
    toast('Those issues have no series to look up.');
    return Promise.resolve(0);
  }

  backfillBtn.disabled = true;
  var patched = 0;
  var index = 0;

  function nextSeries() {
    if (index >= names.length) {
      backfillBtn.disabled = false;
      toast(patched
        ? 'Found covers for ' + patched + (patched === 1 ? ' issue.' : ' issues.')
        : 'No matching covers found.');
      renderFollowing();
      return patched;
    }

    var name = names[index++];
    backfillBtn.textContent = 'Finding covers… (' + index + '/' + names.length + ')';

    // Strip the "(2024)" the app appends, since that's our label not Metron's.
    var searchName = name.replace(/\s*\(\d{4}\)\s*$/, '');

    return CubCave.search.seriesByName(searchName).then(function (candidates) {
      var match = candidates.filter(function (c) { return c.seriesName === name; })[0]
               || candidates.filter(function (c) {
                    return c.seriesName.replace(/\s*\(\d{4}\)\s*$/, '') === searchName;
                  })[0];
      if (!match) return;

      return CubCave.search.allIssuesForSeries(match.seriesId).then(function (issues) {
        var byNumber = {};
        issues.forEach(function (i) {
          if (i.issueNumber) byNumber[String(i.issueNumber)] = i;
        });

        var patches = [];
        bySeries[name].forEach(function (entry) {
          var number = entry.issueNumber ||
            (String(entry.title).match(/#\s*([0-9]+(?:\.[0-9]+)?)/) || [])[1];
          var found = number && byNumber[String(number)];
          if (!found || !found.coverUrl) return;
          patches.push({
            id: entry.id,
            coverUrl: found.coverUrl,
            issueNumber: found.issueNumber,
            sourceId: 'metron:' + found.sourceId
          });
        });
        patched += store.applyPatches(patches);
      });
    }).catch(function (err) {
      console.warn('Cover lookup failed for "' + name + '":', err.message);
    }).then(function () {
      // Paced: Metron allows 20 requests a minute and each series costs two.
      return new Promise(function (resolve) { setTimeout(resolve, 400); })
        .then(nextSeries);
    });
  }

  return nextSeries();
}

backfillBtn.addEventListener('click', function () { backfillCovers(); });

function openSeriesPicker() {
  seriesInput.value = '';
  seriesSuggest.hidden = true;
  seriesSuggest.textContent = '';
  setSeriesStatus(CubCave.search.readiness() === 'signed-out'
    ? 'Sign in to search for series.' : '');
  seriesDialog.showModal();
  if (!window.matchMedia('(pointer: coarse)').matches) seriesInput.focus();
}

document.getElementById('add-series-btn').addEventListener('click', openSeriesPicker);
document.getElementById('follow-add-btn').addEventListener('click', openSeriesPicker);

// Escape hatch for anything the database doesn't have.
document.getElementById('single-issue-btn').addEventListener('click', function () {
  CubCave.search.cancel();
  seriesDialog.close();
  openForm(null);
});

document.getElementById('series-close-btn').addEventListener('click', function () {
  CubCave.search.cancel();
  seriesDialog.close();
});

seriesInput.addEventListener('input', function () {
  CubCave.search.onInput(seriesInput.value, {
    onState: function (state) {
      seriesSuggest.hidden = true;
      setSeriesStatus(SUGGEST_STATUS[state] || '');
    },
    onResults: renderSeriesResults,
    onError: function (message) {
      seriesSuggest.hidden = true;
      setSeriesStatus(message);
    }
  }, {
    type: 'series',
    source: activeSource,
    currentText: function () { return seriesInput.value; }
  });
});

buildSourceToggle(document.getElementById('series-source'), function () {
  if (seriesInput.value.trim()) seriesInput.dispatchEvent(new Event('input'));
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

  // With several devices registered, say so — otherwise it's invisible that
  // your laptop is still on the list after enabling on a phone.
  if (state === 'enabled') {
    var others = CubCave.push.registeredDeviceCount() - 1;
    if (others > 0) {
      pushText.textContent = copy.text + ' ' + others +
        (others === 1 ? ' other device is' : ' other devices are') + ' also registered.';
    }
  }

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
    if (reason === 'dismissed') {
      toast('Permission dismissed — tap Enable to try again.');
    } else if (reason === 'denied') {
      toast('Notifications blocked in browser settings.');
    } else if (reason === 'no-token') {
      toast('Google didn\'t return a token. Try again.');
    } else if (/push service error|AbortError/i.test(reason || '')) {
      // The browser's push service refused. Usually Brave or Chromium with
      // Google push messaging switched off, or a blocked network.
      renderPushCard();
      showNotice(
        'Your browser refused to register for push. This is usually a browser ' +
        'setting rather than a fault in the app — Brave and some Chromium ' +
        'builds disable Google push messaging by default. Try another browser ' +
        'to confirm.'
      );
      return;
    } else {
      toast('Could not enable notifications: ' + reason);
    }
    renderPushCard();
  }).then(function () {
    pushBtn.disabled = false;
  });
});

pushTestBtn.addEventListener('click', function () {
  CubCave.push.sendTestNotification()
    .then(function (shown) {
      if (shown) {
        toast('Test notification sent.');
      } else {
        // The browser accepted it but nothing appeared — that's the operating
        // system suppressing it, not the app failing.
        showNotice(
          'The notification was sent but your system didn\'t display it. ' +
          'Check Do Not Disturb / Focus assist, and that notifications are ' +
          'allowed for this browser in Windows Settings → Notifications.'
        );
      }
    })
    .catch(function (err) {
      var reason = (err && err.message) || '';
      if (reason.indexOf('permission-') === 0) {
        toast('Notification permission is ' + reason.slice(11) + '.');
        renderPushCard();
      } else {
        toast('Test failed: ' + reason);
      }
    });
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
renderFollowing();
store.subscribe(renderFollowing);

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
