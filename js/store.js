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
      /* Your hand-arranged order of series, by name. One global order used on
       * every list — a series you consider urgent is urgent wherever it
       * appears. Series not in here fall in after the ones that are. */
      seriesOrder: [],
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
          sourceId: typeof e.sourceId === 'string' ? e.sourceId : null,
          // Cover art, and the issue number on its own so issues in a series
          // sort numerically rather than as text ("#9" before "#10").
          coverUrl: typeof e.coverUrl === 'string' ? e.coverUrl : '',
          issueNumber: typeof e.issueNumber === 'string' ? e.issueNumber
                     : (typeof e.issueNumber === 'number' ? String(e.issueNumber) : ''),
          // The database's id for the SERIES, kept so the series can be
          // followed later without having to search for it again.
          seriesId: e.seriesId != null ? String(e.seriesId) : '',
          seriesSource: typeof e.seriesSource === 'string' ? e.seriesSource : ''
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
        .filter(function (s) {
          return s && (s.seriesId != null || (Array.isArray(s.sources) && s.sources.length));
        })
        .map(function (s) {
          /* A followed series can be watched in both catalogues at once, so
           * sources is a list. Documents written before that still have a
           * single seriesId/source pair — migrate them. */
          var sources = Array.isArray(s.sources)
            ? s.sources.filter(function (x) { return x && x.seriesId != null; })
                .map(function (x) {
                  return {
                    source: typeof x.source === 'string' ? x.source : 'metron',
                    seriesId: String(x.seriesId)
                  };
                })
            : [];

          if (!sources.length && s.seriesId != null) {
            sources = [{
              source: typeof s.source === 'string' ? s.source : 'metron',
              seriesId: String(s.seriesId)
            }];
          }

          return {
            id: typeof s.id === 'string' && s.id ? s.id : uid(),
            sources: sources,
            seriesName: typeof s.seriesName === 'string' ? s.seriesName : 'Unknown series',
            addedAt: typeof s.addedAt === 'string' ? s.addedAt : nowISO(),
            lastCheckedAt: typeof s.lastCheckedAt === 'string' ? s.lastCheckedAt : null
          };
        });
    }

    if (Array.isArray(parsed.seriesOrder)) {
      clean.seriesOrder = parsed.seriesOrder.filter(function (n) {
        return typeof n === 'string' && n;
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
      seriesOrder: data.seriesOrder.slice(),
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
      sourceId: typeof fields.sourceId === 'string' ? fields.sourceId : null,
      coverUrl: typeof fields.coverUrl === 'string' ? fields.coverUrl : '',
      issueNumber: fields.issueNumber != null ? String(fields.issueNumber) : ''
    };
    // Added straight to Read? Then it was finished now.
    if (entry.status === 'read') entry.dateRead = nowISO();

    data.entries.push(entry);
    changed();
    return entry;
  }

  /* Importing a series can mean a hundred issues at once. Adding them one at
   * a time would fire a re-render and a Drive sync per issue; this does the
   * lot in a single change. Returns how many were actually added. */
  function addMany(list) {
    var added = 0;
    var order = nextMaxSortOrder();

    (list || []).forEach(function (fields) {
      var title = String(fields.title || '').trim();
      if (!title) return;

      order += 1;
      var entry = {
        id: uid(),
        title: title,
        series: String(fields.series || '').trim(),
        status: STATUSES.indexOf(fields.status) !== -1 ? fields.status : 'next',
        releaseDate: isDateString(fields.releaseDate) ? fields.releaseDate : null,
        notes: String(fields.notes || '').trim(),
        dateAdded: nowISO(),
        dateRead: null,
        sortOrder: order,
        sourceId: typeof fields.sourceId === 'string' ? fields.sourceId : null,
        coverUrl: typeof fields.coverUrl === 'string' ? fields.coverUrl : '',
        issueNumber: fields.issueNumber != null ? String(fields.issueNumber) : '',
        seriesId: fields.seriesId != null ? String(fields.seriesId) : '',
        seriesSource: typeof fields.seriesSource === 'string' ? fields.seriesSource : ''
      };
      if (entry.status === 'read') entry.dateRead = nowISO();

      data.entries.push(entry);
      added += 1;
    });

    if (added) changed();
    return added;
  }

  /* Fill in cover art (and issue numbers) on entries that predate covers
   * being stored. Matched by caller; applied here in one write. */
  function applyPatches(patches) {
    var applied = 0;
    (patches || []).forEach(function (patch) {
      var entry = find(patch.id);
      if (!entry) return;
      var touched = false;
      if (patch.coverUrl && !entry.coverUrl) { entry.coverUrl = patch.coverUrl; touched = true; }
      if (patch.issueNumber && !entry.issueNumber) { entry.issueNumber = patch.issueNumber; touched = true; }
      if (patch.sourceId && !entry.sourceId) { entry.sourceId = patch.sourceId; touched = true; }
      if (touched) applied += 1;
    });
    if (applied) changed();
    return applied;
  }

  function update(id, fields) {
    var entry = find(id);
    if (!entry) return null;

    var wasStatus = entry.status;

    if ('title' in fields) entry.title = String(fields.title || '').trim();
    if ('series' in fields) entry.series = String(fields.series || '').trim();
    if ('notes' in fields) entry.notes = String(fields.notes || '').trim();
    if ('coverUrl' in fields) entry.coverUrl = String(fields.coverUrl || '');
    if ('issueNumber' in fields) entry.issueNumber = String(fields.issueNumber || '');
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

  /* Mark a whole series read in one write, rather than one change event per
   * issue (which would fire a Drive sync each time).
   *
   * Issues dated in the future are skipped: you can't have read something
   * that hasn't come out, and silently marking them would hide them from the
   * release notifications they exist for. Returns how many were changed. */
  function markSeriesRead(seriesName, today) {
    var changedCount = 0;
    data.entries.forEach(function (entry) {
      if ((entry.series || '') !== seriesName) return;
      if (entry.status === 'read') return;
      if (entry.releaseDate && today && entry.releaseDate > today) return;
      entry.status = 'read';
      entry.dateRead = nowISO();
      changedCount += 1;
    });
    if (changedCount) changed();
    return changedCount;
  }

  function remove(id) {
    var before = data.entries.length;
    data.entries = data.entries.filter(function (e) { return e.id !== id; });
    if (data.entries.length !== before) changed();
  }

  function seriesKey(entry) {
    return (entry.series || '').trim() || 'Other';
  }

  function issueNumberOf(entry) {
    var raw = entry.issueNumber;
    if (!raw) {
      var match = String(entry.title || '').match(/#\s*([0-9]+(?:\.[0-9]+)?)/);
      raw = match ? match[1] : '';
    }
    var value = parseFloat(raw);
    return isNaN(value) ? Infinity : value;
  }

  function getSeriesOrder() {
    return data.seriesOrder.slice();
  }

  /* Every series currently tracked, in your arranged order — arranged ones
   * first in their order, then the rest as they naturally fall. */
  function allSeriesOrdered() {
    var seen = {};
    var natural = [];
    data.entries.forEach(function (entry) {
      var key = seriesKey(entry);
      if (!seen[key]) { seen[key] = true; natural.push(key); }
    });

    var ordered = data.seriesOrder.filter(function (name) { return seen[name]; });
    natural.forEach(function (name) {
      if (ordered.indexOf(name) === -1) ordered.push(name);
    });
    return ordered;
  }

  /* Move one series to sit where another currently is, leaving every other
   * series exactly where it was. Reordering on one list therefore doesn't
   * scramble the order seen on the others. */
  function moveSeriesBefore(name, targetName) {
    var order = allSeriesOrdered();
    var from = order.indexOf(name);
    if (from === -1) return false;

    order.splice(from, 1);
    var to = targetName == null ? order.length : order.indexOf(targetName);
    if (to === -1) to = order.length;
    order.splice(to, 0, name);

    data.seriesOrder = order;
    changed();
    return true;
  }

  /* Remove a whole series: every issue of it, and the follow if there is one.
   * Returns what was removed so the UI can say. */
  function removeSeries(seriesName) {
    var before = data.entries.length;
    data.entries = data.entries.filter(function (e) {
      return seriesKey(e) !== seriesName;
    });
    var removedIssues = before - data.entries.length;

    var subsBefore = data.subscriptions.length;
    data.subscriptions = data.subscriptions.filter(function (s) {
      return s.seriesName !== seriesName;
    });
    var unfollowed = subsBefore - data.subscriptions.length;

    if (removedIssues || unfollowed) changed();
    return { issues: removedIssues, unfollowed: unfollowed };
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
      return s.sources.some(function (x) { return x.seriesId === String(seriesId); });
    });
  }

  function subscriptionByName(seriesName) {
    for (var i = 0; i < data.subscriptions.length; i++) {
      if (data.subscriptions[i].seriesName === seriesName) return data.subscriptions[i];
    }
    return null;
  }

  function addSubscription(fields) {
    if (!fields || fields.seriesId == null) return null;
    if (isSubscribed(fields.seriesId)) return null;

    var sub = {
      id: uid(),
      sources: [{ source: fields.source || 'metron', seriesId: String(fields.seriesId) }],
      seriesName: String(fields.seriesName || 'Unknown series'),
      addedAt: nowISO(),
      lastCheckedAt: null
    };
    data.subscriptions.push(sub);
    changed();
    return sub;
  }

  /* Attach the same series in the other catalogue, so an issue announced in
   * either one gets picked up. */
  function addSubscriptionSource(subscriptionId, source, seriesId) {
    var sub = null;
    data.subscriptions.forEach(function (s) { if (s.id === subscriptionId) sub = s; });
    if (!sub || seriesId == null) return false;

    var exists = sub.sources.some(function (x) {
      return x.source === source && x.seriesId === String(seriesId);
    });
    if (exists) return false;

    sub.sources.push({ source: source, seriesId: String(seriesId) });
    changed();
    return true;
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
    // Pure: cleans a document into the canonical shape without touching state.
    // Lets two documents be compared without key order mattering.
    normalizeDoc: normalize,
    subscribe: subscribe,
    onLocalChange: onLocalChange,
    snapshot: snapshot,
    replaceAll: replaceAll,
    updatedAt: updatedAt,
    all: all,
    find: find,
    byStatus: byStatus,
    add: add,
    addMany: addMany,
    applyPatches: applyPatches,
    update: update,
    markRead: markRead,
    markSeriesRead: markSeriesRead,
    remove: remove,
    moveInQueue: moveInQueue,
    getSeriesOrder: getSeriesOrder,
    allSeriesOrdered: allSeriesOrdered,
    moveSeriesBefore: moveSeriesBefore,
    removeSeries: removeSeries,
    getSubscriptions: getSubscriptions,
    isSubscribed: isSubscribed,
    subscriptionByName: subscriptionByName,
    addSubscription: addSubscription,
    addSubscriptionSource: addSubscriptionSource,
    removeSubscription: removeSubscription,
    hasSourceId: hasSourceId,
    getPushSubscriptions: getPushSubscriptions,
    addPushSubscription: addPushSubscription,
    removePushSubscription: removePushSubscription
  };
})();
