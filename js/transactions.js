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

  global.TX = { fingerprint, validate, addTransaction, updateTransaction, deleteTransaction, setSettlement, ensureProduct };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TX;
  }
})(typeof window !== 'undefined' ? window : globalThis);
