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

  global.TX = { fingerprint, validate, addTransaction, updateTransaction, deleteTransaction,
    setSettlement, ensureProduct, replaceMovement, deleteMovement };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TX;
  }
})(typeof window !== 'undefined' ? window : globalThis);
