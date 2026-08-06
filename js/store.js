/* The Cub Cave — data store.
 *
 * Everything that touches entry data goes through here.
 *
 * Since Phase 3, Google Drive is the source of truth and localStorage is a
 * local mirror: writes hit the mirror synchronously (so the app stays usable
 * offline and repaints instantly) while CubCave.sync pushes the same data up
 * to Drive in the background. This module knows nothing about Drive — it just
 * announces local changes and lets sync deal with the network.
 *
 * On-disk shape (matches the agreed schema):
 *   {
 *     "entries": [{ id, title, series, status, releaseDate, notes,
 *                   dateAdded, dateRead, sortOrder }],
 *     "pushSubscription": { fcmToken, registeredAt } | null,
 *     "updatedAt": "2026-08-06T00:00:00Z",
 *     "schemaVersion": 1
 *   }
 */

'use strict';

var CubCave = window.CubCave || (window.CubCave = {});

CubCave.store = (function () {

  var STORAGE_KEY = 'cubcave.data.v1';
  var STATUSES = ['reading', 'next', 'upcoming', 'read'];
  var SCHEMA_VERSION = 1;

  var data = emptyData();
  var listeners = [];        // re-render hooks
  var localListeners = [];   // "the user changed something" hooks (sync)
  var saveTimer = null;

  function emptyData() {
    return {
      entries: [],
      pushSubscription: null,
      updatedAt: null,
      schemaVersion: SCHEMA_VERSION
    };
  }

  function uid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nowISO() {
    return new Date().toISOString();
  }

  /* ---------- persistence adapter — Phase 3 replaces this pair ---------- */

  function readRaw() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      console.warn('Could not read local storage:', err);
      return null;
    }
  }

  function writeRaw(text) {
    try {
      localStorage.setItem(STORAGE_KEY, text);
      return true;
    } catch (err) {
      console.warn('Could not write local storage:', err);
      return false;
    }
  }

  /* ---------- load / save ---------- */

  // Defensive: the file is hand-editable and will later round-trip through
  // Drive, so never trust its shape.
  function normalize(parsed) {
    var clean = emptyData();
    if (!parsed || typeof parsed !== 'object') return clean;

    var entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    clean.entries = entries
      .filter(function (e) { return e && typeof e.title === 'string' && e.title.trim(); })
      .map(function (e, i) {
        return {
          id: typeof e.id === 'string' && e.id ? e.id : uid(),
          title: String(e.title).trim(),
          series: typeof e.series === 'string' ? e.series.trim() : '',
          status: STATUSES.indexOf(e.status) !== -1 ? e.status : 'next',
          releaseDate: isDateString(e.releaseDate) ? e.releaseDate : null,
          notes: typeof e.notes === 'string' ? e.notes : '',
          dateAdded: typeof e.dateAdded === 'string' ? e.dateAdded : nowISO(),
          dateRead: typeof e.dateRead === 'string' ? e.dateRead : null,
          sortOrder: typeof e.sortOrder === 'number' ? e.sortOrder : i
        };
      });

    if (parsed.pushSubscription && typeof parsed.pushSubscription === 'object') {
      clean.pushSubscription = parsed.pushSubscription;
    }
    if (typeof parsed.updatedAt === 'string') clean.updatedAt = parsed.updatedAt;
    return clean;
  }

  function isDateString(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function load() {
    var raw = readRaw();
    if (!raw) {
      data = emptyData();
      return data;
    }
    try {
      data = normalize(JSON.parse(raw));
    } catch (err) {
      console.warn('Stored data was not valid JSON; starting empty.', err);
      data = emptyData();
    }
    return data;
  }

  // Debounced so holding a reorder button doesn't write on every tap.
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    return writeRaw(JSON.stringify(data));
  }

  /* ---------- change notification ---------- */

  // Re-render hooks: fire for any data change, local or pulled from Drive.
  function subscribe(fn) {
    listeners.push(fn);
  }

  // Local-change hooks: fire only for user edits, so sync can push to Drive.
  // Pulls from Drive deliberately skip these, otherwise every pull would
  // trigger a push straight back up.
  function onLocalChange(fn) {
    localListeners.push(fn);
  }

  function changed() {
    data.updatedAt = nowISO();
    save();
    listeners.forEach(function (fn) { fn(); });
    localListeners.forEach(function (fn) { fn(); });
  }

  /* ---------- whole-document access (used by sync) ---------- */

  function snapshot() {
    return {
      entries: data.entries.slice(),
      pushSubscription: data.pushSubscription,
      // A file created before any edit has no updatedAt yet; stamp it now so
      // the document on Drive always carries a real timestamp.
      updatedAt: data.updatedAt || nowISO(),
      schemaVersion: SCHEMA_VERSION
    };
  }

  // Replace everything with a document pulled from Drive. Re-renders, but
  // does not mark the data dirty.
  function replaceAll(parsed) {
    data = normalize(parsed);
    saveNow();
    listeners.forEach(function (fn) { fn(); });
  }

  function updatedAt() {
    return data.updatedAt;
  }

  /* ---------- reads ---------- */

  function all() {
    return data.entries.slice();
  }

  function find(id) {
    for (var i = 0; i < data.entries.length; i++) {
      if (data.entries[i].id === id) return data.entries[i];
    }
    return null;
  }

  // Each list gets the ordering that actually makes sense for it.
  function byStatus(status) {
    var list = data.entries.filter(function (e) { return e.status === status; });

    if (status === 'next') {
      // Manual queue order.
      list.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    } else if (status === 'upcoming') {
      // Soonest release first; undated entries sink to the bottom.
      list.sort(function (a, b) {
        if (!a.releaseDate && !b.releaseDate) return 0;
        if (!a.releaseDate) return 1;
        if (!b.releaseDate) return -1;
        return a.releaseDate < b.releaseDate ? -1 : (a.releaseDate > b.releaseDate ? 1 : 0);
      });
    } else if (status === 'read') {
      // Most recently finished first.
      list.sort(function (a, b) {
        return String(b.dateRead || '').localeCompare(String(a.dateRead || ''));
      });
    } else {
      // Reading: most recently added first.
      list.sort(function (a, b) {
        return String(b.dateAdded || '').localeCompare(String(a.dateAdded || ''));
      });
    }
    return list;
  }

  function nextMaxSortOrder() {
    var max = -1;
    data.entries.forEach(function (e) {
      if (e.status === 'next' && e.sortOrder > max) max = e.sortOrder;
    });
    return max;
  }

  /* ---------- writes ---------- */

  function add(fields) {
    var entry = {
      id: uid(),
      title: String(fields.title || '').trim(),
      series: String(fields.series || '').trim(),
      status: STATUSES.indexOf(fields.status) !== -1 ? fields.status : 'next',
      releaseDate: isDateString(fields.releaseDate) ? fields.releaseDate : null,
      notes: String(fields.notes || '').trim(),
      dateAdded: nowISO(),
      dateRead: null,
      sortOrder: nextMaxSortOrder() + 1
    };
    // Added straight to Read? Then it was finished now.
    if (entry.status === 'read') entry.dateRead = nowISO();

    data.entries.push(entry);
    changed();
    return entry;
  }

  function update(id, fields) {
    var entry = find(id);
    if (!entry) return null;

    var wasStatus = entry.status;

    if ('title' in fields) entry.title = String(fields.title || '').trim();
    if ('series' in fields) entry.series = String(fields.series || '').trim();
    if ('notes' in fields) entry.notes = String(fields.notes || '').trim();
    if ('releaseDate' in fields) {
      entry.releaseDate = isDateString(fields.releaseDate) ? fields.releaseDate : null;
    }
    if ('status' in fields && STATUSES.indexOf(fields.status) !== -1) {
      entry.status = fields.status;
    }

    if (entry.status !== wasStatus) {
      // Joining the queue means joining the back of it.
      if (entry.status === 'next') entry.sortOrder = nextMaxSortOrder() + 1;
      // Stamp on the way into Read; clear it on the way back out, so an
      // entry never carries a stale "finished" date.
      if (entry.status === 'read' && !entry.dateRead) entry.dateRead = nowISO();
      if (entry.status !== 'read') entry.dateRead = null;
    }

    changed();
    return entry;
  }

  function markRead(id) {
    var entry = find(id);
    if (!entry) return null;
    entry.status = 'read';
    entry.dateRead = nowISO();
    changed();
    return entry;
  }

  function remove(id) {
    var before = data.entries.length;
    data.entries = data.entries.filter(function (e) { return e.id !== id; });
    if (data.entries.length !== before) changed();
  }

  // Swap sortOrder with the neighbour above/below in the queue.
  function moveInQueue(id, direction) {
    var queue = byStatus('next');
    var index = -1;
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id === id) { index = i; break; }
    }
    if (index === -1) return;

    var target = index + (direction === 'up' ? -1 : 1);
    if (target < 0 || target >= queue.length) return;

    var a = queue[index], b = queue[target];
    var tmp = a.sortOrder;
    a.sortOrder = b.sortOrder;
    b.sortOrder = tmp;
    changed();
  }

  /* ---------- push subscription (used from Phase 4) ---------- */

  function getPushSubscription() {
    return data.pushSubscription;
  }

  function setPushSubscription(sub) {
    data.pushSubscription = sub;
    changed();
  }

  return {
    STATUSES: STATUSES,
    load: load,
    saveNow: saveNow,
    subscribe: subscribe,
    onLocalChange: onLocalChange,
    snapshot: snapshot,
    replaceAll: replaceAll,
    updatedAt: updatedAt,
    all: all,
    find: find,
    byStatus: byStatus,
    add: add,
    update: update,
    markRead: markRead,
    remove: remove,
    moveInQueue: moveInQueue,
    getPushSubscription: getPushSubscription,
    setPushSubscription: setPushSubscription
  };
})();
