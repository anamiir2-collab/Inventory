/* =========================================================================
   app.js — التشغيل، الحالة العامة، التنقل، لوحة التحكم، نموذج تسجيل الحركة
   -------------------------------------------------------------------------
   Startup is defensive by design: every critical step is awaited inside
   boot() which reports failures on the loading screen itself (never an
   endless "جاري التحميل"). IndexedDB errors, offline mode and JS errors
   are surfaced with distinct messages + a retry button.
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

  /* ---------------- shared helpers ---------------- */

  /* The business only has TWO product types. Everything else in the data is
     historical noise; map by name so all screens agree on one canonical set. */
  function productFamily(name) {
    const value = String(name || '').replace(/[\s\u0640]+/g, ' ').trim().toLowerCase();
    if (value.includes('تست') && value.includes('لينر') && value.includes('معالج')) return 'تست لينر معالج';
    if (value.includes('توب') && value.includes('لاينر')) return 'توب لاينر';
    return String(name || '').trim();
  }
  App.productFamily = productFamily;
  const CANON_FAMILIES = ['تست لينر معالج', 'توب لاينر'];

  /* production customer appears in the data as both 'انتاج' and 'الإنتاج' */
  function isProductionCustomer(name) {
    const v = String(name || '').replace(/[\s\u0640]+/g, '').toLowerCase();
    return v === 'انتاج' || v === 'الانتاج' || v === 'إنتاج' || v === 'الإنتاج';
  }
  function canonicalCustomer(name) {
    return isProductionCustomer(name) ? 'الإنتاج' : String(name || '').trim();
  }
  App.canonicalCustomer = canonicalCustomer;

  /* unique customer list for dropdowns (production variants merged) */
  function customerOptions() {
    const seen = new Map();
    for (const r of App.state.transactions) {
      const raw = String(r.customer || '').trim();
      if (!raw) continue;
      const key = canonicalCustomer(raw);
      if (!seen.has(key)) seen.set(key, key);
    }
    return [...seen.keys()].filter((k) => k !== 'الإنتاج').sort((a, b) => a.localeCompare(b, 'ar'));
  }

  /* group transactions that belong to one movement (multi-size entry);
     legacy rows without groupId act as single-row groups */
  function buildGroups(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = r.groupId ? 'G:' + r.groupId : 'S:' + (r.id || 0);
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          groupId: r.groupId || null,
          legacyId: r.groupId ? null : r.id,
          date: r.date,
          quality: r.quality,
          gsm: r.gsm,
          customer: r.customer,
          permitNo: r.permitNo,
          settlement: r.settlement,
          notes: r.notes,
          source: r.source,
          void: r.void,
          rows: [],
        };
        map.set(key, g);
      }
      g.rows.push(r);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.rows.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
      g.add = g.rows.reduce((s, r) => s + (Number(r.addQty) || 0), 0);
      g.out = g.rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0);
      g.sizesLabel = g.rows.map((r) => `${fmtNum(r.size == null ? '—' : r.size)}×${fmtNum(r.addQty || r.outQty || 0)}`).join('، ');
    }
    groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.rows[0].id || 0) - (a.rows[0].id || 0)));
    return groups;
  }
  App.buildGroups = buildGroups;

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
    if (!host) { console.error('[app] #view host missing'); return; }
    host.innerHTML = '';
    Promise.resolve(view(host)).catch((e) => {
      console.error('[view]', currentRoute, e);
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

  /* ---------------- movement form (add / edit group) ---------------- */
  function nextGroupId() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }

  /**
   * Full-page form for registering a movement.
   * - add:  date, product (family), gsm, multiple size+qty rows
   * - edit: same, prefilled from an existing movement GROUP; children are
   *   replaced atomically (audited). Legacy single rows open a simple modal.
   */
  function txForm(host, editGroup, preset) {
    const isEdit = !!editGroup;
    const type = preset || (editGroup ? (editGroup.add > 0 ? 'add' : 'out') : 'add');
    const customers = customerOptions();
    const families = CANON_FAMILIES.filter((family) =>
      App.state.products.some((p) => productFamily(p.quality) === family));
    const existing = editGroup || null;

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit
        ? (UI.getLang() === 'ar' ? 'تعديل حركة' : 'Edit movement')
        : (type === 'out' ? (UI.getLang() === 'ar' ? 'حركة صرف جديدة' : 'New withdrawal') : (UI.getLang() === 'ar' ? 'حركة إنتاج جديدة' : 'New production movement'))}</h2></div>
      <div class="card form-card">
        <form id="tx-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="f-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field"><span>${t('quality')} *</span>
              <select id="f-quality" required>
                <option value="">— ${UI.getLang() === 'ar' ? 'اختر الصنف' : 'select product'} —</option>
                ${families.map((family) => `<option value="${esc(family)}" ${existing && productFamily(existing.quality) === family ? 'selected' : ''}>${esc(family)}</option>`).join('')}
              </select></label>
            <label class="field"><span>${t('gsm')} *</span>
              <input type="number" id="f-gsm" min="1" step="any" placeholder="135" value="${esc(existing && existing.gsm != null ? existing.gsm : '')}"></label>
            ${type === 'out'
              ? `<label class="field" id="f-customer-wrap"><span>${UI.getLang() === 'ar' ? 'العميل' : 'Customer'} *</span>
                   <input type="text" id="f-customer" list="customer-list" required value="${esc(existing ? canonicalCustomer(existing.customer) : '')}">
                   <datalist id="customer-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>`
              : `<div class="field" id="f-production-note"><span>${UI.getLang() === 'ar' ? 'جهة الإضافة' : 'Addition source'}</span><strong>${UI.getLang() === 'ar' ? 'الإنتاج' : 'Production'}</strong></div>`}
            <label class="field"><span>${t('permit')}</span>
              <input type="text" id="f-permit" value="${esc(existing ? existing.permitNo : '')}"></label>
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
          <section class="field field-wide" id="multi-size-section">
            <div class="card-head-row"><strong>${UI.getLang() === 'ar' ? 'المقاسات والكميات' : 'Sizes and quantities'}</strong>
              <button type="button" class="btn btn-ghost" id="add-size-row">+ ${UI.getLang() === 'ar' ? 'إضافة مقاس' : 'Add size'}</button></div>
            <div id="size-rows"></div>
          </section>
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
    let moveType = type;

    /* size rows: one row per (size, qty); existing groups prefill their lines */
    const rowsHost = host.querySelector('#size-rows');
    const addSizeRow = (sizeValue = '', qtyValue = '') => {
      const row = document.createElement('div');
      row.className = 'size-entry-row';
      row.innerHTML =
        '<label class="field"><span>' + t('size') + ' *</span><input class="line-size" type="number" min="1" step="any" placeholder="100"></label>' +
        '<label class="field"><span class="line-qty-label"></span><input class="line-qty" type="number" min="1" step="1" placeholder="0"></label>' +
        '<button type="button" class="btn btn-ghost remove-size-row" aria-label="remove">×</button>' +
        '<div class="line-balance small"></div>';
      row.querySelector('.line-size').value = sizeValue == null ? '' : sizeValue;
      row.querySelector('.line-qty').value = qtyValue == null ? '' : qtyValue;
      row.querySelector('.line-qty-label').textContent = (moveType === 'add' ? t('addQty') : t('outQty')) + ' *';
      rowsHost.appendChild(row);
      row.querySelector('.remove-size-row').addEventListener('click', () => {
        if (rowsHost.querySelectorAll('.size-entry-row').length === 1) {
          row.querySelector('.line-size').value = '';
          row.querySelector('.line-qty').value = '';
        } else row.remove();
        updateHint();
      });
      const updateLineHint = () => {
        const size = Number(row.querySelector('.line-size').value);
        const q = qSel.value, gsm = Number(gsmIn.value);
        const hint = row.querySelector('.line-balance');
        if (q && gsm > 0 && size > 0) {
          const bal = balanceOf(q, gsm, size);
          let txt = (UI.getLang() === 'ar' ? 'الرصيد الحالي: ' : 'Current balance: ') + fmtNum(bal.net);
          if (moveType === 'out' && Number(row.querySelector('.line-qty').value) > bal.net) {
            txt += (UI.getLang() === 'ar' ? ' — الكمية أكبر من الرصيد' : ' — exceeds balance');
          }
          hint.textContent = txt;
        } else hint.textContent = '';
      };
      row.querySelector('.line-size').addEventListener('input', () => { updateLineHint(); updateHint(); });
      row.querySelector('.line-qty').addEventListener('input', () => { updateLineHint(); updateHint(); });
      return row;
    };
    host.querySelector('#add-size-row').addEventListener('click', () => { addSizeRow(); updateHint(); });
    if (isEdit && existing) {
      existing.rows.forEach((r) => addSizeRow(r.size, r.addQty || r.outQty || 0));
    } else {
      addSizeRow();
    }
    qSel.addEventListener('change', () => {
      rowsHost.querySelectorAll('.size-entry-row').forEach((row) => row.querySelector('.line-size').dispatchEvent(new Event('input')));
    });
    gsmIn.addEventListener('input', () => {
      rowsHost.querySelectorAll('.size-entry-row').forEach((row) => row.querySelector('.line-size').dispatchEvent(new Event('input')));
    });

    function updateHint() {
      const hint = host.querySelector('#balance-hint');
      if (!hint) return;
      const lines = readLines();
      if (!qSel.value || !Number(gsmIn.value) || !lines.length) { hint.innerHTML = ''; return; }
      const g = global.CALC.round6(lines.reduce((s, l) => s + l.qty, 0));
      hint.innerHTML = (UI.getLang() === 'ar' ? 'إجمالي الكمية: ' : 'Total quantity: ') + `<strong>${fmtNum(g)}</strong>`;
    }
    [qSel, gsmIn].forEach((i) => i.addEventListener('change', updateHint));

    host.querySelector('#f-cancel').addEventListener('click', () => navigate(history_source || 'history'));

    function readLines() {
      return [...host.querySelectorAll('.size-entry-row')].map((row) => ({
        size: Number(row.querySelector('.line-size').value),
        qty: Number(row.querySelector('.line-qty').value),
      })).filter((l) => Number.isFinite(l.size) && l.size > 0);
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#form-error');
      errBox.textContent = '';
      const quality = qSel.value.trim();
      const gsm = gsmIn.value ? Number(gsmIn.value) : null;
      const customer = type === 'add' ? 'الإنتاج' : host.querySelector('#f-customer').value.trim();
      const lines = readLines();
      const header = {
        date: host.querySelector('#f-date').value,
        quality, gsm,
        customer,
        permitNo: host.querySelector('#f-permit').value.trim(),
        weight: host.querySelector('#f-weight').value === '' ? null : Number(host.querySelector('#f-weight').value),
        settlement: host.querySelector('#f-settlement').value,
        notes: host.querySelector('#f-notes').value.trim(),
        source: isEdit ? (existing.source || 'manual') : 'manual',
      };

      if (!/^\d{4}-\d{2}-\d{2}$/.test(header.date) || !quality || !Number.isFinite(gsm) || gsm <= 0 ||
          (type === 'out' && !header.customer) || !lines.length) {
        errBox.textContent = UI.getLang() === 'ar'
          ? 'أكمل التاريخ والصنف والجرام' + (type === 'out' ? ' والعميل' : '') + '، وأدخل مقاسًا صحيحًا لكل سطر.'
          : 'Complete date, product and GSM' + (type === 'out' ? ' and customer' : '') + ', then enter a valid size in every row.';
        return;
      }
      if (lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) {
        errBox.textContent = UI.getLang() === 'ar'
          ? 'أدخل كمية صحيحة أكبر من صفر لكل مقاس.'
          : 'Enter a quantity greater than zero for every size.';
        return;
      }
      const uniqueSizes = new Set(lines.map((l) => String(l.size)));
      if (uniqueSizes.size !== lines.length) {
        errBox.textContent = UI.getLang() === 'ar'
          ? 'يوجد مقاس مكرر. اجمع الكمية الخاصة به في سطر واحد.'
          : 'A size is repeated. Combine its quantity into one row.';
        return;
      }

      const pending = lines.map((l) => Object.assign({}, header, {
        size: l.size,
        addQty: type === 'add' ? l.qty : 0,
        outQty: type === 'out' ? l.qty : 0,
      }));
      /* withdrawal above balance → explicit confirmation, never silent */
      const negative = pending.filter((line) => type === 'out' &&
        balanceOf(quality, gsm, line.size).net - line.outQty < 0);
      if (negative.length) {
        const ok = await confirmDialog({
          title: t('confirm'),
          message: UI.getLang() === 'ar'
            ? `تنبيه: الصرف أكبر من الرصيد في ${negative.length} مقاس (${negative.map((n) => n.size).join('، ')}). هل تريد المتابعة؟`
            : `Warning: withdrawal exceeds stock for ${negative.length} size(s) (${negative.map((n) => n.size).join(', ')}). Continue?`,
          danger: true, yesLabel: UI.getLang() === 'ar' ? 'متابعة بالسالب' : 'Proceed',
        });
        if (!ok) return;
      }

      try {
        if (isEdit) {
          await global.TX.replaceMovement(existing, pending, type);
          toast(UI.getLang() === 'ar' ? 'تم تحديث الحركة وتحديث الرصيد تلقائيًا' : 'movement updated, balances recalculated', 'ok');
        } else {
          const groupId = nextGroupId();
          for (const line of pending) await global.TX.addTransaction(Object.assign({ groupId }, line));
          toast(UI.getLang() === 'ar'
            ? `تم تسجيل ${pending.length} مقاس وتحديث الأرصدة`
            : `${pending.length} size(s) saved and balances updated`, 'ok');
        }
        await refresh();
        navigate(type === 'add' ? 'additions' : 'withdrawals');
      } catch (saveError) {
        if (saveError && saveError.type === 'validation') {
          errBox.innerHTML = saveError.errors.map((x) => `• ${esc(x.msg)}`).join('<br>');
        } else {
          errBox.textContent = String(saveError.message || saveError);
          console.error(saveError);
        }
      }
    });
  }
  App.openTxForm = txForm;
  let history_source = 'history';

  /* ---------------- shared table renderer for movement lists ---------------- */
  function txTable(host, opts) {
    const lang = UI.getLang() === 'ar';
    let rows = App.state.transactions.slice();
    rows = rows.filter(opts.filter || (() => true));
    const customers = customerOptions();
    const families = CANON_FAMILIES.filter((f) => App.state.products.some((p) => productFamily(p.quality) === f));
    const showFilters = opts.preset === 'out' || opts.preset === null; /* withdrawals + history keep filters */
    host.innerHTML = `
      <div class="page-head"><h2>${esc(opts.title)}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="btn-add-tx">+ ${lang ? 'حركة جديدة' : 'New movement'}</button>
          <button class="btn btn-ghost" id="btn-exp-tx">${t('exportExcel')}</button>
        </div></div>
      ${showFilters ? `<div class="card filters">
        <input type="date" id="flt-from" title="${t('from')}">
        <input type="date" id="flt-to" title="${t('to')}">
        <input type="text" id="flt-q" list="flt-qlist" placeholder="${t('quality')}">
        <datalist id="flt-qlist">${families.map((q) => `<option value="${esc(q)}"></option>`).join('')}</datalist>
        <input type="text" id="flt-c" list="flt-clist" placeholder="${t('customer')}">
        <datalist id="flt-clist">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
        <input type="text" id="flt-text" placeholder="${lang ? 'بحث في إذن الصرف / ملاحظات' : 'search permit/notes'}">
        <select id="flt-settle"><option value="">${t('settlement')}: ${t('all')}</option><option value="غ">غ</option><option value="ض">ض</option></select>
        <button class="btn btn-ghost" id="flt-clear">${t('reset')}</button>
      </div>` : ''}
      <div class="card table-wrap" id="tx-table-host"></div>`;

    const host2 = host.querySelector('#tx-table-host');
    const PAGE_SIZE = 120; /* groups per page — the real file has ~24k rows */
    let curGroups = [], page = 0;

    function applyFilters() {
      let list = rows;
      if (showFilters) {
        const from = host.querySelector('#flt-from').value;
        const to = host.querySelector('#flt-to').value;
        const q = host.querySelector('#flt-q').value.trim();
        const c = host.querySelector('#flt-c').value.trim();
        const text = host.querySelector('#flt-text').value.trim().toLowerCase();
        const st = host.querySelector('#flt-settle').value;
        list = rows.filter((r) =>
          (!from || r.date >= from) && (!to || r.date <= to) &&
          (!q || productFamily(r.quality) === q) &&
          (!c || canonicalCustomer(r.customer) === c) &&
          (!st || r.settlement === st) &&
          (!text || (r.permitNo || '').toLowerCase().includes(text) || (r.notes || '').toLowerCase().includes(text)));
      }
      curGroups = buildGroups(list);
      page = 0;
      renderRows();
    }

    function renderRows() {
      const total = curGroups.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      const slice = curGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const sumAdd = curGroups.reduce((s, g) => s + g.add, 0);
      const sumOut = curGroups.reduce((s, g) => s + g.out, 0);
      const nRows = curGroups.reduce((s, g) => s + g.rows.length, 0);
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${t('date')}</th><th>${t('quality')}</th><th>${t('gsm')}</th>
            <th>${lang ? 'المقاسات والكميات' : 'Sizes & quantities'}</th>
            <th>${t('customer')}</th><th>${t('permit')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th>${t('settlement')}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map(groupRowHtml).join('') :
            `<tr><td colspan="10" class="empty">${esc(t('emptyState'))}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="6">${t('total')} (${fmtNum(total)} ${lang ? 'حركة' : 'movements'} — ${fmtNum(nRows)} ${lang ? 'سطر' : 'rows'})</td>
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
          const key = btn.dataset.key;
          const act = btn.dataset.act;
          const group = curGroups.find((g) => g.key === key);
          if (!group) return;
          if (act === 'edit') {
            if (group.groupId) {
              App.pendingEdit = group;
              history_source = opts.preset === 'add' ? 'additions' : opts.preset === 'out' ? 'withdrawals' : 'history';
              navigate('addtx');
            } else {
              openLegacyEditModal(group.rows[0]);
            }
          } else if (act === 'del') {
            const ok = await confirmDialog({
              title: lang ? 'حذف حركة' : 'Delete movement',
              message: lang
                ? (group.rows.length > 1
                  ? `سيتم حذف الحركة بكل مقاساتها (${group.rows.length} سطر) نهائيًا وتحديث الرصيد تلقائيًا.\nالصنف: ${group.quality} — الجرام: ${group.gsm}\nالمقاسات: ${group.sizesLabel}`
                  : `سيتم حذف الحركة نهائيًا وتحديث الرصيد تلقائيًا.\nالصنف: ${group.quality} — الجرام: ${group.gsm} — المقاس: ${group.rows[0].size} — الكمية: ${group.add || group.out}`)
                : `Delete this movement permanently and recalculate balances?\n${group.quality} / ${group.gsm} — ${group.sizesLabel}`,
              danger: true, extra: lang ? `<code>${esc(group.date)} — ${esc(canonicalCustomer(group.customer) || '')}</code>` : '',
            });
            if (ok) {
              await global.TX.deleteMovement(group);
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
      bind('#pg-last', () => { page = Math.ceil(curGroups.length / PAGE_SIZE) - 1; });
    }

    function groupRowHtml(g) {
      const voidBadge = g.void ? `<span class="badge badge-void">${lang ? 'ملغاة' : 'void'}</span>` : '';
      const first = g.rows[0];
      const incomplete = !global.CALC.isComboComplete(first.quality, first.gsm, first.size) && !g.void
        ? `<span class="badge badge-warn" title="${lang ? 'ببيانات ناقصة — لا تدخل في حساب الرصيد' : 'incomplete — excluded from balances'}">⚠</span>` : '';
      const multi = g.rows.length > 1 ? `<span class="badge badge-multi">${g.rows.length} ${lang ? 'مقاس' : 'sizes'}</span>` : '';
      return `<tr class="${g.add > 0 ? 'row-add' : 'row-out'}">
        <td data-label="${t('date')}">${fmtDate(g.date)}</td>
        <td data-label="${t('quality')}">${esc(productFamily(g.quality))} ${voidBadge}${incomplete}</td>
        <td data-label="${t('gsm')}">${g.gsm == null ? '—' : fmtNum(g.gsm)}</td>
        <td data-label="${lang ? 'المقاسات والكميات' : 'Sizes'}"><span class="sizes-label">${esc(g.sizesLabel)}</span> ${multi}</td>
        <td data-label="${t('customer')}">${esc(canonicalCustomer(g.customer) || '')}</td>
        <td data-label="${t('permit')}">${esc(g.permitNo || '')}</td>
        <td class="num pos" data-label="${t('addQty')}">${g.add ? fmtNum(g.add) : ''}</td>
        <td class="num neg" data-label="${t('outQty')}">${g.out ? fmtNum(g.out) : ''}</td>
        <td data-label="${t('settlement')}">${esc(g.settlement || '')}</td>
        <td class="actions-cell">
          <button class="icon-btn" data-act="edit" data-key="${esc(g.key)}" title="${t('edit')}">✎</button>
          <button class="icon-btn danger" data-act="del" data-key="${esc(g.key)}" title="${t('del')}">🗑</button>
        </td></tr>`;
    }

    /* legacy rows (imported from Excel, no groupId) keep the simple editor */
    function openLegacyEditModal(txRow) {
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

    if (showFilters) {
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
    }
    host.querySelector('#btn-add-tx').addEventListener('click', () => {
      App.pendingEdit = null;
      App.pendingPreset = opts.preset === 'out' ? 'out' : 'add';
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
    const I = global.UI.ICON;
    const cards = [
      { icon: I.products, num: fmtNum(products.length), label: t('totalProducts'), accent: 'teal' },
      { icon: I.balance, num: fmtNum(stockTotal), label: `${t('totalBalance')} (${t('rolls')})`, accent: 'green' },
      { icon: I.add, num: fmtNum(g.add), label: lang ? 'إجمالي الإضافات للإنتاج' : 'Total production additions', accent: 'green' },
      { icon: I.out, num: fmtNum(g.out), label: lang ? 'إجمالي الصرف للعملاء' : 'Total customer withdrawals', accent: 'amber' },
      { icon: I.countAdd, num: fmtNum(g.nAdd), label: lang ? 'عدد حركات الإضافة' : 'Addition movements', accent: 'teal' },
      { icon: I.countOut, num: fmtNum(g.nOut), label: lang ? 'عدد حركات الصرف' : 'Withdrawal movements', accent: 'amber' },
    ];

    host.innerHTML = `
      <div class="page-head"><h2>${lang ? 'لوحة التحكم' : 'Dashboard'}</h2>
        <div class="head-actions">
          ${tx.length === 0 ? `<button class="btn btn-primary" id="btn-import-dash">${t('importExcel')}</button>` : ''}
          <button class="btn btn-primary" id="btn-new-dash">+ ${lang ? 'حركة جديدة' : 'New movement'}</button>
        </div></div>
      <div class="stats-grid">
        ${cards.map((c) => `<div class="stat-card accent-${c.accent}">
          <div class="stat-icon">${c.icon}</div>
          <div class="stat-num">${c.num}</div>
          <div class="stat-label">${esc(c.label)}</div>
        </div>`).join('')}
      </div>
      <div class="card weight-line">${lang ? 'إجمالي وزن الرصيد التقديري' : 'Estimated stock weight'}: <strong>${fmtNum(weightTotal, 2)}</strong> ${t('kg')} <span class="muted">(${lang ? 'المقاس × الرصيد ×' : 'size × balance ×'} ${App.state.settings.weightFactor})</span></div>
      <div class="dash-grid">
        <div class="card chart-card"><h3>${t('monthlyMovement')}</h3><div class="chart-box"><canvas id="chart-monthly"></canvas></div></div>
        <div class="card chart-card"><h3>${t('topProducts')}</h3><div class="chart-box"><canvas id="chart-top"></canvas></div></div>
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
        <td>${fmtDate(r.date)}</td><td>${esc(productFamily(r.quality))}</td>
        <td>${r.gsm == null ? '—' : fmtNum(r.gsm)}</td><td>${r.size == null ? '—' : fmtNum(r.size)}</td>
        <td>${esc(canonicalCustomer(r.customer) || '')}</td>
        <td class="num pos">${r.addQty ? fmtNum(r.addQty) : ''}</td>
        <td class="num neg">${r.outQty ? fmtNum(r.outQty) : ''}</td></tr>`).join('');
    }

    host.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));
    const imp = host.querySelector('#btn-import-dash');
    if (imp) imp.addEventListener('click', () => global.BACKUP.openImportDialog());
    host.querySelector('#btn-new-dash').addEventListener('click', () => {
      App.pendingEdit = null;
      App.pendingPreset = 'add';
      navigate('addtx');
    });

    drawCharts(host);
  }

  /* charts are (re)created on every render → destroy previous instances to
     avoid leaking canvas contexts and animation frames */
  const _charts = { monthly: null, top: null };
  function drawCharts(host) {
    if (!global.Chart) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    const tick = dark ? '#9fb3c8' : '#64748B';
    const months = {};
    for (const r of App.state.transactions) {
      if (!r.date) continue;
      const m = r.date.slice(0, 7);
      months[m] = months[m] || { a: 0, o: 0 };
      months[m].a += Number(r.addQty) || 0;
      months[m].o += Number(r.outQty) || 0;
    }
    const keys = Object.keys(months).sort().slice(-12);
    const monthlyCanvas = host.querySelector('#chart-monthly');
    if (monthlyCanvas && keys.length) {
      if (_charts.monthly) { _charts.monthly.destroy(); _charts.monthly = null; }
      _charts.monthly = new global.Chart(monthlyCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: keys.map((k) => k.slice(0, 4) + '/' + k.slice(5, 7)),
          datasets: [
            { label: t('add'), data: keys.map((k) => months[k].a), backgroundColor: '#14B8A6', borderRadius: 5, maxBarThickness: 26 },
            { label: t('out'), data: keys.map((k) => months[k].o), backgroundColor: '#D97706', borderRadius: 5, maxBarThickness: 26 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: tick, boxWidth: 10, font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: tick, font: { size: 10 } }, grid: { display: false } },
            y: { ticks: { color: tick, font: { size: 10 } }, grid: { color: 'rgba(100,116,139,.12)' } },
          },
        },
      });
    }
    const arr = [];
    for (const p of App.state.products) {
      const b = App.state.balances.get(p.combo);
      const net = b ? b.net : 0;
      if (net > 0) arr.push({ label: `${productFamily(p.quality)} ${p.gsm}g — ${p.size}`, net });
    }
    arr.sort((a, b) => b.net - a.net);
    const top = arr.slice(0, 10);
    const topCanvas = host.querySelector('#chart-top');
    if (topCanvas && top.length) {
      if (_charts.top) { _charts.top.destroy(); _charts.top = null; }
      _charts.top = new global.Chart(topCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: top.map((x) => x.label),
          datasets: [{ label: t('balance'), data: top.map((x) => x.net), backgroundColor: '#134E4A', borderRadius: 5, maxBarThickness: 16 }],
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: tick, font: { size: 10 } }, grid: { color: 'rgba(100,116,139,.12)' } },
            y: { ticks: { color: tick, font: { size: 10 } }, grid: { display: false } },
          },
        },
      });
    }
  }

  /* ---------------- view registrations ---------------- */
  App.registerView('dashboard', renderDashboard);
  App.registerView('addtx', (host) => {
    const edit = App.pendingEdit; App.pendingEdit = null;
    const preset = edit ? null : (App.pendingPreset == null ? 'add' : App.pendingPreset);
    App.pendingPreset = null;
    txForm(host, edit, preset);
  });
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
  function setLoadingStatus(msg) {
    const el2 = document.getElementById('boot-status');
    if (el2) el2.textContent = msg;
  }

  async function boot() {
    if (boot._started) return; /* prevent double initialization */
    boot._started = true;

    setLoadingStatus(UI.getLang() === 'ar' ? 'فتح قاعدة البيانات المحلية…' : 'Opening the local database…');
    await global.DB.open(); /* typed errors: blocked / timeout / unavailable */

    setLoadingStatus(UI.getLang() === 'ar' ? 'تحميل الأصناف والحركات…' : 'Loading products & movements…');
    const langBtn = document.getElementById('lang-switch');
    if (langBtn) langBtn.addEventListener('click', async () => {
      const nl = UI.getLang() === 'ar' ? 'en' : 'ar';
      UI.setLang(nl);
      await global.DB.setSetting('lang', nl);
      navigate(currentRoute);
    });
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.addEventListener('click', (e) => { e.preventDefault(); navigate(n.dataset.route); });
    });
    const burger = document.getElementById('nav-toggle');
    if (burger) burger.addEventListener('click', () => document.body.classList.toggle('nav-open'));
    const backdrop = document.getElementById('nav-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeMobileNav);

    await loadAll();
    document.body.classList.add('loaded');
    navigate((location.hash || '#dashboard').replace('#', ''));

    window.addEventListener('hashchange', () => {
      const r = location.hash.replace('#', '');
      if (r && r !== currentRoute) navigate(r);
    });

    /* PWA service worker — registered after the app renders so a slow SW
       can never block first paint; updates prompt instead of blocking. */
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        console.log('[sw] registered, scope', reg.scope);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[sw] new version waiting');
              toast(UI.getLang() === 'ar' ? 'تحديث جديد متاح — أعد تحميل الصفحة للتطبيق عليه' : 'Update available — reload to apply', 'info', 8000);
            }
          });
        });
      }).catch((e) => console.warn('[sw] registration failed', e));
    }

    /* offline indicator — distinct from database errors */
    const badge = document.getElementById('net-status');
    const upd = () => { if (badge) { badge.textContent = navigator.onLine ? '' : t('offline'); badge.classList.toggle('show', !navigator.onLine); } };
    window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
  }

  global.App = App;

  /* global error diagnostics — never silently swallow runtime failures */
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
  });
  window.addEventListener('error', (e) => {
    console.error('[script error]', e.message, e.filename + ':' + e.lineno);
  });

  /* startup screen: visible progress, typed error screen, retry button */
  function showBootError(error) {
    const host = document.getElementById('view');
    if (!host) return;
    const ar = UI.getLang() === 'ar';
    const kind = error && error.kind;
    let title = ar ? 'تعذر تشغيل البرنامج' : 'The app could not start';
    let hint = '';
    if (kind === 'blocked' || /أغلق أي تبويبات/.test(error.message || '')) {
      title = ar ? 'قاعدة البيانات مشغولة' : 'Database is busy';
      hint = ar
        ? 'يبدو أن نسخة أخرى من البرنامج مفتوحة في تبويب آخر. أغلقها ثم أعد المحاولة.'
        : 'Another tab seems to hold the database. Close it and retry.';
    } else if (!navigator.onLine && !location.protocol.startsWith('http')) {
      title = ar ? 'لا يوجد اتصال' : 'You are offline';
      hint = ar ? 'افتح البرنامج مرة واحدة مع اتصال إنترنت حتى يُثبَّت للعمل بدون إنترنت.' : 'Open once online so the app can install for offline use.';
    }
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    console.error('[startup failed]', error);
    host.innerHTML = `
      <div class="boot-error" role="alert">
        <div class="boot-error-ic">⚠️</div>
        <h2>${esc(title)}</h2>
        <p>${ar ? 'حدثت مشكلة أثناء فتح قاعدة البيانات المحلية أو تحميل ملفات البرنامج.' : 'A problem occurred while opening the local database or loading app files.'}</p>
        ${hint ? `<p class="boot-error-hint">${esc(hint)}</p>` : ''}
        <p class="muted small" style="overflow-wrap:anywhere" dir="ltr">${esc(message)}</p>
        <button type="button" class="btn btn-primary" id="boot-retry">${ar ? 'إعادة المحاولة' : 'Try again'}</button>
        <p class="muted small">${ar ? 'بياناتك المحفوظة لم تُحذف — بقاءها مضمون. إن استمرت المشكلة أرسل صورة لهذه الرسالة.' : 'Your saved data was NOT deleted. If this persists, send a screenshot of this message.'}</p>
      </div>`;
    const retry = host.querySelector('#boot-retry');
    if (retry) retry.addEventListener('click', () => location.reload());
  }

  document.addEventListener('DOMContentLoaded', () => {
    let settled = false;
    /* belt & braces: even if boot() somehow never settles, show a way out */
    const startupTimer = setTimeout(() => {
      if (!settled) showBootError(global.UI.I18N && new Error(
        UI.getLang() === 'ar'
          ? 'استغرق بدء التشغيل أكثر من 15 ثانية. أغلق أي تبويبات أخرى للتطبيق ثم أعد المحاولة.'
          : 'Startup took longer than 15 seconds. Close other app tabs and retry.'
      ));
    }, 15000);
    boot().then(() => {
      settled = true;
      clearTimeout(startupTimer);
      const loading = document.getElementById('boot-loading');
      if (loading) loading.remove();
    }).catch((error) => {
      settled = true;
      clearTimeout(startupTimer);
      showBootError(error);
    });
  });
})(window);
