/* =========================================================================
   app.js — التشغيل، الحالة العامة، التنقل، لوحة التحكم، نموذج تسجيل الحركة
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, todayISO, toast, confirmDialog, openModal, closeModal, EventBus } = global.UI;

  const App = {
    state: {
      ready: false,
      products: [],
      transactions: [],
      balances: new Map(),
      settings: { companyName: '', lang: 'ar', weightFactor: 7.5 },
    },
    views: {},
    registerView(name, fn) { App.views[name] = fn; },
  };

  /* ---------------- data loading ---------------- */
  async function loadAll() {
    const [products, transactions] = await Promise.all([
      global.DB.getAll('products'),
      global.DB.getAll('transactions'),
    ]);
    App.state.products = products;
    App.state.transactions = transactions;
    App.state.balances = global.CALC.computeBalances(transactions);
    App.state.settings.companyName = await global.DB.getSetting('companyName', '');
    App.state.settings.lang = await global.DB.getSetting('lang', 'ar');
    const wf = await global.DB.getSetting('weightFactor', 7.5);
    App.state.settings.weightFactor = Number(wf) || 7.5;
    App.state.ready = true;
  }

  /* reload from DB and re-render current view */
  async function refresh() {
    await loadAll();
    EventBus.emit('data', null);
    render();
  }
  App.refresh = refresh;

  /* helper: balance of a combo from the live map */
  function balanceOf(quality, gsm, size) {
    const key = global.CALC.comboKey(quality, gsm, size);
    return App.state.balances.get(key) || { quality, gsm, size, add: 0, out: 0, net: 0 };
  }
  App.balanceOf = balanceOf;

  /* ---------------- router ---------------- */
  let currentRoute = 'dashboard';
  function render() {
    const view = App.views[currentRoute] || App.views.dashboard;
    const host = document.getElementById('view');
    host.innerHTML = '';
    Promise.resolve(view(host)).catch((e) => {
      console.error(e);
      host.innerHTML = `<div class="card error-card">${esc(e.message || e)}</div>`;
    });
  }
  function navigate(route) {
    currentRoute = route;
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.route === route);
    });
    document.title = `${t(route) || ''} — ${t('appName')}`;
    render();
    closeMobileNav();
  }
  App.navigate = navigate;
  App.rerender = render;
  App.currentRoute = () => currentRoute;

  function closeMobileNav() {
    document.body.classList.remove('nav-open');
  }

  /* ---------------- transaction form (add / edit) ---------------- */
  function productOptionLabel(p) {
    return `${p.quality} — ${p.gsm} جرام — ${p.size} سم`;
  }

  /**
   * Full-page form for registering a movement.
   * @param {object|null} existing transaction to edit
   * @param {string|null} preset 'add' | 'out'
   */
  function txForm(host, existing, preset) {
    const isEdit = !!existing;
    const type = preset || (existing ? (existing.addQty > 0 ? 'add' : 'out') : 'add');
    const customers = [...new Set(App.state.transactions.map((x) => x.customer).filter(Boolean))].filter((x) => x !== 'الإنتاج').sort();
    const productFamily = (name) => {
      const value = String(name || '').replace(/[\\s\\u0640]+/g, ' ').trim().toLowerCase();
      if (value.includes('تست') && value.includes('لينر') && value.includes('معالج')) return 'تست لينر معالج';
      if (value.includes('توب') && value.includes('لاينر')) return 'توب لاينر';
      return '';
    };
    const productFamilies = ['تست لينر معالج', 'توب لاينر'].filter((family) =>
      App.state.products.some((p) => productFamily(p.quality) === family)
    );

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit ? (UI.getLang() === 'ar' ? 'تعديل حركة' : 'Edit transaction') : t('addtx')}</h2></div>
      <div class="card form-card">
        <form id="tx-form" novalidate>
          <div class="form-grid">
            <label class="field">
              <span>${t('type')} *</span>
              <div class="seg-control" id="tx-type">
                <button type="button" data-v="add" class="${type === 'add' ? 'active' : ''}">${t('add')} (+)</button>
                <button type="button" data-v="out" class="${type === 'out' ? 'active' : ''}">${t('out')} (−)</button>
              </div>
            </label>
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="f-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field"><span>${t('quality')} *</span>
              <select id="f-quality" required>
                <option value="">— ${UI.getLang() === 'ar' ? 'اختر الصنف' : 'select product'} —</option>
                ${productFamilies.map((family) => `<option value="${esc(family)}" ${existing && productFamily(existing.quality) === family ? 'selected' : ''}>${esc(family)}</option>`).join('')}
              </select>
              <button type="button" class="link-btn" id="btn-new-product">+ ${UI.getLang() === 'ar' ? 'صنف جديد' : 'new product'}</button>
            </label>
            <label class="field"><span>${t('gsm')} *</span>
              <input type="number" id="f-gsm" min="1" step="any" placeholder="135" value="${esc(existing && existing.gsm != null ? existing.gsm : '')}"></label>
            <label class="field"><span>${t('size')} *</span>
              <input type="number" id="f-size" min="1" step="any" placeholder="100" value="${esc(existing && existing.size != null ? existing.size : '')}"></label>
            <label class="field" id="f-customer-wrap" ${type === 'add' ? 'hidden' : ''}><span>${UI.getLang() === 'ar' ? 'العميل' : 'Customer'} *</span>
              <input type="text" id="f-customer" list="customer-list" ${type === 'out' ? 'required' : 'disabled'} value="${esc(type === 'add' ? 'الإنتاج' : (existing ? existing.customer : ''))}">
              <datalist id="customer-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
            ${type === 'add' ? `<div class="field" id="f-production-note"><span>${UI.getLang() === 'ar' ? 'جهة الإضافة' : 'Addition source'}</span><strong>${UI.getLang() === 'ar' ? 'الإنتاج' : 'Production'}</strong></div>` : ''}
            <label class="field"><span>${t('permit')}</span>
              <input type="text" id="f-permit" value="${esc(existing ? existing.permitNo : '')}"></label>
            <label class="field"><span>${t('addQty')}</span>
              <input type="number" id="f-add" min="0" step="1" value="${existing ? (existing.addQty || '') : ''}" ${type === 'add' ? '' : 'disabled'}></label>
            <label class="field"><span>${t('outQty')}</span>
              <input type="number" id="f-out" min="0" step="1" value="${existing ? (existing.outQty || '') : ''}" ${type === 'out' ? '' : 'disabled'}></label>
            <label class="field"><span>${t('weight')} (${t('kg')})</span>
              <input type="number" id="f-weight" min="0" step="0.001" value="${esc(existing && existing.weight != null ? existing.weight : '')}"></label>
            <label class="field"><span>${t('settlement')}</span>
              <select id="f-settlement">
                <option value="">—</option>
                <option value="غ" ${existing && existing.settlement === 'غ' ? 'selected' : ''}>غ</option>
                <option value="ض" ${existing && existing.settlement === 'ض' ? 'selected' : ''}>ض</option>
              </select></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="f-notes" value="${esc(existing ? existing.notes : '')}"></label>
          </div>
          <div class="form-hint" id="balance-hint"></div>
          <div class="form-error" id="form-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${t('save')}</button>
            <button type="button" class="btn btn-ghost" id="f-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    const form = host.querySelector('#tx-form');
    const qSel = host.querySelector('#f-quality');
    const gsmIn = host.querySelector('#f-gsm');
    const sizeIn = host.querySelector('#f-size');
    const addIn = host.querySelector('#f-add');
    const outIn = host.querySelector('#f-out');
    const custIn = host.querySelector('#f-customer');
    let moveType = type;

    /* prefill gsm/size when choosing a known product (unless editing) */
    qSel.addEventListener('change', () => {
      if (isEdit) return;
      const p = App.state.products.find((x) => productFamily(x.quality) === qSel.value);
      if (p) { gsmIn.value = p.gsm != null ? p.gsm : ''; sizeIn.value = p.size != null ? p.size : ''; }
      updateHint();
    });

    /* segment control: enable the matching qty field */
    host.querySelectorAll('#tx-type button').forEach((b) => {
      b.addEventListener('click', () => {
        moveType = b.dataset.v;
        host.querySelectorAll('#tx-type button').forEach((x) => x.classList.toggle('active', x === b));
        addIn.disabled = moveType !== 'add';
        outIn.disabled = moveType !== 'out';
        const customerWrap = host.querySelector('#f-customer-wrap');
        const productionNote = host.querySelector('#f-production-note');
        if (moveType === 'add') {
          outIn.value = '';
          custIn.value = 'الإنتاج';
          custIn.disabled = true;
          customerWrap.hidden = true;
          if (!productionNote) {
            const note = el(`<div class="field" id="f-production-note"><span>${UI.getLang() === 'ar' ? 'جهة الإضافة' : 'Addition source'}</span><strong>${UI.getLang() === 'ar' ? 'الإنتاج' : 'Production'}</strong></div>`);
            customerWrap.insertAdjacentElement('beforebegin', note);
          }
        } else {
          addIn.value = '';
          custIn.disabled = false;
          custIn.value = isEdit && existing ? existing.customer : '';
          customerWrap.hidden = false;
          const note = host.querySelector('#f-production-note');
          if (note) note.remove();
        }
        updateHint();
      });
    });

    function updateHint() {
      const gsm = gsmIn.value, size = sizeIn.value, q = qSel.value;
      const hint = host.querySelector('#balance-hint');
      if (q && gsm && size) {
        const b = balanceOf(q, Number(gsm), Number(size));
        hint.innerHTML = UI.getLang() === 'ar'
          ? `الرصيد الحالي لهذا الصنف: <strong>${fmtNum(b.net)}</strong> ${t('rolls')} — الإضافات ${fmtNum(b.add)} — الصرف ${fmtNum(b.out)}`
          : `Current balance: <strong>${fmtNum(b.net)}</strong> — add ${fmtNum(b.add)} — out ${fmtNum(b.out)}`;
        if (moveType === 'out' && Number(outIn.value) > b.net) {
          hint.innerHTML += ` <span class="warn-text">⚠ ${UI.getLang() === 'ar' ? 'الكمية أكبر من الرصيد الحالي' : 'qty exceeds current balance'}</span>`;
        }
      } else hint.innerHTML = '';
    }
    [gsmIn, sizeIn, addIn, outIn].forEach((i) => i.addEventListener('input', updateHint));

    /* inline new product */
    host.querySelector('#btn-new-product').addEventListener('click', () => {
      const node = el(`<div class="newprod-form">
        <label><span>${t('quality')}</span><select id="np-q"><option value="تست لينر معالج">تست لينر معالج</option><option value="توب لاينر">توب لاينر</option></select></label>
        <label><span>${t('gsm')}</span><input id="np-g" type="number"></label>
        <label><span>${t('size')}</span><input id="np-s" type="number"></label>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="np-save">${t('save')}</button>
          <button class="btn btn-ghost" id="np-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: UI.getLang() === 'ar' ? 'إضافة صنف جديد' : 'New product' });
      node.querySelector('#np-save').addEventListener('click', async () => {
        const q = node.querySelector('#np-q').value.trim();
        const g = node.querySelector('#np-g').value;
        const s = node.querySelector('#np-s').value;
        if (!q || !g || !s) { toast(UI.getLang() === 'ar' ? 'أكمل جميع الحقول' : 'fill all fields', 'warn'); return; }
        const combo = global.CALC.comboKey(q, g, s);
        if (App.state.products.some((p) => p.combo === combo)) {
          toast(UI.getLang() === 'ar' ? 'هذا الصنف موجود بالفعل' : 'product already exists', 'warn');
          return;
        }
        const p = { quality: q, gsm: Number(g), size: Number(s), combo, source: 'manual', createdAt: new Date().toISOString() };
        await global.DB.add('products', p);
        await global.DB.logAudit({ entity: 'product', action: 'add', entityId: null, before: null, after: p });
        App.state.products.push(Object.assign({ id: undefined }, p));
        qSel.value = q; gsmIn.value = g; sizeIn.value = s;
        closeModal(); toast(UI.getLang() === 'ar' ? 'تم إضافة الصنف' : 'product added', 'ok');
        updateHint();
      });
      node.querySelector('#np-cancel').addEventListener('click', closeModal);
    });

    host.querySelector('#f-cancel').addEventListener('click', () => navigate('addtx'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#form-error');
      errBox.textContent = '';
      const quality = qSel.value.trim();
      const gsm = gsmIn.value ? Number(gsmIn.value) : null;
      const size = sizeIn.value ? Number(sizeIn.value) : null;
      const addQty = moveType === 'add' ? (Number(addIn.value) || 0) : 0;
      const outQty = moveType === 'out' ? (Number(outIn.value) || 0) : 0;
      const data = {
        date: host.querySelector('#f-date').value,
        quality, gsm, size,
        customer: custIn.value.trim(),
        permitNo: host.querySelector('#f-permit').value.trim(),
        addQty, outQty,
        weight: host.querySelector('#f-weight').value === '' ? null : Number(host.querySelector('#f-weight').value),
        settlement: host.querySelector('#f-settlement').value,
        notes: host.querySelector('#f-notes').value.trim(),
        source: isEdit ? existing.source : 'manual',
      };

      /* validation */
      const errors = global.TX.validate(data);
      if (errors.length) {
        errBox.innerHTML = errors.map((e2) => `• ${esc(e2.msg)}`).join('<br>');
        return;
      }
      /* withdrawal above balance → explicit confirmation, never silent */
      const b = balanceOf(quality, gsm, size);
      const delta = data.addQty - data.outQty;
      const projected = b.net + delta;
      if (projected < 0) {
        const ok = await confirmDialog({
          title: t('confirm'),
          message: UI.getLang() === 'ar'
            ? `الصرف سيجعل الرصيد سالبًا (${fmtNum(projected)}). هل تريد المتابعة؟`
            : `This withdrawal makes the balance negative (${fmtNum(projected)}). Continue?`,
          danger: true, yesLabel: UI.getLang() === 'ar' ? 'متابعة بالسالب' : 'Proceed',
        });
        if (!ok) return;
      }

      try {
        if (isEdit) {
          await global.TX.updateTransaction(existing.id, data);
          toast(UI.getLang() === 'ar' ? 'تم تحديث الحركة وتحديث الرصيد تلقائيًا' : 'transaction updated, balances recalculated', 'ok');
        } else {
          await global.TX.addTransaction(data);
          toast(UI.getLang() === 'ar' ? 'تم تسجيل الحركة وتحديث الرصيد تلقائيًا' : 'transaction saved, balances recalculated', 'ok');
        }
        await refresh();
        if (!isEdit) {
          form.reset();
          host.querySelector('#f-date').value = todayISO();
        } else navigate(history_source || 'history');
      } catch (e2) {
        if (e2 && e2.type === 'validation') {
          errBox.innerHTML = e2.errors.map((x) => `• ${esc(x.msg)}`).join('<br>');
        } else { errBox.textContent = String(e2.message || e2); console.error(e2); }
      }
    });
  }
  App.openTxForm = txForm;
  let history_source = 'history';

  /* ---------------- shared table renderer for tx lists ---------------- */
  function txTable(host, opts) {
    const lang = UI.getLang() === 'ar';
    let rows = App.state.transactions.slice();
    const f = opts.filter || (() => true);
    rows = rows.filter(f);
    /* filters UI */
    const customers = [...new Set(App.state.transactions.map((x) => x.customer).filter(Boolean))].sort();
    const qualities = [...new Set(App.state.products.map((p) => p.quality))].sort();
    host.innerHTML = `
      <div class="page-head"><h2>${esc(opts.title)}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="btn-add-tx">+ ${lang ? 'حركة جديدة' : 'New transaction'}</button>
          <button class="btn btn-ghost" id="btn-exp-tx">${t('exportExcel')}</button>
        </div></div>
      <div class="card filters">
        <input type="date" id="flt-from" title="${t('from')}">
        <input type="date" id="flt-to" title="${t('to')}">
        <input type="text" id="flt-q" list="flt-qlist" placeholder="${t('quality')}">
        <datalist id="flt-qlist">${qualities.map((q) => `<option value="${esc(q)}"></option>`).join('')}</datalist>
        <input type="text" id="flt-c" list="flt-clist" placeholder="${t('customer')}">
        <datalist id="flt-clist">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
        <input type="text" id="flt-text" placeholder="${lang ? 'بحث في إذن الصرف / ملاحظات' : 'search permit/notes'}">
        <select id="flt-settle"><option value="">${t('settlement')}: ${t('all')}</option><option value="غ">غ</option><option value="ض">ض</option></select>
        <button class="btn btn-ghost" id="flt-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="tx-table-host"></div>`;

    const host2 = host.querySelector('#tx-table-host');
    const PAGE_SIZE = 200; /* paginate: the real file has ~24k rows */
    let curList = [], page = 0;
    function applyFilters() {
      const from = host.querySelector('#flt-from').value;
      const to = host.querySelector('#flt-to').value;
      const q = host.querySelector('#flt-q').value.trim();
      const c = host.querySelector('#flt-c').value.trim();
      const text = host.querySelector('#flt-text').value.trim().toLowerCase();
      const st = host.querySelector('#flt-settle').value;
      let list = rows.filter((r) =>
        (!from || r.date >= from) && (!to || r.date <= to) &&
        (!q || r.quality === q) && (!c || r.customer === c) &&
        (!st || r.settlement === st) &&
        (!text || (r.permitNo || '').toLowerCase().includes(text) || (r.notes || '').toLowerCase().includes(text)));
      list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0)));
      curList = list; page = 0;
      renderRows();
    }
    function renderRows() {
      const total = curList.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      const slice = curList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const sumAdd = curList.reduce((s, r) => s + (Number(r.addQty) || 0), 0);
      const sumOut = curList.reduce((s, r) => s + (Number(r.outQty) || 0), 0);
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${t('date')}</th><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th>
            <th>${t('customer')}</th><th>${t('permit')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th>${t('settlement')}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map((r) => txRowHtml(r)).join('') :
            `<tr><td colspan="10" class="empty">${esc(t('emptyState'))}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="6">${t('total')} (${fmtNum(total)} ${lang ? 'حركة' : 'rows'})</td>
            <td class="num">${fmtNum(sumAdd)}</td><td class="num">${fmtNum(sumOut)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
        ${pages > 1 ? `<div class="pager">
          <button class="btn btn-ghost" id="pg-first" ${page === 0 ? 'disabled' : ''}>«</button>
          <button class="btn btn-ghost" id="pg-prev" ${page === 0 ? 'disabled' : ''}>‹</button>
          <span>${lang ? 'صفحة' : 'Page'} ${page + 1} / ${fmtNum(pages)}</span>
          <button class="btn btn-ghost" id="pg-next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>
          <button class="btn btn-ghost" id="pg-last" ${page >= pages - 1 ? 'disabled' : ''}>»</button>
        </div>` : ''}`;
      host2.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.dataset.id);
          const act = btn.dataset.act;
          const txRow = App.state.transactions.find((x) => x.id === id);
          if (!txRow) return;
          if (act === 'edit') { openEditModal(txRow); }
          else if (act === 'del') {
            const ok = await confirmDialog({
              title: lang ? 'حذف حركة' : 'Delete transaction',
              message: lang
                ? `سيتم حذف الحركة نهائيًا وتحديث الرصيد تلقائيًا.\nالصنف: ${txRow.quality} — الجرام: ${txRow.gsm} — المقاس: ${txRow.size} — الكمية: ${txRow.addQty || txRow.outQty}`
                : `Delete this transaction permanently and recalculate balances?\n${txRow.quality} / ${txRow.gsm} / ${txRow.size}`,
              danger: true, extra: lang ? `<code>${esc(txRow.date)} — ${esc(txRow.customer || '')}</code>` : '',
            });
            if (ok) {
              await global.TX.deleteTransaction(id);
              toast(lang ? 'تم الحذف وتحديث الرصيد' : 'deleted, balances updated', 'ok');
              await refresh();
            }
          }
        });
      });
      const bind = (id, fn) => { const b = host2.querySelector(id); if (b) b.addEventListener('click', () => { fn(); renderRows(); }); };
      bind('#pg-first', () => { page = 0; });
      bind('#pg-prev', () => { page--; });
      bind('#pg-next', () => { page++; });
      bind('#pg-last', () => { page = Math.ceil(curList.length / PAGE_SIZE) - 1; });
    }
    function txRowHtml(r) {
      const voidBadge = r.void ? `<span class="badge badge-void">${lang ? 'ملغاة' : 'void'}</span>` : '';
      const incomplete = !global.CALC.isComboComplete(r.quality, r.gsm, r.size) && !r.void
        ? `<span class="badge badge-warn" title="${lang ? 'ببيانات ناقصة — لا تدخل في حساب الرصيد' : 'incomplete — excluded from balances'}">⚠</span>` : '';
      return `<tr class="${r.addQty > 0 ? 'row-add' : 'row-out'}">
        <td data-label="${t('date')}">${fmtDate(r.date)}</td>
        <td data-label="${t('quality')}">${esc(r.quality)} ${voidBadge}${incomplete}</td>
        <td data-label="${t('gsm')}">${r.gsm == null ? '—' : fmtNum(r.gsm)}</td>
        <td data-label="${t('size')}">${r.size == null ? '—' : fmtNum(r.size)}</td>
        <td data-label="${t('customer')}">${esc(r.customer || '')}</td>
        <td data-label="${t('permit')}">${esc(r.permitNo || '')}</td>
        <td class="num pos" data-label="${t('addQty')}">${r.addQty ? fmtNum(r.addQty) : ''}</td>
        <td class="num neg" data-label="${t('outQty')}">${r.outQty ? fmtNum(r.outQty) : ''}</td>
        <td data-label="${t('settlement')}">${esc(r.settlement || '')}</td>
        <td class="actions-cell">
          <button class="icon-btn" data-act="edit" data-id="${r.id}" title="${t('edit')}">✎</button>
          <button class="icon-btn danger" data-act="del" data-id="${r.id}" title="${t('del')}">🗑</button>
        </td></tr>`;
    }

    function openEditModal(txRow) {
      const node = el(`<div class="edit-tx-form">
        <div class="form-grid">
          <label class="field"><span>${t('date')}</span><input id="e-date" type="date" value="${esc(txRow.date)}"></label>
          <label class="field"><span>${t('quality')}</span><input id="e-quality" type="text" value="${esc(txRow.quality)}"></label>
          <label class="field"><span>${t('gsm')}</span><input id="e-gsm" type="number" step="any" value="${esc(txRow.gsm == null ? '' : txRow.gsm)}"></label>
          <label class="field"><span>${t('size')}</span><input id="e-size" type="number" step="any" value="${esc(txRow.size == null ? '' : txRow.size)}"></label>
          <label class="field"><span>${t('customer')}</span><input id="e-customer" type="text" value="${esc(txRow.customer || '')}"></label>
          <label class="field"><span>${t('permit')}</span><input id="e-permit" type="text" value="${esc(txRow.permitNo || '')}"></label>
          <label class="field"><span>${t('addQty')}</span><input id="e-add" type="number" min="0" step="1" value="${txRow.addQty || ''}"></label>
          <label class="field"><span>${t('outQty')}</span><input id="e-out" type="number" min="0" step="1" value="${txRow.outQty || ''}"></label>
          <label class="field"><span>${t('weight')}</span><input id="e-weight" type="number" step="0.001" value="${esc(txRow.weight == null ? '' : txRow.weight)}"></label>
          <label class="field"><span>${t('settlement')}</span>
            <select id="e-settlement"><option value="">—</option>
              <option value="غ" ${txRow.settlement === 'غ' ? 'selected' : ''}>غ</option>
              <option value="ض" ${txRow.settlement === 'ض' ? 'selected' : ''}>ض</option></select></label>
          <label class="field field-wide"><span>${t('notes')}</span><input id="e-notes" type="text" value="${esc(txRow.notes || '')}"></label>
        </div>
        <div class="form-error" id="e-error"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="e-save">${t('save')}</button>
          <button class="btn btn-ghost" id="e-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: lang ? 'تعديل حركة (التعديل مسجل في سجل التدقيق)' : 'Edit transaction (audited)', wide: true });
      node.querySelector('#e-cancel').addEventListener('click', closeModal);
      node.querySelector('#e-save').addEventListener('click', async () => {
        try {
          await global.TX.updateTransaction(txRow.id, {
            date: node.querySelector('#e-date').value,
            quality: node.querySelector('#e-quality').value,
            gsm: node.querySelector('#e-gsm').value === '' ? null : Number(node.querySelector('#e-gsm').value),
            size: node.querySelector('#e-size').value === '' ? null : Number(node.querySelector('#e-size').value),
            customer: node.querySelector('#e-customer').value,
            permitNo: node.querySelector('#e-permit').value,
            addQty: Number(node.querySelector('#e-add').value) || 0,
            outQty: Number(node.querySelector('#e-out').value) || 0,
            weight: node.querySelector('#e-weight').value === '' ? null : Number(node.querySelector('#e-weight').value),
            settlement: node.querySelector('#e-settlement').value,
            notes: node.querySelector('#e-notes').value,
          });
          closeModal();
          toast(lang ? 'تم التعديل وتحديث الرصيد تلقائيًا' : 'updated, balances recalculated', 'ok');
          await refresh();
        } catch (e2) {
          if (e2 && e2.type === 'validation') node.querySelector('#e-error').innerHTML = e2.errors.map((x) => `• ${esc(x.msg)}`).join('<br>');
          else node.querySelector('#e-error').textContent = String(e2.message || e2);
        }
      });
    }

    host.querySelector('#flt-from').addEventListener('change', applyFilters);
    host.querySelector('#flt-to').addEventListener('change', applyFilters);
    host.querySelector('#flt-q').addEventListener('input', applyFilters);
    host.querySelector('#flt-c').addEventListener('input', applyFilters);
    host.querySelector('#flt-text').addEventListener('input', applyFilters);
    host.querySelector('#flt-settle').addEventListener('change', applyFilters);
    host.querySelector('#flt-clear').addEventListener('click', () => {
      ['#flt-from', '#flt-to', '#flt-q', '#flt-c', '#flt-text', '#flt-settle'].forEach((s) => { host.querySelector(s).value = ''; });
      applyFilters();
    });
    host.querySelector('#btn-add-tx').addEventListener('click', () => {
      App.pendingPreset = opts.preset || null;
      history_source = opts.preset || 'history';
      navigate('addtx');
    });
    host.querySelector('#btn-exp-tx').addEventListener('click', () => {
      global.EXCEL.exportTransactions(rows);
      toast(lang ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });
    applyFilters();
  }
  App.txTable = txTable;

  /* ---------------- dashboard ---------------- */
  function renderDashboard(host) {
    const lang = UI.getLang() === 'ar';
    const tx = App.state.transactions;
    const g = global.CALC.grandTotals(tx);
    const products = App.state.products;
    let stockTotal = 0, weightTotal = 0;
    for (const p of products) {
      const b = App.state.balances.get(p.combo);
      const net = b ? b.net : 0;
      stockTotal += net;
      weightTotal += global.CALC.productWeight(p.size, net, App.state.settings.weightFactor);
    }

    host.innerHTML = `
      <div class="page-head"><h2>${lang ? 'لوحة التحكم' : 'Dashboard'}</h2>
        <div class="head-actions">
          ${tx.length === 0 ? `<button class="btn btn-primary" id="btn-import-dash">${t('importExcel')}</button>` : ''}
        </div></div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-icon">📦</div><div class="stat-num" id="st-prod">${fmtNum(products.length)}</div><div class="stat-label">${t('totalProducts')}</div></div>
        <div class="stat-card"><div class="stat-icon">⚖️</div><div class="stat-num" id="st-balance">${fmtNum(stockTotal)}</div><div class="stat-label">${t('totalBalance')} (${t('rolls')})</div></div>
        <div class="stat-card"><div class="stat-icon">➕</div><div class="stat-num">${fmtNum(g.add)}</div><div class="stat-label">${t('totalAdd')}</div></div>
        <div class="stat-card"><div class="stat-icon">➖</div><div class="stat-num">${fmtNum(g.out)}</div><div class="stat-label">${t('totalOut')}</div></div>
        <div class="stat-card"><div class="stat-icon">🧾</div><div class="stat-num">${fmtNum(g.nAdd)}</div><div class="stat-label">${t('countAdd')}</div></div>
        <div class="stat-card"><div class="stat-icon">📤</div><div class="stat-num">${fmtNum(g.nOut)}</div><div class="stat-label">${t('countOut')}</div></div>
      </div>
      <div class="card weight-line">${lang ? 'إجمالي وزن الرصيد التقديري' : 'Estimated stock weight'}: <strong>${fmtNum(weightTotal, 2)}</strong> ${t('kg')} <span class="muted">(${lang ? 'المقاس × الرصيد ×' : 'size × balance ×'} ${App.state.settings.weightFactor})</span></div>
      ${g.nIncomplete ? `<div class="card notice-card">⚠ ${lang ? `يوجد ${g.nIncomplete} حركة ببيانات ناقصة (بدون جرام/مقاس) — مطابقة للإكسل لا تدخل في حساب الرصيد` : `${g.nIncomplete} incomplete rows (excluded from balances, same as Excel)`}</div>` : ''}
      <div class="dash-grid">
        <div class="card chart-card"><h3>${t('monthlyMovement')}</h3><canvas id="chart-monthly" height="230"></canvas></div>
        <div class="card chart-card"><h3>${t('topProducts')}</h3><canvas id="chart-top" height="230"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head-row"><h3>${t('recentTx')}</h3>
          <button class="link-btn" data-nav="history">${t('viewAll')}</button></div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>${t('date')}</th><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th><th>${t('customer')}</th><th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th></tr></thead>
          <tbody>${recentRows(tx)}</tbody>
        </table></div>
      </div>`;

    function recentRows(list) {
      const sorted = list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0))).slice(0, 8);
      if (!sorted.length) return `<tr><td colspan="7" class="empty">${esc(t('emptyState'))}</td></tr>`;
      return sorted.map((r) => `<tr>
        <td>${fmtDate(r.date)}</td><td>${esc(r.quality)}</td>
        <td>${r.gsm == null ? '—' : fmtNum(r.gsm)}</td><td>${r.size == null ? '—' : fmtNum(r.size)}</td>
        <td>${esc(r.customer || '')}</td>
        <td class="num pos">${r.addQty ? fmtNum(r.addQty) : ''}</td>
        <td class="num neg">${r.outQty ? fmtNum(r.outQty) : ''}</td></tr>`).join('');
    }

    host.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));
    const imp = host.querySelector('#btn-import-dash');
    if (imp) imp.addEventListener('click', () => global.BACKUP.openImportDialog());

    drawCharts(host, lang);
  }

  function drawCharts(host, lang) {
    if (!global.Chart) return;
    /* monthly additions vs withdrawals — last 12 months with data */
    const months = {};
    for (const r of App.state.transactions) {
      if (!r.date) continue;
      const m = r.date.slice(0, 7);
      months[m] = months[m] || { a: 0, o: 0 };
      months[m].a += Number(r.addQty) || 0;
      months[m].o += Number(r.outQty) || 0;
    }
    const keys = Object.keys(months).sort().slice(-12);
    if (keys.length) {
      const ctx = host.querySelector('#chart-monthly').getContext('2d');
      const dark = document.documentElement.dataset.theme === 'dark';
      new global.Chart(ctx, {
        type: 'bar',
        data: {
          labels: keys.map((k) => k.slice(0, 4) + '/' + k.slice(5, 7)),
          datasets: [
            { label: t('add'), data: keys.map((k) => months[k].a), backgroundColor: '#14B8A6' },
            { label: t('out'), data: keys.map((k) => months[k].o), backgroundColor: '#F59E0B' },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: dark ? '#ddd' : '#334' } } },
          scales: {
            x: { ticks: { color: dark ? '#bbb' : '#556' }, grid: { display: false } },
            y: { ticks: { color: dark ? '#bbb' : '#556' } },
          },
        },
      });
    }
    /* top 10 products by balance */
    const arr = [];
    for (const p of App.state.products) {
      const b = App.state.balances.get(p.combo);
      const net = b ? b.net : 0;
      if (net > 0) arr.push({ label: `${p.quality} ${p.gsm}g ${p.size}`, net });
    }
    arr.sort((a, b) => b.net - a.net);
    const top = arr.slice(0, 10);
    if (top.length) {
      const ctx2 = host.querySelector('#chart-top').getContext('2d');
      const dark = document.documentElement.dataset.theme === 'dark';
      new global.Chart(ctx2, {
        type: 'bar',
        data: {
          labels: top.map((x) => x.label),
          datasets: [{ label: t('balance'), data: top.map((x) => x.net), backgroundColor: '#134E4A' }],
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: dark ? '#bbb' : '#556' } },
            y: { ticks: { color: dark ? '#bbb' : '#556', font: { size: 10 } }, grid: { display: false } },
          },
        },
      });
    }
  }

  /* ---------------- view registrations ---------------- */
  App.registerView('dashboard', renderDashboard);
  App.registerView('addtx', (host) => { const p = App.pendingPreset; App.pendingPreset = null; txForm(host, null, p); });
  App.registerView('additions', (host) => txTable(host, {
    title: global.UI.getLang() === 'ar' ? 'إنتاج وإضافات' : 'Additions',
    filter: (r) => (Number(r.addQty) || 0) > 0, preset: 'add',
  }));
  App.registerView('withdrawals', (host) => txTable(host, {
    title: global.UI.getLang() === 'ar' ? 'الصرف والمبيعات' : 'Withdrawals & Sales',
    filter: (r) => (Number(r.outQty) || 0) > 0, preset: 'out',
  }));
  App.registerView('history', (host) => txTable(host, {
    title: global.UI.getLang() === 'ar' ? 'سجل الحركات' : 'Transaction history',
    filter: () => true, preset: null,
  }));

  /* ---------------- boot ---------------- */
  async function boot() {
    UI.setLang((await global.DB.getSetting('lang', 'ar')) || 'ar');
    const langBtn = document.getElementById('lang-switch');
    if (langBtn) langBtn.addEventListener('click', async () => {
      const nl = UI.getLang() === 'ar' ? 'en' : 'ar';
      UI.setLang(nl);
      await global.DB.setSetting('lang', nl);
      navigate(currentRoute);
    });
    /* nav */
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.addEventListener('click', (e) => { e.preventDefault(); navigate(n.dataset.route); });
    });
    const burger = document.getElementById('nav-toggle');
    if (burger) burger.addEventListener('click', () => document.body.classList.toggle('nav-open'));

    await loadAll();
    document.body.classList.add('loaded');
    navigate((location.hash || '#dashboard').replace('#', ''));

    window.addEventListener('hashchange', () => {
      const r = location.hash.replace('#', '');
      if (r && r !== currentRoute) navigate(r);
    });

    /* PWA service worker */
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      try { await navigator.serviceWorker.register('sw.js'); console.log('SW registered'); } catch (e) { console.warn('SW failed', e); }
    }

    /* offline indicator */
    const badge = document.getElementById('net-status');
    const upd = () => { if (badge) { badge.textContent = navigator.onLine ? '' : t('offline'); badge.classList.toggle('show', !navigator.onLine); } };
    window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
  }

  global.App = App;
  document.addEventListener('DOMContentLoaded', boot);
})(window);
