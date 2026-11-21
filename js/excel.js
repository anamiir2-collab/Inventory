/* =========================================================================
   excel.js — استيراد وتصدير ملفات الإكسل (SheetJS)
   -------------------------------------------------------------------------
   CONFIRMED COLUMN MAPPING (from "الرصيد 2025.xlsx"):

   Sheet "الرصيد"        (header row 1: Quality | GSM | Size | رصيد المخزن | الوزن)
     A Quality      → product.quality
     B GSM          → product.gsm
     C Size         → product.size
     D رصيد المخزن   = SUMIFS(net) — recomputed by the app, not stored
     E الوزن         = Size × Balance × 7.5 — recomputed

   Sheet "انتاج و مبيعات" (header row 1: p | الوزن | رقم اذن الصرف | اسم الصنف |
                           اسم العميل | الجرام | المقاس | اضافه | صرف | (J)=H-I | تصفيه)
     A 'p'          → tx.date      (all cells are real Excel dates)
     B 'الوزن'       → tx.weight   (kg, optional; 'لاغي' → null)
     C 'رقم اذن الصرف' → tx.permitNo
     D 'اسم الصنف'   → tx.quality
     E 'اسم العميل'  → tx.customer
     F 'الجرام'      → tx.gsm
     G 'المقاس'      → tx.size
     H 'اضافه'       → tx.addQty   (blank → 0; a row never has both H and I)
     I 'صرف'         → tx.outQty   (blank → 0)
     J (unnamed)     = =H-I        → net, recomputed by the app
     K 'تصفيه'       → tx.settlement ('غ'/'ض' annotation, not part of balance)
     L, M            → empty in the whole file (ignored)

   Header synonyms are supported so slightly-edited files still import.
   ========================================================================= */
