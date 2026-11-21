/* =========================================================================
   database.js — IndexedDB storage layer
   نظام إدارة رصيد المخزن — طبقة قاعدة البيانات المحلية (IndexedDB)
   -------------------------------------------------------------------------
   Stores:
     products     { id, quality, gsm, size, source, createdAt }  (id auto)
     transactions { id, date, quality, gsm, size, customer, permitNo,
                    addQty, outQty, weight, settlement, notes,
                    source, excelRow, fingerprint, createdAt, updatedAt }
     audit        { id, entity, action, entityId, before, after, at, details }
     settings     { key, value }
   ========================================================================= */
(function (global) {
  'use strict';

  const DB_NAME = 'inventory_pwa_db';
  const DB_VERSION = 1; /* never bumped lightly: any change here MUST stay
     backward-compatible with existing user databases (see README). */

  let _db = null;
  let _openPromise = null;

  /* Typed error so the boot screen can tell the user exactly what to do. */
  function dbError(kind, message, cause) {
    const e = new Error(message);
    e.name = 'DBError';
    e.kind = kind; /* 'blocked' | 'timeout' | 'unavailable' | 'io' */
    e.cause = cause;
    return e;
  }

  function open() {
    /* one shared open attempt: concurrent callers wait on the same promise */
    if (_db) return Promise.resolve(_db);
    if (_openPromise) return _openPromise;
    _openPromise = new Promise((resolve, reject) => {
      let req;
      try {
        if (typeof indexedDB === 'undefined') {
          throw dbError('unavailable', 'IndexedDB غير متاح في هذا المتصفح / IndexedDB is not available here');
        }
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        _openPromise = null;
        reject(dbError('unavailable', 'IndexedDB غير متاح / IndexedDB is not available', err));
        return;
      }
      /* If another tab holds an older connection, the open request would
         hang forever without onblocked — one of the real causes of the
         endless "جاري التحميل" state. */
      req.onblocked = () => {
        console.warn('[db] open blocked — another tab holds the database');
      };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products')) {
          const s = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
          s.createIndex('quality', 'quality', { unique: false });
          s.createIndex('combo', 'combo', { unique: true });
        }
        if (!db.objectStoreNames.contains('transactions')) {
          const s = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('quality', 'quality', { unique: false });
          s.createIndex('combo', 'combo', { unique: false });
          s.createIndex('customer', 'customer', { unique: false });
          s.createIndex('fingerprint', 'fingerprint', { unique: false });
        }
        if (!db.objectStoreNames.contains('audit')) {
          const s = db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
          s.createIndex('at', 'at', { unique: false });
          s.createIndex('entity', 'entity', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        _db = req.result;
        _db.onversionchange = () => { /* another tab upgraded: release ours */
          try { _db.close(); } catch (e2) { /* ignore */ }
          _db = null; _openPromise = null;
        };
        resolve(_db);
      };
      req.onerror = () => {
        _openPromise = null;
        reject(dbError('io', 'فشل فتح قاعدة البيانات المحلية / Failed to open the local database', req.error));
      };
      /* hard timeout: never leave the app on the loading screen forever */
      setTimeout(() => {
        if (_db) return;
        try { req.cancel && req.cancel(); } catch (e3) { /* no-op */ }
        _openPromise = null;
        reject(dbError('timeout',
          'استغرق فتح قاعدة البيانات أكثر من 10 ثوانٍ. أغلق أي تبويبات أخرى للتطبيق ثم أعد المحاولة / Database open timed out — close other app tabs and retry'));
      }, 10000);
    });
    return _openPromise;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const st = t.objectStore(store);
      let out;
      try { out = fn(st); } catch (err) { reject(err); return; }
      const reqs = Array.isArray(out) ? out : [out];
      let done = 0;
      const results = [];
      let settled = false;
      const finish = (fn2) => { if (!settled) { settled = true; fn2(); } };
      if (reqs.length === 0) { finish(() => resolve([])); return; }
      reqs.forEach((r, i) => {
        if (!r) { done++; results[i] = undefined; return; }
        r.onsuccess = () => { results[i] = r.result; done++; if (done >= reqs.length) finish(() => resolve(Array.isArray(out) ? results : results[0])); };
        r.onerror = () => finish(() => reject(r.error));
      });
      t.onabort = () => finish(() => reject(t.error));
    }));
  }

  /* ---------- generic helpers ---------- */
  const DB = {
    open,
    getAll: (store) => tx(store, 'readonly', (st) => st.getAll()),
    get: (store, key) => tx(store, 'readonly', (st) => st.get(key)),
    count: (store) => tx(store, 'readonly', (st) => st.count()),
    put: (store, val) => tx(store, 'readwrite', (st) => st.put(val)),
    add: (store, val) => tx(store, 'readwrite', (st) => st.add(val)),
    del: (store, key) => tx(store, 'readwrite', (st) => st.delete(key)),
    clear: (store) => tx(store, 'readwrite', (st) => st.clear()),

    /* Atomic bulk import: runs inside ONE IndexedDB transaction so a failure
       rolls everything back (no partial imports). */
    bulkPut(store, items) {
      return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        const st = t.objectStore(store);
        items.forEach((it) => st.put(it));
        t.oncomplete = () => resolve(items.length);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }));
    },

    /* ---------- settings ---------- */
    getSetting(key, fallback) {
      return DB.get('settings', key).then((v) => (v === undefined ? fallback : v.value));
    },
    setSetting(key, value) {
      return DB.put('settings', { key, value });
    },

    /* ---------- audit ---------- */
    logAudit(entry) {
      return DB.add('audit', Object.assign({ at: new Date().toISOString() }, entry));
    },
    getAudit(limit) {
      return DB.getAll('audit').then((rows) => {
        rows.sort((a, b) => (a.at < b.at ? 1 : -1));
        return limit ? rows.slice(0, limit) : rows;
      });
    },

    /* wipe everything (used only from explicit "reset" in settings,
       requires typed confirmation in the UI) */
    wipeAll() {
      return Promise.all([
        DB.clear('products'), DB.clear('transactions'), DB.clear('audit'),
      ]).then(() => DB.setSetting('lastImport', null));
    },
  };

  global.DB = DB;

  /* Node export for automated tests */
  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})(typeof window !== 'undefined' ? window : globalThis);
