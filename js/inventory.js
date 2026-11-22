/* =========================================================================
   inventory.js — رصيد المخزن (بحث/فلترة/ترتيب) + إدارة الأصناف + تفاصيل الصنف
   Hierarchy: Product → GSM → Roll Weight (KG) → Size → Quantity.
   Balances are computed per (product, gsm, roll-weight, size) bucket —
   two rolls with different weights are never combined. Legacy rows
   without a weight show as bucket «—». Zero-balance items are hidden.
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, toast, confirmDialog, openModal, closeModal } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';
  const familyOf = (name) => App.productFamily(name);
  const CANON = ['تست لينر معالج', 'توب لاينر'];

  /* ================= Inventory view ================= */
  function renderInventory(host) {
    const families = CANON.filter((f) => App.state.balancesW && [...App.state.balancesW.values()].some((b) => familyOf(b.quality) === f));
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('inventory'))}</h2>
        <div class="head-actions">
          <button class="btn btn-ghost" id="inv-export">${t('exportExcel')}</button>
        </div></div>
      <div class="card filters">
        <input type="text" id="inv-search" placeholder="${lang() ? 'بحث باسم الصنف…' : 'Search product…'}">
        <select id="inv-family"><option value="">${lang() ? 'الصنف: الكل' : 'Product: all'}</option>
          ${families.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select>
        <select id="inv-gsm"><option value="">${t('gsm')}: ${t('all')}</option></select>
        <select id="inv-weight"><option value="">${t('rollWeight')}: ${t('all')}</option></select>
        <select id="inv-size"><option value="">${t('size')}: ${t('all')}</option></select>
        <select id="inv-sort">
          <option value="name">${lang() ? 'ترتيب: الصنف' : 'Sort: name'}</option>
          <option value="bal-desc">${lang() ? 'الرصيد (تنازلي)' : 'balance (high→low)'}</option>
          <option value="bal-asc">${lang() ? 'الرصيد (تصاعدي)' : 'balance (low→high)'}</option>
          <option value="weight-desc">${lang() ? 'الوزن التقديري (تنازلي)' : 'estimated weight (high→low)'}</option>
        </select>
        <button class="btn btn-ghost" id="inv-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="inv-table"></div>`;

    /* filter options from the weight-dimension buckets */
    const buckets = [...App.state.balancesW.values()];
    const gsms = [...new Set(buckets.map((b) => String(b.gsm)))].filter((x) => x !== '').sort((a, b) => Number(a) - Number(b));
    const sizes = [...new Set(buckets.map((b) => String(b.size)))].filter((x) => x !== '').sort((a, b) => Number(a) - Number(b));
    const weights = [...new Set(buckets.map((b) => (b.weight == null ? '—' : String(Number(b.weight)))))].sort((a, b) =>
      (a === '—' ? 1 : b === '—' ? -1 : Number(a) - Number(b)));
    host.querySelector('#inv-gsm').innerHTML += gsms.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    host.querySelector('#inv-weight').innerHTML += weights.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('');
    host.querySelector('#inv-size').innerHTML += sizes.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

    function draw() {
      const q = host.querySelector('#inv-search').value.trim().toLowerCase();
      const fam = host.querySelector('#inv-family').value;
      const g = host.querySelector('#inv-gsm').value;
      const w = host.querySelector('#inv-weight').value;
      const s = host.querySelector('#inv-size').value;
      const sort = host.querySelector('#inv-sort').value;
      const wf = App.state.settings.weightFactor;

      let rows = buckets.map((b) => Object.assign({}, b, {
        family: familyOf(b.quality),
        estWeight: global.CALC.productWeight(b.size, b.net, wf),
        weightLabel: b.weight == null ? '—' : fmtNum(b.weight),
      }));
      if (q) rows = rows.filter((r) => r.quality.toLowerCase().includes(q) || r.family.toLowerCase().includes(q));
      if (fam) rows = rows.filter((r) => r.family === fam);
      if (g) rows = rows.filter((r) => String(r.gsm) === g);
      if (w) rows = rows.filter((r) => r.weightLabel === w);
      if (s) rows = rows.filter((r) => String(r.size) === s);
      rows = rows.filter((r) => r.net !== 0); /* zero-balance items stay hidden */
      const cmp = {
        name: (a, b) => {
          const ia = CANON.indexOf(a.family), ib = CANON.indexOf(b.family);
          const oa = ia < 0 ? CANON.length : ia, ob = ib < 0 ? CANON.length : ib;
          return oa - ob || a.family.localeCompare(b.family, 'ar') || Number(a.gsm) - Number(b.gsm) ||
            (a.weight == null ? -1 : b.weight == null ? 1 : a.weight - b.weight) || Number(a.size) - Number(b.size);
        },
        'bal-desc': (a, b) => b.net - a.net,
        'bal-asc': (a, b) => a.net - b.net,
        'weight-desc': (a, b) => b.estWeight - a.estWeight,
      }[sort] || ((a, b) => 0);
      rows.sort(cmp);

      const totNet = rows.reduce((s2, r) => s2 + r.net, 0);
      const totW = global.CALC.round6(rows.reduce((s2, r) => s2 + r.estWeight, 0));

      host.querySelector('#inv-table').innerHTML = `
        <table class="data-table sticky-head">
          <thead><tr>
            <th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('rollWeight')}</th><th>${t('size')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th class="num">${t('balance')}</th><th class="num">${lang() ? 'الوزن التقديري' : 'Est. weight'} (${t('kg')})</th>
            <th>${t('actions')}</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="9" class="empty">${lang() ? 'لا توجد أصناف برصيد مطابقة للبحث' : 'no items match'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="6">${t('total')} (${fmtNum(rows.length)} ${lang() ? 'صنف' : 'items'})</td>
            <td class="num">${fmtNum(totNet)}</td><td class="num">${fmtNum(totW, 2)}</td>
            <td></td>
          </tr></tfoot>
        </table>`;

      host.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openDetails(b.dataset.bucket)));
    }

    function rowHtml(p) {
      const negative = p.net < 0;
      const cls = negative ? 'bal-neg' : p.net === 0 ? 'bal-zero' : 'bal-pos';
      return `<tr class="${negative ? 'tr-neg' : ''}">
        <td data-label="${t('quality')}">${esc(p.family)}</td>
        <td data-label="${t('gsm')}">${fmtNum(p.gsm)}</td>
        <td data-label="${t('rollWeight')}">${esc(p.weightLabel)}</td>
        <td data-label="${t('size')}">${fmtNum(p.size)}</td>
        <td class="num pos" data-label="${t('addQty')}">${p.add ? fmtNum(p.add) : ''}</td>
        <td class="num neg" data-label="${t('outQty')}">${p.out ? fmtNum(p.out) : ''}</td>
        <td data-label="${t('balance')}"><span class="badge ${cls}">${fmtNum(p.net)}</span></td>
        <td class="num" data-label="${lang() ? 'الوزن التقديري' : 'Est. weight'}">${fmtNum(p.estWeight, 2)}</td>
        <td><button class="link-btn" data-view="${esc(global.CALC.comboKeyWOf(p))}">${t('details')}</button></td></tr>`;
    }

    /* ---- bucket details + full history with running balance ---- */
    function openDetails(bucketKey) {
      const b0 = App.state.balancesW.get(bucketKey);
      if (!b0) return;
      const txs = App.state.transactions
        .filter((r) => global.CALC.comboKeyWOf(r) === bucketKey)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
      let run = 0;
      const MAX_RENDER = 1000;
      const rowsHtml = txs.map((r) => {
        run += (Number(r.addQty) || 0) - (Number(r.outQty) || 0);
        return { r, run: global.CALC.round6(run) };
      });
      const hidden = Math.max(0, rowsHtml.length - MAX_RENDER);
      const shown = hidden ? rowsHtml.slice(-MAX_RENDER) : rowsHtml;
      const rowsStr = shown.map(({ r, run: runv }) => `<tr>
          <td>${global.UI.fmtDate(r.date)}</td><td>${esc(App.canonicalCustomer(r.customer) || '')}</td>
          <td>${esc(r.permitNo || '')}</td>
          <td class="num pos">${r.addQty ? fmtNum(r.addQty) : ''}</td>
          <td class="num neg">${r.outQty ? fmtNum(r.outQty) : ''}</td>
          <td class="num"><strong>${fmtNum(runv)}</strong></td>
          <td>${esc(r.settlement || '')}</td></tr>`).join('');
      const note = hidden ? `<div class="muted small" style="padding:.4rem .6rem">${lang()
        ? `يُعرض آخر ${MAX_RENDER} حركة من إجمالي ${fmtNum(txs.length)} — افتح تقرير حركة الصنف لعرضها كلها للطباعة`
        : `Showing latest ${MAX_RENDER} of ${txs.length} rows — use the product movement report for the full printable list`}</div>` : '';
      const net = b0.net;
      const node = el(`<div>
        <div class="details-head">
          <div><h4>${esc(b0.quality)}</h4>
          <p class="muted">${t('gsm')}: <strong>${fmtNum(b0.gsm)}</strong> — ${t('rollWeight')}: <strong>${b0.weight == null ? '—' : fmtNum(b0.weight)}</strong> — ${t('size')}: <strong>${fmtNum(b0.size)}</strong></p></div>
          <div class="details-balance">
            <div class="stat-mini"><span>${t('balance')}</span><strong class="${net < 0 ? 'neg' : net === 0 ? '' : 'pos'}">${fmtNum(net)}</strong></div>
            <div class="stat-mini"><span>${t('add')}</span><strong>${fmtNum(b0.add)}</strong></div>
            <div class="stat-mini"><span>${t('out')}</span><strong>${fmtNum(b0.out)}</strong></div>
            <div class="stat-mini"><span>${lang() ? 'الوزن التقديري' : 'Est. weight'}</span><strong>${fmtNum(global.CALC.productWeight(b0.size, net, App.state.settings.weightFactor), 2)} ${t('kg')}</strong></div>
          </div></div>
        <div class="table-wrap scroll-tall"><table class="data-table">
          <thead><tr><th>${t('date')}</th><th>${t('customer')}</th><th>${t('permit')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th class="num">${lang() ? 'الرصيد الجاري' : 'Running balance'}</th><th>${t('settlement')}</th></tr></thead>
          <tbody>${rowsStr || `<tr><td colspan="7" class="empty">${lang() ? 'لا توجد حركات لهذا الصنف' : 'no transactions'}</td></tr>`}</tbody>
        </table></div>${note}</div>`);
      openModal(node, { title: lang() ? 'تفاصيل الصنف وسجل حركاته الكاملة' : 'Item details & full history', wide: true });
    }

    host.querySelector('#inv-search').addEventListener('input', draw);
    host.querySelector('#inv-family').addEventListener('change', draw);
    host.querySelector('#inv-gsm').addEventListener('change', draw);
    host.querySelector('#inv-weight').addEventListener('change', draw);
    host.querySelector('#inv-size').addEventListener('change', draw);
    host.querySelector('#inv-sort').addEventListener('change', draw);
    host.querySelector('#inv-clear').addEventListener('click', () => {
      host.querySelector('#inv-search').value = '';
      host.querySelector('#inv-family').value = '';
      host.querySelector('#inv-gsm').value = '';
      host.querySelector('#inv-weight').value = '';
      host.querySelector('#inv-size').value = '';
      draw();
    });
    host.querySelector('#inv-export').addEventListener('click', () => {
      const bucketsOut = [...App.state.balancesW.values()];
      global.EXCEL.exportInventoryBuckets(bucketsOut, App.state.settings.weightFactor);
      toast(lang() ? 'تم تنزيل ملف رصيد المخزن' : 'inventory Excel downloaded', 'ok');
    });
    draw();
  }

  /* ================= Product management ================= */
  function renderProducts(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('products'))}</h2>
        <div class="head-actions">
          <label class="chk"><input type="checkbox" id="pr-all"> ${lang() ? 'إظهار كل المقاسات (حتى الرصيد الصفر)' : 'show all sizes (incl. zero)'}</label>
          <button class="btn btn-primary" id="pr-add">+ ${lang() ? 'مقاس جديد' : 'New size'}</button>
        </div></div>
      <p class="muted small">${lang() ? 'المنتجان المعتمدان فقط: «تست لينر معالج» و«توب لاينر» — لا يُسمح بأسماء جديدة لمنع التكرار.' : 'Only the two approved products: تست لينر معالج and توب لاينر — new names are blocked to prevent duplicates.'}</p>
      <div class="card table-wrap"><table class="data-table">
        <thead><tr><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th>
          <th class="num">${t('balance')}</th><th>${lang() ? 'المصدر' : 'Source'}</th><th>${t('actions')}</th></tr></thead>
        <tbody id="pr-rows"></tbody></table></div>`;

    function draw() {
      const showAll = host.querySelector('#pr-all').checked;
      const rows = App.state.products.filter((p) => {
        if (showAll) return true;
        const balance = App.state.balances.get(p.combo);
        return balance && Number(balance.net) !== 0;
      }).slice().sort((a, b) => {
        const fa = familyOf(a.quality), fb = familyOf(b.quality);
        const ia = CANON.indexOf(fa), ib = CANON.indexOf(fb);
        const oa = ia < 0 ? CANON.length : ia, ob = ib < 0 ? CANON.length : ib;
        return oa - ob || fa.localeCompare(fb, 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size);
      });
      const shownFamilies = new Set();
      host.querySelector('#pr-rows').innerHTML = rows.length ? rows.map((p) => {
        const b = App.state.balances.get(p.combo);
        const family = familyOf(p.quality);
        const showFamily = !shownFamilies.has(family);
        shownFamilies.add(family);
        return `<tr>
          <td data-label="${t('quality')}">${showFamily ? esc(family) : ''}</td>
          <td data-label="${t('gsm')}">${fmtNum(p.gsm)}</td>
          <td data-label="${t('size')}">${fmtNum(p.size)}</td>
          <td data-label="${t('balance')}" class="num">${fmtNum(b ? b.net : 0)}</td>
          <td data-label="${lang() ? 'المصدر' : 'Source'}">${esc(p.source || '')}</td>
          <td class="actions-cell">
            <button class="icon-btn" data-edit="${p.id}" title="${t('edit')}">✎</button>
            <button class="icon-btn danger" data-del="${p.id}" title="${t('del')}">🗑</button>
          </td></tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">${lang() ? 'لا توجد أصناف برصيد — فعّل الإظهار الكل' : 'no items with stock'}</td></tr>`;
      host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editProduct(Number(b.dataset.edit))));
      host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const p = App.state.products.find((x) => x.id === Number(b.dataset.del));
        if (!p) return;
        const hasTx = App.state.transactions.some((r) => global.CALC.sameCombo(r, p.quality, p.gsm, p.size));
        const msg = hasTx
          ? (lang()
            ? `⚠ هذا الصنف له حركات مسجلة (${fmtNum(App.state.transactions.filter((r) => global.CALC.sameCombo(r, p.quality, p.gsm, p.size)).length)} حركة). حذف الصنف لن يحذف الحركات لكن لن يظهر في قائمة الأصناف. متابعة؟`
            : 'This product has transactions. Delete it from the product list? Transactions are kept.')
          : (lang() ? `حذف الصنف "${p.quality} / ${p.gsm} / ${p.size}"؟` : `Delete "${p.quality} / ${p.gsm} / ${p.size}"?`);
        const ok = await confirmDialog({ title: lang() ? 'حذف صنف' : 'Delete product', message: msg, danger: true });
        if (!ok) return;
        await global.DB.del('products', p.id);
        await global.DB.logAudit({ entity: 'product', action: 'delete', entityId: p.id, before: p, after: null });
        toast(lang() ? 'تم الحذف' : 'deleted', 'ok');
        await App.refresh();
      }));
    }

    function editProduct(id) {
      const p = App.state.products.find((x) => x.id === id);
      const isNew = !p;
      const currentFamily = p ? familyOf(p.quality) : '';
      /* only the two approved product names can be selected/created */
      const options = [...new Set(CANON.concat(currentFamily && CANON.indexOf(currentFamily) < 0 ? [currentFamily] : []))];
      const node = el(`<div class="edit-prod">
        <label class="field"><span>${t('quality')} *</span>
          <select id="p-q">${options.map((o) => `<option ${p && o === p.quality ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        <label class="field"><span>${t('gsm')} *</span><input id="p-g" type="number" step="any" value="${esc(p && p.gsm != null ? p.gsm : '')}"></label>
        <label class="field"><span>${t('size')} *</span><input id="p-s" type="number" step="any" value="${esc(p && p.size != null ? p.size : '')}"></label>
        <div class="form-error" id="p-err"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="p-save">${t('save')}</button>
          <button class="btn btn-ghost" id="p-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: isNew ? (lang() ? 'مقاس جديد' : 'New size') : (lang() ? 'تعديل صنف' : 'Edit product') });
      node.querySelector('#p-cancel').addEventListener('click', closeModal);
      node.querySelector('#p-save').addEventListener('click', async () => {
        const q = node.querySelector('#p-q').value.trim();
        const g = node.querySelector('#p-g').value;
        const s = node.querySelector('#p-s').value;
        const err = node.querySelector('#p-err');
        if (!q || g === '' || s === '') { err.textContent = lang() ? 'أكمل جميع الحقول' : 'fill all fields'; return; }
        const combo = global.CALC.comboKey(q, g, s);
        const clash = App.state.products.find((x) => x.combo === combo && (!p || x.id !== p.id));
        if (clash) { err.textContent = lang() ? 'يوجد صنف بنفس المواصفات' : 'duplicate combo exists'; return; }
        const rec = { quality: q, gsm: Number(g), size: Number(s), combo, source: p ? p.source : 'manual', createdAt: p ? p.createdAt : new Date().toISOString() };
        if (p) {
          await global.DB.put('products', Object.assign({ id: p.id }, rec));
          await global.DB.logAudit({ entity: 'product', action: 'edit', entityId: p.id, before: p, after: rec });
        } else {
          await global.DB.add('products', rec);
          await global.DB.logAudit({ entity: 'product', action: 'add', entityId: null, before: null, after: rec });
        }
        closeModal();
        toast(lang() ? 'تم الحفظ' : 'saved', 'ok');
        await App.refresh();
      });
    }

    host.querySelector('#pr-add').addEventListener('click', () => editProduct(null));
    host.querySelector('#pr-all').addEventListener('change', draw);
    draw();
  }

  global.App.registerView('inventory', renderInventory);
  global.App.registerView('products', renderProducts);
})(window);