(function (global) {
  'use strict';

  const SYNONYMS_TX = {
    date: ['p', 'date (p)', 'date', 'التاريخ', 'تاريخ'],
    weight: ['الوزن', 'وزن'],
    permitNo: ['رقم اذن الصرف', 'رقم إذن الصرف', 'رقم اذن', 'اذن الصرف', 'إذن الصرف'],
    quality: ['اسم الصنف', 'الصنف', 'quality'],
    customer: ['اسم العميل', 'العميل', 'customer'],
    gsm: ['الجرام', 'جرام', 'gsm'],
    size: ['المقاس', 'مقاس', 'size'],
    addQty: ['اضافه', 'إضافة', 'اضافة'],
    outQty: ['صرف', 'منصرف', 'الصرف'],
    settlement: ['تصفيه', 'تصفية'],
  };
  const SYNONYMS_PROD = {
    quality: ['quality', 'اسم الصنف', 'الصنف'],
    gsm: ['gsm', 'الجرام', 'جرام'],
    size: ['size', 'المقاس', 'مقاس'],
    balance: ['رصيد المخزن'],
    weight: ['الوزن'],
  };

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[\u064B-\u0652\u0670]/g, '')  // strip diacritics
      .replace(/[\u0622\u0623\u0625]/g, '\u0627') // آأإ → ا
      .replace(/\u0649/g, '\u064A')           // ى → ي
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function findSheet(wb, mustContain) {
    for (const name of wb.SheetNames) {
      if (norm(name).includes(norm(mustContain))) return wb.Sheets[name];
    }
    return null;
  }

  function matchHeader(header, synonyms) {
    const h = norm(header);
    if (!h) return false;
    return synonyms.some((s) => h === norm(s));
  }

  /* map a header row (array of cells) to field names */
  function mapColumns(headerCells, synonyms) {
    const map = {};
    headerCells.forEach((cell, idx) => {
      for (const field of Object.keys(synonyms)) {
        if (map[field] === undefined && matchHeader(cell, synonyms[field])) {
          map[field] = idx;
        }
      }
    });
    return map;
  }

  /* find the header row: first row whose cells match at least 3 fields */
  function findHeaderRow(ws, synonyms, minMatches) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 25); r++) {
      const cells = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        cells.push(ws[addr] ? ws[addr].v : null);
      }
      const m = mapColumns(cells, synonyms);
      if (Object.keys(m).length >= (minMatches || 3)) return { row: r, map: m, width: range.e.c - range.s.c + 1 };
    }
    return null;
  }

  function excelDateToStr(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) {
      const y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    if (typeof v === 'number') { // Excel serial
      const dc = new Date(Math.round((v - 25569) * 86400 * 1000));
      const y = dc.getUTCFullYear(), m = dc.getUTCMonth() + 1, d = dc.getUTCDate();
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const s = String(v).trim();
    let m1 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
    let m2 = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
    return s;
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  function cleanStr(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function isVoid(v) {
    const s = norm(v);
    return s === 'لاغي' || s === 'لاغى' || s === 'laghy';
  }

  /**
   * Parse the uploaded workbook into products + transactions.
   * @param {object} wb SheetJS workbook (cellDates:true recommended)
   * @returns {{products, transactions, stats}}
   */
  function parseWorkbook(wb) {
    const stats = {
      sheets: wb.SheetNames.slice(),
      prodRows: 0, txRows: 0,
      skippedEmptyTx: 0, voidTx: 0, incompleteTx: 0,
      balanceSheetFound: false, txSheetFound: false,
      warnings: [],
    };

    /* ---------- sheet الرصيد → product master ---------- */
    const products = [];
    const seenCombos = new Set();
    let prodWs = findSheet(wb, 'الرصيد') || findSheet(wb, 'رصيد') || findSheet(wb, 'balance');
    if (prodWs) {
      const hdr = findHeaderRow(prodWs, SYNONYMS_PROD, 3);
      if (hdr) {
        stats.balanceSheetFound = true;
        const range = XLSX.utils.decode_range(prodWs['!ref']);
        for (let r = hdr.row + 1; r <= range.e.r; r++) {
          const get = (col) => (col === undefined ? null : (prodWs[XLSX.utils.encode_cell({ r, c: range.s.c + col })] || {}).v);
          const quality = get(hdr.map.quality);
          const gsm = get(hdr.map.gsm);
          const size = get(hdr.map.size);
          if (cleanStr(quality) === '' && (gsm === null || gsm === undefined || gsm === '') && (size === null || size === undefined || size === '')) continue;
          const combo = global.CALC.comboKey(quality, gsm, size);
          if (seenCombos.has(combo)) { stats.warnings.push(`صف مكرر في ورقة الرصيد تم تجاهله: ${cleanStr(quality)} / ${gsm} / ${size}`); continue; }
          seenCombos.add(combo);
          products.push({
            quality: cleanStr(quality),
            gsm: global.CALC.toNumberOrRaw(gsm),
            size: global.CALC.toNumberOrRaw(size),
            combo,
            source: 'excel',
            refBalance: typeof get(hdr.map.balance) === 'number' ? get(hdr.map.balance) : null,
            refWeight: typeof get(hdr.map.weight) === 'number' ? get(hdr.map.weight) : null,
            createdAt: new Date().toISOString(),
          });
          stats.prodRows++;
        }
      } else {
        stats.warnings.push('لم يتم العثور على صف العناوين في ورقة الرصيد');
      }
    } else {
      stats.warnings.push('لم يتم العثور على ورقة "الرصيد"');
    }

    /* ---------- sheet انتاج و مبيعات → transactions ---------- */
    const transactions = [];
    let txWs = findSheet(wb, 'انتاج') || findSheet(wb, 'مبيعات') || findSheet(wb, 'production');
    if (txWs) {
      const hdr = findHeaderRow(txWs, SYNONYMS_TX, 4);
      if (hdr) {
        stats.txSheetFound = true;
        const range = XLSX.utils.decode_range(txWs['!ref']);
        for (let r = hdr.row + 1; r <= range.e.r; r++) {
          const get = (col) => (col === undefined ? null : (txWs[XLSX.utils.encode_cell({ r, c: range.s.c + col })] || {}).v);
          const quality = get(hdr.map.quality);
          const addQty = num(get(hdr.map.addQty));
          const outQty = num(get(hdr.map.outQty));
          const customer = cleanStr(get(hdr.map.customer));
          const date = excelDateToStr(get(hdr.map.date));
          const weightRaw = get(hdr.map.weight);
          const settlementRaw = cleanStr(get(hdr.map.settlement));
          if (cleanStr(quality) === '' && addQty === 0 && outQty === 0 && customer === '' && !date) {
            stats.skippedEmptyTx++;
            continue; // trailing/empty rows
          }
          const voidRow = isVoid(quality);
          if (voidRow) stats.voidTx++;
          const t = {
            date,
            quality: cleanStr(quality),
            gsm: voidRow ? null : global.CALC.toNumberOrRaw(get(hdr.map.gsm)),
            size: voidRow ? null : global.CALC.toNumberOrRaw(get(hdr.map.size)),
            customer,
            permitNo: cleanStr(get(hdr.map.permitNo)),
            addQty,
            outQty,
            weight: typeof weightRaw === 'number' ? weightRaw : null,
            settlement: ['غ', 'ض'].includes(settlementRaw) ? settlementRaw : settlementRaw,
            notes: '',
            source: 'excel',
            excelRow: r + 1,
            void: voidRow,
            createdAt: new Date().toISOString(),
            updatedAt: null,
          };
          t.fingerprint = global.TX.fingerprint(t);
          if (!global.CALC.isComboComplete(t.quality, t.gsm, t.size) && !voidRow) stats.incompleteTx++;
          transactions.push(t);
          stats.txRows++;
        }
      } else {
        stats.warnings.push('لم يتم العثور على صف العناوين في ورقة انتاج و مبيعات');
      }
    } else {
      stats.warnings.push('لم يتم العثور على ورقة "انتاج و مبيعات"');
    }

    /* combos present in transactions but missing from الرصيد → register so
       their balances are visible (marked source='discovered') */
    const prodCombos = new Set(products.map((p) => p.combo));
    for (const t of transactions) {
      if (t.void) continue;
      const combo = global.CALC.comboKeyOf(t);
      if (!global.CALC.isComboComplete(t.quality, t.gsm, t.size)) continue;
      if (!prodCombos.has(combo)) {
        prodCombos.add(combo);
        products.push({
          quality: t.quality, gsm: t.gsm, size: t.size, combo,
          source: 'discovered', refBalance: null, refWeight: null,
          createdAt: new Date().toISOString(),
        });
      }
    }

    return { products, transactions, stats };
  }

  /* ---------- import into IndexedDB with duplicate detection ---------- */

  /**
   * @param {Array} parsedTx  transactions from parseWorkbook
   * @param {Array} parsedProd products from parseWorkbook
   * @param {Array} existingTx existing transactions in DB
   * @param {Array} existingProd existing products in DB
   * @returns classification for the preview UI
   * NOTE: rows that are identical INSIDE the file are real historical
   * records (the source file contains 179 such rows) — they are imported
   * as separate transactions and only counted for the preview. Only rows
   * whose fingerprint already exists in the DB are treated as duplicates.
   */
  function classifyImport(parsedTx, parsedProd, existingTx, existingProd) {
    const existingFp = new Set(existingTx.map((t) => t.fingerprint));
    const existingCombos = new Set(existingProd.map((p) => p.combo));
    const inFileFp = new Set();
    const newTx = [], dupTx = [], inFileDup = [];
    for (const t of parsedTx) {
      if (existingFp.has(t.fingerprint)) { dupTx.push(t); continue; }
      if (inFileFp.has(t.fingerprint)) inFileDup.push(t); // kept, counted only
      inFileFp.add(t.fingerprint);
      newTx.push(t);
    }
    const newProd = [], existingProdKept = [];
    for (const p of parsedProd) {
      if (existingCombos.has(p.combo)) existingProdKept.push(p);
      else { existingCombos.add(p.combo); newProd.push(p); }
    }
    return { newTx, dupTx, inFileDup, newProd, existingProdKept };
  }

  async function commitImport(parsed, existingTx, existingProd, replaceAll) {
    const cls = classifyImport(parsed.transactions, parsed.products, existingTx, existingProd);
    if (replaceAll) {
      await global.DB.wipeAll();
      const prods = parsed.products.map((p) => Object.assign({}, p, { id: undefined }));
      const txs = parsed.transactions.map((t) => Object.assign({}, t, { id: undefined }));
      await global.DB.bulkPut('products', prods.map((p) => { delete p.id; return p; }));
      await global.DB.bulkPut('transactions', txs.map((t) => { delete t.id; return t; }));
      await global.DB.logAudit({
        entity: 'database', action: 'import-replace', entityId: null, before: null, after: null,
        details: `products=${prods.length}, tx=${txs.length}`,
      });
      return { cls, importedTx: txs.length, importedProd: prods.length };
    }
    await global.DB.bulkPut('products', cls.newProd);
    await global.DB.bulkPut('transactions', cls.newTx);
    await global.DB.logAudit({
      entity: 'database', action: 'import', entityId: null, before: null, after: null,
      details: `newTx=${cls.newTx.length}, dupTx=${cls.dupTx.length}, inFileDup=${cls.inFileDup.length}, newProd=${cls.newProd.length}`,
    });
    await global.DB.setSetting('lastImport', {
      at: new Date().toISOString(),
      newTx: cls.newTx.length, dupTx: cls.dupTx.length, inFileDup: cls.inFileDup.length,
      newProd: cls.newProd.length, existingProd: cls.existingProdKept.length,
      sheets: parsed.stats.sheets,
    });
    return {
      cls,
      importedTx: cls.newTx.length,
      importedProd: cls.newProd.length,
    };
  }

  /* =========================== EXPORTS =========================== */

  const TX_EXPORT_HEADERS = ['التاريخ', 'الوزن', 'رقم اذن الصرف', 'اسم الصنف', 'اسم العميل',
    'الجرام', 'المقاس', 'اضافه', 'صرف', 'تصفيه', 'ملاحظات'];

  function txToExportRow(t) {
    return [t.date || '', t.weight == null ? '' : t.weight, t.permitNo || '', t.quality,
      t.customer || '', t.gsm == null ? '' : t.gsm, t.size == null ? '' : t.size,
      t.addQty || 0, t.outQty || 0, t.settlement || '', t.notes || ''];
  }

  function buildTxSheet(transactions, sheetName) {
    const aoa = [TX_EXPORT_HEADERS].concat(transactions.map(txToExportRow));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 24 }];
    ws['!views'] = [{ RTL: true }];
    return ws;
  }

  function newWb() {
    const wb = XLSX.utils.book_new();
    wb.Props = { Application: 'نظام إدارة رصيد المخزن' };
    return wb;
  }

  /* SheetJS 0.18.x writes the sheet rightToLeft flag from the WRITE OPTIONS */
  const WRITE_OPTS = { Workbook: { Views: [{ RTL: true }] } };

  function stampFileName(base) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${base}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
  }

  /* رصيد المخزن export */
  function exportInventory(products, balances, weightFactor) {
    const wb = newWb();
    const aoa = [['الصنف', 'الجرام (GSM)', 'المقاس (Size)', 'رصيد المخزن', 'الوزن']];
    let totBal = 0, totWeight = 0;
    for (const p of products) {
      const b = balances.get(p.combo);
      const net = b ? b.net : 0;
      const w = global.CALC.productWeight(p.size, net, weightFactor);
      totBal += net; totWeight += w;
      aoa.push([p.quality, p.gsm, p.size, net, w]);
    }
    aoa.push(['الإجمالي', '', '', global.CALC.round6(totBal), global.CALC.round6(totWeight)]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    ws['!views'] = [{ RTL: true }];
    XLSX.utils.book_append_sheet(wb, ws, 'رصيد المخزن');
    XLSX.writeFile(wb, stampFileName('رصيد_المخزن'), WRITE_OPTS);
  }

  /* كل الحركات بنفس ترتيب أعمدة الملف الأصلي */
  function exportTransactions(transactions) {
    const wb = newWb();
    const ws = buildTxSheet(transactions, 'انتاج و مبيعات');
    XLSX.utils.book_append_sheet(wb, ws, 'انتاج و مبيعات');
    XLSX.writeFile(wb, stampFileName('انتاج_و_مبيعات'), WRITE_OPTS);
  }

  /* تقرير مصدَّر (صفوف جاهزة + إجماليات) */
  function exportReportAOA(title, headers, rows, totalsRow, fileName) {
    const wb = newWb();
    const aoa = [[title], [new Date().toLocaleDateString('ar-EG')], []]
      .concat([headers])
      .concat(rows)
      .concat(totalsRow ? [totalsRow] : []);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!views'] = [{ RTL: true }];
    XLSX.utils.book_append_sheet(wb, ws, 'تقرير');
    XLSX.writeFile(wb, stampFileName(fileName), WRITE_OPTS);
  }

  global.EXCEL = {
    SYNONYMS_TX, SYNONYMS_PROD, norm, findSheet, mapColumns, findHeaderRow,
    excelDateToStr, parseWorkbook, classifyImport, commitImport, buildTxSheet,
    exportInventory, exportTransactions, exportReportAOA, TX_EXPORT_HEADERS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EXCEL;
})(typeof window !== 'undefined' ? window : globalThis);
