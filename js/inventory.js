/* =========================================================================
   inventory.js — رصيد المخزن (بحث/فلترة/ترتيب) + إدارة الأصناف + تفاصيل الصنف
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, toast, confirmDialog, openModal, closeModal } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';

  /* ================= Inventory view ================= */
  function renderInventory(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('inventory'))}</h2>
        <div class="head-actions">
          <button class="btn btn-ghost" id="inv-export">${t('exportExcel')}</button>
        </div></div>
      <div class="card filters">
        <input type="text" id="inv-search" placeholder="${lang() ? 'بحث باسم الصنف…' : 'Search product…'}">
        <select id="inv-gsm"><option value="">${t('gsm')}: ${t('all')}</option></select>
        <select id="inv-size"><option value="">${t('size')}: ${t('all')}</option></select>
        <select id="inv-sort">
          <option value="name">${lang() ? 'ترتيب: الصنف' : 'Sort: name'}</option>
          <option value="bal-desc">${lang() ? 'الرصيد (تنازلي)' : 'balance (high→low)'}</option>
          <option value="bal-asc">${lang() ? 'الرصيد (تصاعدي)' : 'balance (low→high)'}</option>
          <option value="weight-desc">${lang() ? 'الوزن (تنازلي)' : 'weight (high→low)'}</option>
        </select>
        <label class="chk"><input type="checkbox" id="inv-nonzero"> ${lang() ? 'الأصناف ذات رصيد فقط' : 'only items with stock'}</label>
        <button class="btn btn-ghost" id="inv-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="inv-table"></div>`;

    /* filter options */
    const gsms = [...new Set(App.state.products.map((p) => String(p.gsm)))].filter((x) => x !== '').sort((a, b) => Number(a) - Number(b));
    const sizes = [...new Set(App.state.products.map((p) => String(p.size)))].filter((x) => x !== '').sort((a, b) => Number(a) - Number(b));
    host.querySelector('#inv-gsm').innerHTML += gsms.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    host.querySelector('#inv-size').innerHTML += sizes.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

    function draw() {
      const q = host.querySelector('#inv-search').value.trim().toLowerCase();
      const g = host.querySelector('#inv-gsm').value;
      const s = host.querySelector('#inv-size').value;
      const sort = host.querySelector('#inv-sort').value;
      const onlyNonZero = host.querySelector('#inv-nonzero').checked;
      const wf = App.state.settings.weightFactor;

      let rows = App.state.products.map((p) => {
        const b = App.state.balances.get(p.combo);
        const net = b ? b.net : 0;
        return Object.assign({}, p, {
          net,
          weight: global.CALC.productWeight(p.size, net, wf),
        });
      });
      if (q) rows = rows.filter((r) => r.quality.toLowerCase().includes(q));
      if (g) rows = rows.filter((r) => String(r.gsm) === g);
      if (s) rows = rows.filter((r) => String(r.size) === s);
      if (onlyNonZero) rows = rows.filter((r) => r.net !== 0);
      const cmp = {
        name: (a, b) => a.quality.localeCompare(b.quality, 'ar') || a.gsm - b.gsm || a.size - b.size,
        'bal-desc': (a, b) => b.net - a.net,
        'bal-asc': (a, b) => a.net - b.net,
        'weight-desc': (a, b) => b.weight - a.weight,
      }[sort] || ((a, b) => 0);
      rows.sort(cmp);

      const totNet = rows.reduce((s2, r) => s2 + r.net, 0);
      const totW = global.CALC.round6(rows.reduce((s2, r) => s2 + r.weight, 0));

      host.querySelector('#inv-table').innerHTML = `
        <table class="data-table sticky-head">
          <thead><tr>
            <th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th>
            <th class="num">${t('balance')}</th><th class="num">${t('weight')} (${t('kg')})</th>
            <th>${lang() ? 'المصدر' : 'Source'}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="7" class="empty">${esc(t('emptyState'))}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="3">${t('total')} (${fmtNum(rows.length)} ${lang() ? 'صنف' : 'items'})</td>
            <td class="num">${fmtNum(totNet)}</td><td class="num">${fmtNum(totW, 2)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>`;

      host.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openDetails(Number(b.dataset.view))));
    }

    function rowHtml(p) {
      const zero = p.net === 0, negative = p.net < 0;
      const cls = negative ? 'bal-neg' : zero ? 'bal-zero' : 'bal-pos';
      const src = p.source === 'excel' ? (lang() ? 'ملف الإكسل' : 'Excel')
        : p.source === 'discovered' ? (lang() ? 'من الحركات' : 'from transactions') : (lang() ? 'يدوي' : 'manual');
      return `<tr class="${negative ? 'tr-neg' : zero ? 'tr-zero' : ''}">
        <td data-label="${t('quality')}">${esc(p.quality)}</td>
        <td data-label="${t('gsm')}">${fmtNum(p.gsm)}</td>
        <td data-label="${t('size')}">${fmtNum(p.size)}</td>
        <td data-label="${t('balance')}"><span class="badge ${cls}">${fmtNum(p.net)}</span></td>
        <td data-label="${t('weight')}">${fmtNum(p.weight, 2)}</td>
        <td data-label="${lang() ? 'المصدر' : 'Source'}"><span class="muted">${esc(src)}</span></td>
        <td><button class="link-btn" data-view="${p.id || esc(p.combo)}">${t('details')}</button></td></tr>`;
    }

    /* ---- product details + full history with running balance ---- */
    function openDetails(idOrCombo) {
      const p = App.state.products.find((x) => (x.id ? x.id === idOrCombo : x.combo === idOrCombo))
        || App.state.products.find((x) => String(x.id) === String(idOrCombo));
      if (!p) return;
      const txs = App.state.transactions
        .filter((r) => global.CALC.sameCombo(r, p.quality, p.gsm, p.size))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
      let run = 0;
      const MAX_RENDER = 1000; /* a product can have thousands of rows */
      const rowsHtml = txs.map((r) => {
        run += (Number(r.addQty) || 0) - (Number(r.outQty) || 0);
        return { r, run: global.CALC.round6(run) };
      });
      const hidden = Math.max(0, rowsHtml.length - MAX_RENDER);
      const shown = hidden ? rowsHtml.slice(-MAX_RENDER) : rowsHtml;
      const rowsStr = shown.map(({ r, run: runv }) => `<tr>
          <td>${global.UI.fmtDate(r.date)}</td><td>${esc(r.customer || '')}</td>
          <td>${esc(r.permitNo || '')}</td>
          <td class="num pos">${r.addQty ? fmtNum(r.addQty) : ''}</td>
          <td class="num neg">${r.outQty ? fmtNum(r.outQty) : ''}</td>
          <td class="num"><strong>${fmtNum(runv)}</strong></td>
          <td>${esc(r.settlement || '')}</td></tr>`).join('');
      const note = hidden ? `<div class="muted small" style="padding:.4rem .6rem">${lang()
        ? `يُعرض آخر ${MAX_RENDER} حركة من إجمالي ${fmtNum(txs.length)} — افتح تقرير حركة الصنف لعرضها كلها للطباعة`
        : `Showing latest ${MAX_RENDER} of ${txs.length} rows — use the product movement report for the full printable list`}</div>` : '';
      const b = App.state.balances.get(p.combo);
      const net = b ? b.net : 0;
      const node = el(`<div>
        <div class="details-head">
          <div><h4>${esc(p.quality)}</h4>
          <p class="muted">${t('gsm')}: <strong>${fmtNum(p.gsm)}</strong> — ${t('size')}: <strong>${fmtNum(p.size)}</strong></p></div>
          <div class="details-balance">
            <div class="stat-mini"><span>${t('balance')}</span><strong class="${net < 0 ? 'neg' : net === 0 ? '' : 'pos'}">${fmtNum(net)}</strong></div>
            <div class="stat-mini"><span>${t('add')}</span><strong>${fmtNum(b ? b.add : 0)}</strong></div>
            <div class="stat-mini"><span>${t('out')}</span><strong>${fmtNum(b ? b.out : 0)}</strong></div>
            <div class="stat-mini"><span>${t('weight')}</span><strong>${fmtNum(global.CALC.productWeight(p.size, net, App.state.settings.weightFactor), 2)} ${t('kg')}</strong></div>
          </div></div>
        <div class="table-wrap scroll-tall"><table class="data-table">
          <thead><tr><th>${t('date')}</th><th>${t('customer')}</th><th>${t('permit')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th class="num">${lang() ? 'الرصيد الجاري' : 'Running balance'}</th><th>${t('settlement')}</th></tr></thead>
          <tbody>${rowsStr || `<tr><td colspan="7" class="empty">${lang() ? 'لا توجد حركات لهذا الصنف' : 'no transactions'}</td></tr>`}</tbody>
        </table></div>${note}</div>`);
      openModal(node, { title: lang() ? 'تفاصيل الصنف وسجل حركاته الكاملة' : 'Product details & full history', wide: true });
    }

    host.querySelector('#inv-search').addEventListener('input', draw);
    host.querySelector('#inv-gsm').addEventListener('change', draw);
    host.querySelector('#inv-size').addEventListener('change', draw);
    host.querySelector('#inv-sort').addEventListener('change', draw);
    host.querySelector('#inv-nonzero').addEventListener('change', draw);
    host.querySelector('#inv-clear').addEventListener('click', () => {
      host.querySelector('#inv-search').value = '';
      host.querySelector('#inv-gsm').value = '';
      host.querySelector('#inv-size').value = '';
      host.querySelector('#inv-nonzero').checked = false;
      draw();
    });
    host.querySelector('#inv-export').addEventListener('click', () => {
      global.EXCEL.exportInventory(App.state.products, App.state.balances, App.state.settings.weightFactor);
      toast(lang() ? 'تم تنزيل ملف رصيد المخزن' : 'inventory Excel downloaded', 'ok');
    });
    draw();
  }

  /* ================= Product management ================= */
  function renderProducts(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('products'))}</h2>
        <div class="head-actions"><button class="btn btn-primary" id="pr-add">+ ${lang() ? 'صنف جديد' : 'New product'}</button></div></div>
      <div class="card table-wrap"><table class="data-table">
        <thead><tr><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th>
          <th class="num">${t('balance')}</th><th>${lang() ? 'المصدر' : 'Source'}</th><th>${t('actions')}</th></tr></thead>
        <tbody id="pr-rows"></tbody></table></div>`;

    function draw() {
      const familyOf = (name) => {
        const value = String(name || '').replace(/[\\s\\u0640]+/g, ' ').trim().toLowerCase();
        if (value.includes('تست') && value.includes('لينر') && value.includes('معالج')) return 'تست لينر معالج';
        if (value.includes('توب') && value.includes('لاينر')) return 'توب لاينر';
        // Keep any legacy/unclassified product visible instead of dropping it.
        return String(name || '').trim();
      };
      const familyOrder = ['تست لينر معالج', 'توب لاينر'];
      const rows = App.state.products.slice().sort((a, b) => {
        const fa = familyOf(a.quality), fb = familyOf(b.quality);
        const ia = familyOrder.indexOf(fa), ib = familyOrder.indexOf(fb);
        const oa = ia < 0 ? familyOrder.length : ia, ob = ib < 0 ? familyOrder.length : ib;
        return oa - ob || fa.localeCompare(fb, 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size);
      });
      const shownFamilies = new Set();
      host.querySelector('#pr-rows').innerHTML = rows.map((p) => {
        const b = App.state.balances.get(p.combo);
        const family = familyOf(p.quality);
        const showFamily = !shownFamilies.has(family);
        shownFamilies.add(family);
        return `<tr>
          <td data-label="${t('quality')}">${showFamily ? esc(family) : ''}</td>
          <td data-label="${t('gsm')}">${fmtNum(p.gsm)}</td>
          <td data-label="${t('size')}">${fmtNum(p.size)}</td>
          <td data-label="${t('balance')}" class="num">${fmtNum(b ? b.net : 0)}</td>
          <td>${esc(p.source || '')}</td>
          <td class="actions-cell">
            <button class="icon-btn" data-edit="${p.id}" title="${t('edit')}">✎</button>
            <button class="icon-btn danger" data-del="${p.id}" title="${t('del')}">🗑</button>
          </td></tr>`;
      }).join('');
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
      const node = el(`<div class="edit-prod">
        <label class="field"><span>${t('quality')} *</span><input id="p-q" type="text" value="${esc(p ? p.quality : '')}"></label>
        <label class="field"><span>${t('gsm')} *</span><input id="p-g" type="number" step="any" value="${esc(p && p.gsm != null ? p.gsm : '')}"></label>
        <label class="field"><span>${t('size')} *</span><input id="p-s" type="number" step="any" value="${esc(p && p.size != null ? p.size : '')}"></label>
        <div class="form-error" id="p-err"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="p-save">${t('save')}</button>
          <button class="btn btn-ghost" id="p-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: isNew ? (lang() ? 'صنف جديد' : 'New product') : (lang() ? 'تعديل صنف' : 'Edit product') });
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
    draw();
  }

  global.App.registerView('inventory', renderInventory);
  global.App.registerView('products', renderProducts);
})(window);
