/* =========================================================================
   calculations.js — إعادة إنتاج منطق الإكسل الأصلي
   -------------------------------------------------------------------------
   LOGIC CONFIRMED FROM THE UPLOADED FILE "الرصيد 2025.xlsx":

   Sheet "انتاج و مبيعات" (24,392 data rows):
     J (unnamed net column) =  =H-I          →  اضافه - صرف per row
     K 'تصفيه'               → settlement annotation ('غ' / 'ض') — NOT
                               part of any balance formula (verified: the
                               SUMIFS references only D, F, G and J).
     A 'p'                   → date, B 'الوزن' → weight (kg, optional)

   Sheet "الرصيد" (917 product rows):
     D 'رصيد المخزن' =
         =SUMIFS('انتاج و مبيعات'!$J:$J, ...,!$D:$D, A_row,   ← اسم الصنف
                                          ...,!$F:$F, B_row,   ← الجرام GSM
                                          ...,!$G:$G, C_row)   ← المقاس Size
       ⇒ Balance(product) = Σ(اضافه − صرف) over ALL rows matching
         (اسم الصنف, الجرام, المقاس).
     E 'الوزن' = (C*D)*7.5
       ⇒ Weight(product) = Size × Balance × 7.5

   Validation performed on the real file: recomputing all 917 balances
   with this logic matched Excel's cached values with ZERO mismatches,
   and E matched Size×Balance×7.5 for all rows.

   There is no separate "opening balance" record type: opening balances
   are ordinary transaction rows with customer 'رصيد اول المدة' and a
   quantity in اضافه, so they flow into the same SUM.
   ========================================================================= */
