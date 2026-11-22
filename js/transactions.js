/* =========================================================================
   transactions.js — سجل الحركات: إضافة / تعديل / حذف مع سجل تدقيق
   Every mutation is audited (before/after snapshot) so historical records
   are never modified silently.
   ========================================================================= */
(function (global) {
  'use strict';
  const { comboKey, cleanStr, toNumberOrRaw, isComboComplete, round6 } = global.CALC;

  /* fingerprint for duplicate detection on re-import (NOT stored as id:
     legitimate manual re-entries with identical fields are still allowed
     but flagged during import preview) */
  function fingerprint(t) {
    return [cleanStr(t.date), cleanStr(t.quality), toNumberOrRaw(t.gsm), toNumberOrRaw(t.size),
      cleanStr(t.customer), cleanStr(t.permitNo), Number(t.addQty) || 0, Number(t.outQty) || 0,
      cleanStr(t.settlement)].join('||');
  }

  function validate(t) {
    const errors = [];
    if (!cleanStr(t.date)) errors.push({ field: 'date', msg: 'التاريخ مطلوب' });
    if (!cleanStr(t.quality)) errors.push({ field: 'quality', msg: 'اسم الصنف مطلوب' });
    if (!cleanStr(t.customer)) errors.push({ field: 'customer', msg: 'اسم العميل أو الجهة مطلوب' });
    const a = Number(t.addQty) || 0;
    const o = Number(t.outQty) || 0;
    if (a < 0 || o < 0) errors.push({ field: 'qty', msg: 'الكمية لا يمكن أن تكون سالبة' });
    if (a > 0 && o > 0) errors.push({ field: 'qty', msg: 'لا يمكن إدخال إضافة وصرف معًا في نفس الحركة' });
    if (a === 0 && o === 0) errors.push({ field: 'qty', msg: 'يجب إدخال كمية (إضافة أو صرف)' });
    if (!isComboComplete(t.quality, t.gsm, t.size)) {
      errors.push({ field: 'gsm', msg: 'الجرام والمقاس مطلوبان لحساب الرصيد' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStr(t.date))) {
      errors.push({ field: 'date', msg: 'صيغة التاريخ غير صحيحة' });
    }
    return errors;
  }

  /* ensure the product master contains this combo (auto-register on save) */
  function ensureProduct(t, source) {
    const combo = comboKey(t.quality, t.gsm, t.size);
    return global.DB.getAll('products').then((prods) => {
      const found = prods.find((p) => p.combo === combo);
      if (found) return found;
      const p = {
        quality: cleanStr(t.quality),
        gsm: toNumberOrRaw(t.gsm),
        size: toNumberOrRaw(t.size),
        combo,
        source: source || 'manual',
        createdAt: new Date().toISOString(),
      };
      return global.DB.add('products', p).then((id) => Object.assign(p, { id }));
    });
  }

  function addTransaction(t) {
    const errors = validate(t);
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    const row = {
      date: cleanStr(t.date),
      quality: cleanStr(t.quality),
      gsm: toNumberOrRaw(t.gsm),
      size: toNumberOrRaw(t.size),
      customer: cleanStr(t.customer),
      permitNo: cleanStr(t.permitNo),
      addQty: round6(Number(t.addQty) || 0),
      outQty: round6(Number(t.outQty) || 0),
      weight: t.weight === '' || t.weight === null || t.weight === undefined ? null : (Number(t.weight) || null),
      settlement: cleanStr(t.settlement),
      notes: cleanStr(t.notes),
      /* optional movement-group id: children of one multi-size movement share it */
      groupId: cleanStr(t.groupId) || null,
      source: t.source || 'manual',
      excelRow: t.excelRow ?? null,
      fingerprint: fingerprint(t),
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    return global.DB.add('transactions', row)
      .then((id) => Promise.all([
        global.DB.logAudit({ entity: 'transaction', action: 'add', entityId: id, before: null, after: row }),
        ensureProduct(row, 'manual'),
      ]).then(() => Object.assign(row, { id })));
  }

  function updateTransaction(id, changes) {
    return global.DB.get('transactions', id).then((before) => {
      if (!before) throw new Error('الحركة غير موجودة');
      const merged = Object.assign({}, before, changes);
      const errors = validate(merged);
      if (errors.length) return Promise.reject({ type: 'validation', errors });
      const after = Object.assign({}, before, {
        date: cleanStr(merged.date),
        quality: cleanStr(merged.quality),
        gsm: toNumberOrRaw(merged.gsm),
        size: toNumberOrRaw(merged.size),
        customer: cleanStr(merged.customer),
        permitNo: cleanStr(merged.permitNo),
        addQty: round6(Number(merged.addQty) || 0),
        outQty: round6(Number(merged.outQty) || 0),
        weight: merged.weight === '' || merged.weight === null || merged.weight === undefined ? null : (Number(merged.weight) || null),
        settlement: cleanStr(merged.settlement),
        notes: cleanStr(merged.notes),
        fingerprint: fingerprint(merged),
        updatedAt: new Date().toISOString(),
      });
      delete after.id;
      return global.DB.put('transactions', Object.assign({ id }, after))
        .then(() => Promise.all([
          global.DB.logAudit({ entity: 'transaction', action: 'edit', entityId: id, before, after }),
          ensureProduct(after, 'manual'),
        ]).then(() => Object.assign(after, { id })));
    });
  }

  function deleteTransaction(id) {
    return global.DB.get('transactions', id).then((before) => {
      if (!before) throw new Error('الحركة غير موجودة');
      return global.DB.del('transactions', id)
        .then(() => global.DB.logAudit({ entity: 'transaction', action: 'delete', entityId: id, before, after: null }));
    });
  }

  /* set settlement status (تصفيه) without touching quantities */
  function setSettlement(id, value) {
    const v = (value === 'غ' || value === 'ض') ? value : '';
    return updateTransaction(id, { settlement: v });
  }

  /* ---------------- movement groups (multi-size movements) ----------------
     A movement = N child transactions sharing groupId. Replace and delete
     run inside ONE IndexedDB transaction (all work happens inside the
     getAll success handler, so the transaction can never auto-commit early
     or leave a movement half-updated). */

  function normalizeRow(t) {
    return {
      date: cleanStr(t.date),
      quality: cleanStr(t.quality),
      gsm: toNumberOrRaw(t.gsm),
      size: toNumberOrRaw(t.size),
      customer: cleanStr(t.customer),
      permitNo: cleanStr(t.permitNo),
      addQty: round6(Number(t.addQty) || 0),
      outQty: round6(Number(t.outQty) || 0),
      weight: t.weight === '' || t.weight === null || t.weight === undefined ? null : (Number(t.weight) || null),
      settlement: cleanStr(t.settlement),
      notes: cleanStr(t.notes),
      groupId: cleanStr(t.groupId) || null,
      source: t.source || 'manual',
      excelRow: t.excelRow ?? null,
      fingerprint: fingerprint(t),
      updatedAt: null,
    };
  }

  function childRowOf(t, groupId) {
    const r = normalizeRow(t);
    r.groupId = groupId;
    return r;
  }

  function replaceMovement(existingGroup, pendingRows) {
    if (!existingGroup || !existingGroup.groupId) {
      return Promise.reject(new Error('لا يمكن تعديل حركة قديمة بهذه الطريقة / legacy rows use the simple editor'));
    }
    const groupId = existingGroup.groupId;
    const rows = pendingRows.map((t) => childRowOf(t, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    return global.DB.open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(['transactions', 'products', 'audit'], 'readwrite');
      const txStore = t.objectStore('transactions');
      let removed = 0;
      const getAllReq = txStore.getAll();
      getAllReq.onsuccess = () => {
        const children = (getAllReq.result || []).filter((r) => r.groupId === groupId);
        removed = children.length;
        children.forEach((c) => txStore.delete(c.id));
        rows.forEach((r) => txStore.add(r));
        /* product master top-up for any new combo used by the movement */
        const prodStore = t.objectStore('products');
        rows.forEach((r) => {
          const combo = comboKey(r.quality, r.gsm, r.size);
          const g = prodStore.index('combo').get(combo);
          g.onsuccess = () => {
            if (!g.result) {
              prodStore.add({ quality: r.quality, gsm: r.gsm, size: r.size, combo,
                source: 'manual', createdAt: new Date().toISOString() });
            }
          };
        });
        t.objectStore('audit').add({
          entity: 'movement', action: 'edit', entityId: null,
          before: children, after: rows, at: new Date().toISOString(),
        });
      };
      t.oncomplete = () => resolve({ removed, added: rows.length });
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }

  function deleteMovement(group) {
    if (group.groupId) {
      return global.DB.open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(['transactions', 'audit'], 'readwrite');
        const txStore = t.objectStore('transactions');
        let removed = 0;
        const getAllReq = txStore.getAll();
        getAllReq.onsuccess = () => {
          const children = (getAllReq.result || []).filter((r) => r.groupId === group.groupId);
          removed = children.length;
          children.forEach((c) => txStore.delete(c.id));
          t.objectStore('audit').add({
            entity: 'movement', action: 'delete', entityId: null,
            before: children, after: null, at: new Date().toISOString(),
          });
        };
        t.oncomplete = () => resolve({ removed });
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      }));
    }
    /* legacy single row */
    return deleteTransaction(group.legacyId);
  }

  /* =======================================================================
     ISSUE DOCUMENTS (أذون الصرف) — independent tax / non-tax numbering,
     duplicate protection, hard availability check and atomic writes.
     A document = a movement group whose rows carry outQty; its snapshot is
     the stored rows themselves, so later inventory changes can never alter
     an already-saved document.
     ======================================================================= */

  /* sequence keys: 'ض' (ضريبي) and 'غ' (غير ضريبي) are fully independent */
  const SEQ_KEYS = { 'ض': 'docSeqTax', 'غ': 'docSeqNontax' };
  const CLS_LABEL = { 'ض': 'ضريبي', 'غ': 'غير ضريبي' };

  function newGroupId() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }

  /* largest numeric document number already used within one classification */
  function numericDocMax(rows, cls) {
    let max = 0;
    for (const r of rows) {
      if ((Number(r.outQty) || 0) <= 0) continue;
      if ((r.settlement || '') !== cls) continue;
      const n = parseInt(String(r.permitNo || '').trim(), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  /**
   * Next suggested document number for both classifications.
   * First run: initialized from the actual historical issue documents
   * (max numeric permitNo per classification + 1) and persisted, so
   * refreshing the browser never resets numbering. If history ever grows
   * beyond the stored counter (restore/import), it self-heals upward.
   */
  async function nextDocNumbers() {
    const all = await global.DB.getAll('transactions');
    const out = {};
    for (const cls of ['ض', 'غ']) {
      const key = SEQ_KEYS[cls];
      const stored = await global.DB.getSetting(key, null);
      const histMax = numericDocMax(all, cls);
      const n = Number(stored);
      if (stored === null || stored === undefined || stored === '' || !Number.isFinite(n)) {
        const seq = Math.max(1, histMax + 1);
        await global.DB.setSetting(key, seq);
        out[cls] = seq;
      } else if (histMax + 1 > n) {
        await global.DB.setSetting(key, histMax + 1);
        out[cls] = histMax + 1;
      } else {
        out[cls] = n;
      }
    }
    return { tax: out['ض'], nontax: out['غ'] };
  }

  /**
   * Availability gate: aggregate demand per (product,gsm,weight,size) bucket
   * must never exceed the stock computed WITHOUT the excluded group's rows
   * (so editing a document doesn't collide with its own old rows).
   * Negative stock is prevented — never silently allowed.
   */
  function checkIssueAvailability(allTx, pendingRows, excludeGroupId) {
    const avail = new Map();
    for (const r of allTx) {
      if (excludeGroupId && r.groupId === excludeGroupId) continue;
      const k = global.CALC.comboKeyWOf(r);
      avail.set(k, (avail.get(k) || 0) + (Number(r.addQty) || 0) - (Number(r.outQty) || 0));
    }
    const demand = new Map();
    for (const r of pendingRows) {
      const k = global.CALC.comboKeyWOf(r);
      demand.set(k, { qty: (demand.get(k) || { qty: 0 }).qty + (Number(r.outQty) || 0), r });
    }
    const errors = [];
    for (const [k, d] of demand) {
      const free = avail.get(k) || 0;
      if (d.qty - free > 0) {
        const w = d.r.weight == null ? '—' : d.r.weight;
        errors.push({
          field: 'balance',
          msg: `الرصيد لا يكفي: ${d.r.quality} / ${d.r.gsm} جرام / وزن الرولة ${w} / مقاس ${d.r.size} — المتاح ${free} والمطلوب ${d.qty}`,
        });
      }
    }
    return errors;
  }

  /* product-master top-up queued inside an open atomic transaction */
  function queueProductTopUp(prodStore, rows) {
    for (const r of rows) {
      const combo = comboKey(r.quality, r.gsm, r.size);
      const g = prodStore.index('combo').get(combo);
      g.onsuccess = () => {
        if (!g.result) {
          prodStore.add({ quality: r.quality, gsm: r.gsm, size: r.size, combo,
            source: 'manual', createdAt: new Date().toISOString() });
        }
      };
    }
  }

  function bumpSeqInTx(settingsStore, cls, savedNo) {
    const seqKey = SEQ_KEYS[cls];
    if (!seqKey) return;
    const n = parseInt(String(savedNo || '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return; /* non-numeric numbers don't move the counter */
    const getReq = settingsStore.get(seqKey);
    getReq.onsuccess = () => {
      const cur = getReq.result ? Number(getReq.result.value) : 1;
      if (n >= cur) settingsStore.put({ key: seqKey, value: n + 1 });
    };
  }

  /* ---------- production save (إضافة إنتاج): one group, atomic ---------- */
  function saveProduction(header, sizes) {
    const groupId = newGroupId();
    const rows = sizes.map((s) => childRowOf({
      date: header.date,
      quality: header.quality,
      gsm: header.gsm,
      size: s.size,
      customer: 'الإنتاج',
      permitNo: '',
      addQty: s.qty,
      outQty: 0,
      weight: header.weight,
      settlement: '',
      notes: header.notes || '',
      source: header.source || 'manual',
    }, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    return global.DB.atomic(['transactions', 'products', 'audit'], (t) => {
      const txStore = t.objectStore('transactions');
      rows.forEach((r) => txStore.add(r));
      queueProductTopUp(t.objectStore('products'), rows);
      t.objectStore('audit').add({
        entity: 'movement', action: 'add', entityId: null, before: null, after: rows,
        at: new Date().toISOString(),
        details: `إضافة إنتاج: ${rows[0].quality} / ${rows[0].gsm} جرام / وزن ${header.weight} — ${rows.length} مقاس`,
      });
      return { groupId, added: rows.length };
    });
  }

  /* ---------- issue document save (صرف للعملاء): multi-group, atomic ---------- */
  function docRowsOf(doc, groupId) {
    const rows = [];
    for (const g of doc.groups) {
      for (const s of g.sizes) {
        rows.push(childRowOf({
          date: doc.date,
          quality: g.quality,
          gsm: g.gsm,
          size: s.size,
          customer: doc.customer,
          permitNo: doc.docNo,
          addQty: 0,
          outQty: s.qty,
          weight: g.weight,
          settlement: doc.classification,
          notes: doc.notes || '',
          source: doc.source || 'manual',
        }, groupId));
      }
    }
    return rows;
  }

  function saveIssueDocument(doc) {
    const groupId = newGroupId();
    const rows = docRowsOf(doc, groupId);
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (!String(doc.docNo || '').trim()) {
      errors.push({ field: 'docNo', msg: 'رقم إذن الصرف مطلوب' });
    }
    if (!doc.groups || !doc.groups.length) {
      errors.push({ field: 'groups', msg: 'أضف مجموعة واحدة على الأقل' });
    }
    if (['ض', 'غ'].indexOf(doc.classification) < 0) {
      errors.push({ field: 'classification', msg: 'اختر التصنيف (ضريبي / غير ضريبي)' });
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    /* everything (duplicate check + availability + rows + counter + audit)
       happens inside ONE IndexedDB transaction: no partially saved document */
    return global.DB.atomic(['transactions', 'products', 'audit', 'settings'], (t, setFail) => {
      const txStore = t.objectStore('transactions');
      const getAllReq = txStore.getAll();
      getAllReq.onsuccess = () => {
        const all = getAllReq.result || [];
        const docNoNorm = String(doc.docNo).trim();
        const allErrors = [];
        const taken = all.some((r) => (Number(r.outQty) || 0) > 0
          && (r.settlement || '') === doc.classification
          && String(r.permitNo || '').trim() === docNoNorm);
        if (taken) {
          allErrors.push({ field: 'docNo',
            msg: `رقم الإذن "${docNoNorm}" مستخدم مسبقًا في تصنيف ${CLS_LABEL[doc.classification]} — اختر رقمًا آخر` });
        }
        allErrors.push(...checkIssueAvailability(all, rows, null));
        if (allErrors.length) { setFail({ type: 'validation', errors: allErrors }); t.abort(); return; }
        rows.forEach((r) => txStore.add(r));
        queueProductTopUp(t.objectStore('products'), rows);
        bumpSeqInTx(t.objectStore('settings'), doc.classification, docNoNorm);
        t.objectStore('audit').add({
          entity: 'movement', action: 'add', entityId: null, before: null, after: rows,
          at: new Date().toISOString(),
          details: `إذن صرف ${docNoNorm} (${CLS_LABEL[doc.classification]}) — العميل: ${doc.customer} — ${rows.length} مقاس`,
        });
      };
      return { groupId, added: rows.length };
    });
  }

  /* ---------- issue document EDIT: replace atomically with the same gates ---------- */
  function replaceIssueDocument(existingGroup, pendingRows, classification, docNo) {
    if (!existingGroup || !existingGroup.groupId) {
      return Promise.reject(new Error('لا يمكن تعديل حركة قديمة بهذه الطريقة / legacy rows use the simple editor'));
    }
    const groupId = existingGroup.groupId;
    const rows = pendingRows.map((t) => childRowOf(t, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (!String(docNo || '').trim()) errors.push({ field: 'docNo', msg: 'رقم إذن الصرف مطلوب' });
    if (['ض', 'غ'].indexOf(classification) < 0) {
      errors.push({ field: 'classification', msg: 'اختر التصنيف (ضريبي / غير ضريبي)' });
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    return global.DB.atomic(['transactions', 'products', 'audit', 'settings'], (t, setFail) => {
      const txStore = t.objectStore('transactions');
      const getAllReq = txStore.getAll();
      getAllReq.onsuccess = () => {
        const all = getAllReq.result || [];
        const children = all.filter((r) => r.groupId === groupId);
        const docNoNorm = String(docNo).trim();
        const allErrors = [];
        const taken = all.some((r) => (Number(r.outQty) || 0) > 0
          && r.groupId !== groupId
          && (r.settlement || '') === classification
          && String(r.permitNo || '').trim() === docNoNorm);
        if (taken) {
          allErrors.push({ field: 'docNo',
            msg: `رقم الإذن "${docNoNorm}" مستخدم مسبقًا في تصنيف ${CLS_LABEL[classification]} — اختر رقمًا آخر` });
        }
        allErrors.push(...checkIssueAvailability(all, rows, groupId));
        if (allErrors.length) { setFail({ type: 'validation', errors: allErrors }); t.abort(); return; }
        children.forEach((c) => txStore.delete(c.id));
        rows.forEach((r) => txStore.add(r));
        queueProductTopUp(t.objectStore('products'), rows);
        bumpSeqInTx(t.objectStore('settings'), classification, docNoNorm);
        t.objectStore('audit').add({
          entity: 'movement', action: 'edit', entityId: null, before: children, after: rows,
          at: new Date().toISOString(),
          details: `تعديل إذن صرف ${docNoNorm} (${CLS_LABEL[classification]}) — ${rows.length} مقاس`,
        });
      };
      return { removed: null, added: rows.length, groupId };
    });
  }

  global.TX = { fingerprint, validate, addTransaction, updateTransaction, deleteTransaction,
    setSettlement, ensureProduct, replaceMovement, deleteMovement,
    nextDocNumbers, checkIssueAvailability, saveProduction, saveIssueDocument,
    replaceIssueDocument, CLS_LABEL, SEQ_KEYS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TX;
  }
})(typeof window !== 'undefined' ? window : globalThis);
