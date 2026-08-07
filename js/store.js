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
      // A list, so every device you enable notifications on gets alerted —
      // not just the most recent one.
      pushSubscriptions: [],
      /* Series you follow. The daily job checks these against the comic
       * database and adds newly solicited issues to Upcoming by itself —
       * which is how an issue that isn't in the database yet still reaches
       * you when it appears. */
      subscriptions: [],
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
          sortOrder: typeof e.sortOrder === 'number' ? e.sortOrder : i,
          // Where an entry came from, e.g. "metron:127884". Set when added
          // from a search result or by a followed series, and used to avoid
          // adding the same issue twice.
          sourceId: typeof e.sourceId === 'string' ? e.sourceId : null
        };
      });

    if (Array.isArray(parsed.pushSubscriptions)) {
      clean.pushSubscriptions = parsed.pushSubscriptions.filter(function (s) {
        return s && typeof s.fcmToken === 'string' && s.fcmToken;
      });
    } else if (parsed.pushSubscription && typeof parsed.pushSubscription.fcmToken === 'string') {
      // Migrate the original single-token shape. A document written before
      // this change still has to load — it's already sitting in Drive.
      clean.pushSubscriptions = [{
        fcmToken: parsed.pushSubscription.fcmToken,
        registeredAt: parsed.pushSubscription.registeredAt || nowISO(),
        label: parsed.pushSubscription.label || 'Migrated device'
      }];
    }

    if (Array.isArray(parsed.subscriptions)) {
      clean.subscriptions = parsed.subscriptions
        .filter(function (s) { return s && s.seriesId != null; })
        .map(function (s) {
          return {
            id: typeof s.id === 'string' && s.id ? s.id : uid(),
            source: typeof s.source === 'string' ? s.source : 'metron',
            seriesId: String(s.seriesId),
            seriesName: typeof s.seriesName === 'string' ? s.seriesName : 'Unknown series',
            addedAt: typeof s.addedAt === 'string' ? s.addedAt : nowISO(),
            lastCheckedAt: typeof s.lastCheckedAt === 'string' ? s.lastCheckedAt : null
          };
        });
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
      pushSubscriptions: data.pushSubscriptions.slice(),
      subscriptions: data.subscriptions.slice(),
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
      sortOrder: nextMaxSortOrder() + 1,
      sourceId: typeof fields.sourceId === 'string' ? fields.sourceId : null
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

  /* ---------- followed series ---------- */

  function getSubscriptions() {
    return data.subscriptions.slice();
  }

  function isSubscribed(seriesId) {
    return data.subscriptions.some(function (s) {
      return s.seriesId === String(seriesId);
    });
  }

  function addSubscription(fields) {
    if (!fields || fields.seriesId == null) return null;
    if (isSubscribed(fields.seriesId)) return null;

    var sub = {
      id: uid(),
      source: fields.source || 'metron',
      seriesId: String(fields.seriesId),
      seriesName: String(fields.seriesName || 'Unknown series'),
      addedAt: nowISO(),
      lastCheckedAt: null
    };
    data.subscriptions.push(sub);
    changed();
    return sub;
  }

  function removeSubscription(id) {
    var before = data.subscriptions.length;
    data.subscriptions = data.subscriptions.filter(function (s) { return s.id !== id; });
    if (data.subscriptions.length !== before) changed();
  }

  // Used before auto-adding, so a followed series can't create duplicates of
  // issues already tracked.
  function hasSourceId(sourceId) {
    if (!sourceId) return false;
    return data.entries.some(function (e) { return e.sourceId === sourceId; });
  }

  /* ---------- push subscriptions ---------- */

  function getPushSubscriptions() {
    return data.pushSubscriptions.slice();
  }

  function findSubscription(token) {
    for (var i = 0; i < data.pushSubscriptions.length; i++) {
      if (data.pushSubscriptions[i].fcmToken === token) return data.pushSubscriptions[i];
    }
    return null;
  }

  // Registering the same device twice must not create a duplicate — FCM
  // tokens are stable until they rotate, so this is the common case.
  function addPushSubscription(token, label) {
    if (!token) return;
    var existing = findSubscription(token);
    if (existing) {
      existing.lastSeenAt = nowISO();
      if (label) existing.label = label;
    } else {
      data.pushSubscriptions.push({
        fcmToken: token,
        label: label || 'This device',
        registeredAt: nowISO(),
        lastSeenAt: nowISO()
      });
    }
    changed();
  }

  // Phase 5 calls this when FCM reports a token as permanently invalid, so
  // dead devices don't accumulate forever.
  function removePushSubscription(token) {
    var before = data.pushSubscriptions.length;
    data.pushSubscriptions = data.pushSubscriptions.filter(function (s) {
      return s.fcmToken !== token;
    });
    if (data.pushSubscriptions.length !== before) changed();
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
    getSubscriptions: getSubscriptions,
    isSubscribed: isSubscribed,
    addSubscription: addSubscription,
    removeSubscription: removeSubscription,
    hasSourceId: hasSourceId,
    getPushSubscriptions: getPushSubscriptions,
    addPushSubscription: addPushSubscription,
    removePushSubscription: removePushSubscription
  };
})();