(function (global) {
  'use strict';

  const DEFAULT_WEIGHT_FACTOR = 7.5;

  /* ---- normalization helpers (Excel SUMIFS-compatible matching) ---- */

  function cleanStr(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  /* Excel numeric criteria match numeric cells; blanks never match numbers.
     We normalize GSM/Size to numbers when possible, else keep raw string. */
  function toNumberOrRaw(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!isNaN(n) && String(v).trim() !== '') return n;
    return cleanStr(v);
  }

  /* unique key for a product / transaction combination */
  function comboKey(quality, gsm, size) {
    return cleanStr(quality) + '||' + String(toNumberOrRaw(gsm)) + '||' + String(toNumberOrRaw(size));
  }
  function comboKeyOf(txRow) {
    return comboKey(txRow.quality, txRow.gsm, txRow.size);
  }
  function isComboComplete(quality, gsm, size) {
    return cleanStr(quality) !== '' && toNumberOrRaw(gsm) !== null && toNumberOrRaw(size) !== null;
  }

  /* ---- roll-weight dimension (وزن الرولة) ----
     The hierarchy is Product → GSM → Roll Weight KG → Size → Quantity, so
     two rolls with different weights are NEVER interchangeable. The weight
     lives on the existing `weight` field (Excel column B «الوزن»). Legacy
     rows without a weight form their own bucket '—' and stay untouched. */
  function weightKey(weight) {
    return weight === null || weight === undefined || weight === '' ? '—' : String(Number(weight));
  }
  function comboKeyW(quality, gsm, weight, size) {
    return comboKey(quality, gsm, size) + '||W:' + weightKey(weight);
  }
  function comboKeyWOf(txRow) {
    return comboKeyW(txRow.quality, txRow.gsm, txRow.weight, txRow.size);
  }
  /* GROUP key WITHOUT size: one issue-document group holds many sizes under
     the same (product, gsm, roll weight) — used to rebuild groups from rows */
  function comboGroupW(quality, gsm, weight) {
    return cleanStr(quality) + '||' + String(toNumberOrRaw(gsm)) + '||W:' + weightKey(weight);
  }
  function comboGroupWOf(txRow) {
    return comboGroupW(txRow.quality, txRow.gsm, txRow.weight);
  }

  /**
   * Same SUMIFS logic as computeBalances but with the roll-weight dimension:
   * grouped by (quality || gsm || size || weight).
   * @returns {Map} key → { quality, gsm, size, weight, add, out, net }
   */
  function computeBalancesByWeight(transactions) {
    const map = new Map();
    for (const t of transactions) {
      const key = comboKeyWOf(t);
      let row = map.get(key);
      if (!row) {
        row = {
          quality: cleanStr(t.quality), gsm: toNumberOrRaw(t.gsm),
          size: toNumberOrRaw(t.size), weight: (t.weight === '' || t.weight == null) ? null : Number(t.weight),
          add: 0, out: 0, net: 0,
        };
        map.set(key, row);
      }
      const a = Number(t.addQty) || 0;
      const o = Number(t.outQty) || 0;
      row.add += a;
      row.out += o;
      row.net += a - o;
    }
    for (const row of map.values()) {
      row.add = round6(row.add);
      row.out = round6(row.out);
      row.net = round6(row.net);
    }
    return map;
  }

  /* ---- the confirmed balance engine ---- */

  /**
   * Reproduces the Excel SUMIFS exactly:
   * for every transaction: net = (اضافه || 0) - (صرف || 0)
   * grouped by (quality || gsm || size).
   * @param {Array} transactions rows with {quality, gsm, size, addQty, outQty}
   * @returns {Map} key → { quality, gsm, size, add, out, net }
   */
  function computeBalances(transactions) {
    const map = new Map();
    for (const t of transactions) {
      const key = comboKeyOf(t);
      let row = map.get(key);
      if (!row) {
        row = { quality: cleanStr(t.quality), gsm: toNumberOrRaw(t.gsm), size: toNumberOrRaw(t.size), add: 0, out: 0, net: 0 };
        map.set(key, row);
      }
      const a = Number(t.addQty) || 0;
      const o = Number(t.outQty) || 0;
      row.add += a;
      row.out += o;
      row.net += a - o;
    }
    // remove float dust
    for (const row of map.values()) {
      row.add = round6(row.add);
      row.out = round6(row.out);
      row.net = round6(row.net);
    }
    return map;
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  /* الوزن = المقاس × الرصيد × 7.5  (E-column formula =(C*D)*7.5) */
  function productWeight(size, balance, factor) {
    const f = Number(factor) || DEFAULT_WEIGHT_FACTOR;
    const s = Number(size);
    if (!s || isNaN(s)) return 0;
    return round6(s * (Number(balance) || 0) * f);
  }

  /**
   * Running (chronological) balance for a report of one product.
   * Returns opening balance before `fromDate` and a per-row running net.
   */
  function openingBalance(transactions, quality, gsm, size, fromDate) {
    let net = 0;
    for (const t of transactions) {
      if (!sameCombo(t, quality, gsm, size)) continue;
      if (fromDate && String(t.date) >= String(fromDate)) continue;
      net += (Number(t.addQty) || 0) - (Number(t.outQty) || 0);
    }
    return round6(net);
  }

  function sameCombo(t, quality, gsm, size) {
    return comboKeyOf(t) === comboKey(quality, gsm, size);
  }

  /* totals used by the dashboard */
  function grandTotals(transactions) {
    let add = 0, out = 0, nAdd = 0, nOut = 0, nIncomplete = 0;
    for (const t of transactions) {
      const a = Number(t.addQty) || 0;
      const o = Number(t.outQty) || 0;
      add += a; out += o;
      if (a > 0) nAdd++;
      if (o > 0) nOut++;
      if (!isComboComplete(t.quality, t.gsm, t.size)) nIncomplete++;
    }
    return { add: round6(add), out: round6(out), net: round6(add - out), nAdd, nOut, nIncomplete };
  }

  global.CALC = {
    DEFAULT_WEIGHT_FACTOR,
    cleanStr, toNumberOrRaw, comboKey, comboKeyOf, isComboComplete,
    weightKey, comboKeyW, comboKeyWOf, comboGroupW, comboGroupWOf, computeBalancesByWeight,
    computeBalances, productWeight, openingBalance, sameCombo,
    grandTotals, round6,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CALC;
})(typeof window !== 'undefined' ? window : globalThis);
