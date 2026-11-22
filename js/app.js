/* =========================================================================
   app.js — التشغيل، الحالة العامة، التنقل، لوحة التحكم، نموذجي
   «حركة متابعة البكر»: إضافة إنتاج + صرف للعملاء (أذون بترقيم مستقل)
   -------------------------------------------------------------------------
   Startup is defensive by design: every critical step is awaited inside
   boot() which reports failures on the loading screen itself (never an
   endless "جاري التحميل"). IndexedDB errors, offline mode and JS errors
   are surfaced with distinct messages + a retry button.

   Routes:
     #dashboard  لوحة التحكم
     #baker      حركة متابعة البكر (بطاقتا العملية + قائمة الإضافات)
     #baker-add  إضافة إنتاج (منتج وجرام ووزن واحد + مقاسات متعددة)
     #baker-issue صرف للعملاء (إذن بمجموعات متعددة، ترقيم ضريبي/غير ضريبي)
     #issuedocs  أذون الصرف (issuedocs.js) · #issuedoc عرض الإذن A4
     #history    سجل الحركات · #addtx محرر الحركات المختلطة القديمة فقط
   Legacy links: #additions → #baker · #withdrawals → #issuedocs
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
      balancesW: new Map(), /* roll-weight dimension: product→gsm→weight→size */
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

  /* product dropdown: the two approved products are ALWAYS offered (even on
     a fresh database); historical non-canonical families stay for old data */
  function familyOptions() {
    const extra = [];
    for (const p of App.state.products) {
      const f = productFamily(p.quality);
      if (!CANON_FAMILIES.includes(f) && !extra.includes(f)) extra.push(f);
    }
    return CANON_FAMILIES.concat(extra);
  }

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
    App.state.balancesW = global.CALC.computeBalancesByWeight(transactions);
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

  /* helper: balance of a combo from the live map (all roll weights combined) */
  function balanceOf(quality, gsm, size) {
    const key = global.CALC.comboKey(quality, gsm, size);
    return App.state.balances.get(key) || { quality, gsm, size, add: 0, out: 0, net: 0 };
  }
  App.balanceOf = balanceOf;

  /* helper: balance inside ONE roll-weight bucket (weight null → legacy rows) */
  function balanceBy(quality, gsm, weight, size) {
    const key = global.CALC.comboKeyW(quality, gsm, weight, size);
    return App.state.balancesW.get(key) || { quality, gsm, weight, size, add: 0, out: 0, net: 0 };
  }
  App.balanceBy = balanceBy;

  /* ---------------- router ---------------- */
  /* old links keep working: additions/withdrawals were reorganized into
     حركة متابعة البكر and أذون الصرف */
  const ROUTE_REDIRECT = { additions: 'baker', withdrawals: 'issuedocs' };
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
    const target = ROUTE_REDIRECT[route] || route;
    currentRoute = target;
    /* keep the URL in sync (deep links + refresh keep their context);
       replaceState avoids an extra history entry and hashchange loops */
    if (location.hash !== '#' + target) {
      try { history.replaceState(null, '', '#' + target); } catch (e2) { /* ignore */ }
    }
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.route === target);
    });
    document.title = `${t(target) || ''} — ${t('appName')}`;
    render();
    closeMobileNav();
  }
  App.navigate = navigate;
  App.rerender = render;
  App.currentRoute = () => currentRoute;

  function closeMobileNav() {
    document.body.classList.remove('nav-open');
  }

  /* ---------------- shared dropdown data ---------------- */
  function knownGsms(family) {
    const set = new Set();
    for (const p of App.state.products) {
      if (family && productFamily(p.quality) !== family) continue;
      if (p.gsm != null && p.gsm !== '') set.add(String(p.gsm));
    }
    return [...set].sort((a, b) => Number(a) - Number(b));
  }
  function knownWeights() {
    const set = new Set();
    for (const r of App.state.transactions) {
      if (r.weight != null && r.weight !== '') set.add(String(Number(r.weight)));
    }
    return [...set].sort((a, b) => Number(a) - Number(b));
  }
  App.knownGsms = knownGsms;
  App.knownWeights = knownWeights;

  /* ---------------- movement form (add / edit group) ---------------- */
  function nextGroupId() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }

  /**
   * Legacy unified movement form — kept ONLY for editing the rare mixed
   * (إضافة + صرف) groups; the daily flows are #baker-add / #baker-issue.
   */
  function txForm(host, editGroup, preset) {
    const isEdit = !!editGroup;
    const firstType = preset === 'out' ? 'out' : 'add';
    const customers = customerOptions();
    const families = familyOptions();
    const existing = editGroup || null;
    const ar = () => UI.getLang() === 'ar';
    const editCustomer = existing
      ? (existing.rows.map((r) => r.customer).find((c) => c && !isProductionCustomer(c)) || '')
      : '';

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit
        ? (ar() ? 'تعديل حركة' : 'Edit movement')
        : (ar() ? 'حركة جديدة' : 'New movement')}</h2></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'محرر الحركات المختلطة (إضافة وصرف في نفس الحركة) — للعمليات اليومية استخدم «حركة متابعة البكر».'
          : 'Legacy editor for mixed movements — for daily work use the blank-roll movement section.'}</p>
        <form id="tx-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="f-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field"><span>${t('quality')} *</span>
              <select id="f-quality" required>
                <option value="">— ${ar() ? 'اختر الصنف' : 'select product'} —</option>
                ${families.map((family) => `<option value="${esc(family)}" ${existing && productFamily(existing.quality) === family ? 'selected' : ''}>${esc(family)}</option>`).join('')}
              </select></label>
            <label class="field"><span>${t('gsm')} *</span>
              <input type="number" id="f-gsm" min="1" step="any" placeholder="135" value="${esc(existing && existing.gsm != null ? existing.gsm : '')}"></label>
            <label class="field"><span>${ar() ? 'العميل (لأسطر الصرف)' : 'Customer (for withdrawal rows)'}</span>
              <input type="text" id="f-customer" list="customer-list"
                placeholder="${ar() ? 'اختياري — بدون اسم يُسجَّل الصرف على الإنتاج' : 'optional — defaults to Production'}"
                value="${esc(editCustomer)}">
              <datalist id="customer-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
            <label class="field"><span>${t('permit')}</span>
              <input type="text" id="f-permit" value="${esc(existing ? existing.permitNo : '')}"></label>
            <label class="field"><span>${t('rollWeight')}</span>
              <input type="number" id="f-weight" min="0" step="0.001" value="${esc(existing && existing.rows[0].weight != null ? existing.rows[0].weight : '')}"></label>
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
            <div class="card-head-row"><strong>${ar() ? 'المقاسات والكميات' : 'Sizes and quantities'}</strong>
              <button type="button" class="btn btn-ghost" id="add-size-row">+ ${t('addSizeRow')}</button></div>
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

    const rowsHost = host.querySelector('#size-rows');
    const addSizeRow = (type = firstType, sizeValue = '', qtyValue = '') => {
      const row = document.createElement('div');
      row.className = 'size-entry-row';
      row.dataset.type = type;
      row.innerHTML =
        '<div class="row-type seg-control" role="group">' +
          `<button type="button" data-t="add" class="${type === 'add' ? 'active' : ''}">${ar() ? 'إضافة' : 'Add'}</button>` +
          `<button type="button" data-t="out" class="${type === 'out' ? 'active' : ''}">${ar() ? 'صرف' : 'Withdraw'}</button>` +
        '</div>' +
        '<label class="field"><span>' + t('size') + ' *</span><input class="line-size" type="number" min="1" step="any" placeholder="100"></label>' +
        '<label class="field"><span class="line-qty-label"></span><input class="line-qty" type="number" min="1" step="1" placeholder="0"></label>' +
        '<button type="button" class="btn btn-ghost remove-size-row" aria-label="remove">×</button>' +
        '<div class="line-balance small"></div>';
      row.querySelector('.line-size').value = sizeValue == null ? '' : sizeValue;
      row.querySelector('.line-qty').value = qtyValue == null ? '' : qtyValue;
      const setQtyLabel = () => {
        row.querySelector('.line-qty-label').textContent =
          (row.dataset.type === 'add' ? t('addQty') : t('outQty')) + ' *';
      };
      setQtyLabel();
      row.querySelectorAll('.row-type button').forEach((b) => b.addEventListener('click', () => {
        row.dataset.type = b.dataset.t;
        row.querySelectorAll('.row-type button').forEach((x) => x.classList.toggle('active', x === b));
        setQtyLabel();
        row.querySelector('.line-size').dispatchEvent(new Event('input'));
      }));
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
          let txt = (ar() ? 'الرصيد الحالي: ' : 'Current balance: ') + fmtNum(bal.net);
          if (row.dataset.type === 'out' && Number(row.querySelector('.line-qty').value) > bal.net) {
            txt += (ar() ? ' — الكمية أكبر من الرصيد' : ' — exceeds balance');
          }
          hint.textContent = txt;
        } else hint.textContent = '';
      };
      row.querySelector('.line-size').addEventListener('input', () => { updateLineHint(); updateHint(); });
      row.querySelector('.line-qty').addEventListener('input', () => { updateLineHint(); updateHint(); });
      return row;
    };
    host.querySelector('#add-size-row').addEventListener('click', () => { addSizeRow(firstType); updateHint(); });
    if (isEdit && existing) {
      existing.rows.forEach((r) => addSizeRow((Number(r.addQty) || 0) > 0 ? 'add' : 'out', r.size, r.addQty || r.outQty || 0));
    } else {
      addSizeRow(firstType);
    }
    const refreshLineHints = () => {
      rowsHost.querySelectorAll('.size-entry-row').forEach((row) => row.querySelector('.line-size').dispatchEvent(new Event('input')));
    };
    qSel.addEventListener('change', refreshLineHints);
    gsmIn.addEventListener('input', refreshLineHints);

    function updateHint() {
      const hint = host.querySelector('#balance-hint');
      if (!hint) return;
      const lines = readLines();
      if (!qSel.value || !Number(gsmIn.value) || !lines.length) { hint.innerHTML = ''; return; }
      const addSum = global.CALC.round6(lines.filter((l) => l.type === 'add').reduce((s, l) => s + l.qty, 0));
      const outSum = global.CALC.round6(lines.filter((l) => l.type === 'out').reduce((s, l) => s + l.qty, 0));
      const parts = [];
      if (addSum) parts.push((ar() ? 'إجمالي الإضافة: ' : 'Total additions: ') + `<strong>${fmtNum(addSum)}</strong>`);
      if (outSum) parts.push((ar() ? 'إجمالي الصرف: ' : 'Total withdrawals: ') + `<strong>${fmtNum(outSum)}</strong>`);
      hint.innerHTML = parts.join(' &nbsp;•&nbsp; ') || '';
    }

    host.querySelector('#f-cancel').addEventListener('click', () => navigate('history'));

    function readLines() {
      return [...host.querySelectorAll('.size-entry-row')].map((row) => ({
        type: row.dataset.type === 'out' ? 'out' : 'add',
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
      const headerCustomer = host.querySelector('#f-customer').value.trim();
      const lines = readLines();
      const header = {
        date: host.querySelector('#f-date').value,
        quality, gsm,
        customer: headerCustomer,
        permitNo: host.querySelector('#f-permit').value.trim(),
        weight: host.querySelector('#f-weight').value === '' ? null : Number(host.querySelector('#f-weight').value),
        settlement: host.querySelector('#f-settlement').value,
        notes: host.querySelector('#f-notes').value.trim(),
        source: isEdit ? (existing.source || 'manual') : 'manual',
      };

      if (!/^\d{4}-\d{2}-\d{2}$/.test(header.date) || !quality || !Number.isFinite(gsm) || gsm <= 0 || !lines.length) {
        errBox.textContent = ar()
          ? 'أكمل التاريخ والصنف والجرام، وأدخل مقاسًا صحيحًا لكل سطر.'
          : 'Complete date, product and GSM, then enter a valid size in every row.';
        return;
      }
      if (lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) {
        errBox.textContent = ar()
          ? 'أدخل كمية صحيحة أكبر من صفر لكل مقاس.'
          : 'Enter a quantity greater than zero for every size.';
        return;
      }
      const dupKey = (l) => l.type + '|' + String(l.size);
      const seenKeys = new Set();
      let duplicated = false;
      for (const l of lines) {
        if (seenKeys.has(dupKey(l))) { duplicated = true; break; }
        seenKeys.add(dupKey(l));
      }
      if (duplicated) {
        errBox.textContent = ar()
          ? 'يوجد مقاس مكرر بنفس النوع (إضافة/صرف). اجمع كميته في سطر واحد.'
          : 'A size is repeated with the same type. Combine its quantity into one row.';
        return;
      }

      const pending = lines.map((l) => Object.assign({}, header, {
        size: l.size,
        addQty: l.type === 'add' ? l.qty : 0,
        outQty: l.type === 'out' ? l.qty : 0,
        customer: l.type === 'add' ? 'الإنتاج' : (headerCustomer || 'الإنتاج'),
      }));
      const negative = pending.filter((line) => line.outQty > 0 &&
        balanceOf(quality, gsm, line.size).net - line.outQty < 0);
      if (negative.length) {
        const ok = await confirmDialog({
          title: t('confirm'),
          message: ar()
            ? `تنبيه: الصرف أكبر من الرصيد في ${negative.length} مقاس (${negative.map((n) => n.size).join('، ')}). هل تريد المتابعة؟`
            : `Warning: withdrawal exceeds stock for ${negative.length} size(s) (${negative.map((n) => n.size).join(', ')}). Continue?`,
          danger: true, yesLabel: ar() ? 'متابعة بالسالب' : 'Proceed',
        });
        if (!ok) return;
      }

      try {
        if (isEdit) {
          await global.TX.replaceMovement(existing, pending);
          toast(ar() ? 'تم تحديث الحركة وتحديث الرصيد تلقائيًا' : 'movement updated, balances recalculated', 'ok');
        } else {
          const groupId = nextGroupId();
          for (const line of pending) await global.TX.addTransaction(Object.assign({ groupId }, line));
          toast(ar()
            ? `تم تسجيل ${pending.length} مقاس وتحديث الأرصدة`
            : `${pending.length} size(s) saved and balances updated`, 'ok');
        }
        await refresh();
        const hasAdd = pending.some((l) => l.addQty > 0);
        const hasOut = pending.some((l) => l.outQty > 0);
        navigate(hasAdd && hasOut ? 'history' : (hasOut ? 'issuedocs' : 'baker'));
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

  /* =======================================================================
     SECTION: حركة متابعة البكر
     ======================================================================= */

  /* ---------- A. إضافة إنتاج ---------- */
  function bakerAddForm(host, editGroup) {
    const isEdit = !!editGroup;
    const existing = editGroup || null;
    const ar = () => UI.getLang() === 'ar';
    const families = familyOptions();
    const weights = knownWeights();

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit
        ? (ar() ? 'تعديل إضافة إنتاج' : 'Edit production entry')
        : `${t('bakerAdd')} — ${t('baker')}`}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="ba-back">← ${t('baker')}</button></div></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'الإنتاج يُسجَّل باسم «الإنتاج»: اختر الصنف والجرام ووزن الرولة مرة واحدة لكل المجموعة، ثم أضف أسطر المقاسات تحت نفس الرأس. لا يوجد هنا تصنيف ضريبي أو رقم إذن — تلك لعاملي الصرف فقط.'
          : 'Production is booked to «Production»: pick product, GSM and roll weight once for the whole group, then add size rows under the same header. Tax classification and document numbers belong to the issue form only.'}</p>
        <form id="ba-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="ba-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field"><span>${t('quality')} *</span>
              <select id="ba-quality" required>
                <option value="">— ${ar() ? 'اختر الصنف' : 'select product'} —</option>
                ${families.map((family) => `<option value="${esc(family)}" ${existing && productFamily(existing.quality) === family ? 'selected' : ''}>${esc(family)}</option>`).join('')}
              </select></label>
            <label class="field"><span>${t('gsm')} *</span>
              <input type="number" id="ba-gsm" min="1" step="any" list="ba-gsm-list" placeholder="125" value="${esc(existing && existing.gsm != null ? existing.gsm : '')}">
              <datalist id="ba-gsm-list">${knownGsms(null).map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist></label>
            <label class="field"><span>${t('rollWeight')} *</span>
              <input type="number" id="ba-weight" min="0.001" step="0.001" list="ba-w-list" placeholder="500"
                value="${esc(existing && existing.rows[0].weight != null ? existing.rows[0].weight : '')}">
              <datalist id="ba-w-list">${weights.map((w) => `<option value="${esc(w)}"></option>`).join('')}</datalist></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="ba-notes" value="${esc(existing ? existing.notes : '')}"></label>
          </div>
          <section class="field field-wide" id="ba-sizes-section">
            <div class="sz-head" aria-hidden="true">
              <span>${t('size')} (${ar() ? 'سم' : 'cm'})</span>
              <span>${ar() ? 'عدد الرولات' : 'Roll quantity'}</span>
              <span></span>
            </div>
            <div id="ba-size-rows"></div>
            <button type="button" class="btn btn-ghost" id="ba-add-row">+ ${t('addSizeRow')}</button>
          </section>
          <div class="form-hint" id="ba-hint"></div>
          <div class="form-error" id="ba-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${t('save')}</button>
            <button type="button" class="btn btn-ghost" id="ba-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    const form = host.querySelector('#ba-form');
    const qSel = host.querySelector('#ba-quality');
    const gsmIn = host.querySelector('#ba-gsm');
    const weightIn = host.querySelector('#ba-weight');
    const rowsHost = host.querySelector('#ba-size-rows');
    host.querySelector('#ba-back').addEventListener('click', () => navigate('baker'));

    const addSizeRow = (sizeValue = '', qtyValue = '') => {
      const row = document.createElement('div');
      row.className = 'sz-row';
      row.innerHTML =
        '<input class="line-size" type="number" min="1" step="any" placeholder="100" aria-label="size">' +
        '<input class="line-qty" type="number" min="1" step="1" placeholder="0" aria-label="quantity">' +
        '<button type="button" class="btn btn-ghost remove-size-row" aria-label="remove">×</button>' +
        '<div class="line-balance small"></div>';
      row.querySelector('.line-size').value = sizeValue == null ? '' : sizeValue;
      row.querySelector('.line-qty').value = qtyValue == null ? '' : qtyValue;
      rowsHost.appendChild(row);
      row.querySelector('.remove-size-row').addEventListener('click', () => {
        if (rowsHost.querySelectorAll('.sz-row').length === 1) {
          row.querySelector('.line-size').value = '';
          row.querySelector('.line-qty').value = '';
        } else row.remove();
        updateHint();
      });
      row.querySelector('.line-size').addEventListener('input', () => { updateLineHint(); updateHint(); });
      row.querySelector('.line-qty').addEventListener('input', () => { updateHint(); });
      return row;
    };

    const updateLineHint = () => {
      for (const row of rowsHost.querySelectorAll('.sz-row')) {
        const size = Number(row.querySelector('.line-size').value);
        const q = qSel.value, gsm = Number(gsmIn.value), w = weightIn.value === '' ? null : Number(weightIn.value);
        const hint = row.querySelector('.line-balance');
        if (q && gsm > 0 && size > 0) {
          const bal = balanceBy(q, gsm, w, size);
          hint.textContent = (ar() ? 'الرصيد الحالي لهذا الوزن: ' : 'Balance in this weight bucket: ') + fmtNum(bal.net);
        } else hint.textContent = '';
      }
    };

    host.querySelector('#ba-add-row').addEventListener('click', () => { addSizeRow(); updateHint(); });
    if (isEdit && existing) {
      existing.rows.forEach((r) => addSizeRow(r.size, r.addQty || 0));
    } else {
      addSizeRow();
    }
    const refreshHints = () => rowsHost.querySelectorAll('.sz-row .line-size').forEach((i) => i.dispatchEvent(new Event('input')));
    qSel.addEventListener('change', refreshHints);
    gsmIn.addEventListener('input', refreshHints);
    weightIn.addEventListener('input', refreshHints);

    function updateHint() {
      const hint = host.querySelector('#ba-hint');
      if (!hint) return;
      const lines = readLines();
      if (!lines.length) { hint.innerHTML = ''; return; }
      const total = global.CALC.round6(lines.reduce((s, l) => s + l.qty, 0));
      hint.innerHTML = (ar() ? 'إجمالي الرولات المضافة: ' : 'Total rolls added: ') + `<strong>${fmtNum(total)}</strong>`;
    }

    host.querySelector('#ba-cancel').addEventListener('click', () => navigate('baker'));

    function readLines() {
      return [...host.querySelectorAll('.sz-row')].map((row) => ({
        size: Number(row.querySelector('.line-size').value),
        qty: Number(row.querySelector('.line-qty').value),
      })).filter((l) => Number.isFinite(l.size) && l.size > 0);
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#ba-error');
      errBox.textContent = '';
      const quality = qSel.value.trim();
      const gsm = gsmIn.value ? Number(gsmIn.value) : null;
      const weight = weightIn.value === '' ? null : Number(weightIn.value);
      const header = {
        date: host.querySelector('#ba-date').value,
        quality, gsm, weight,
        notes: host.querySelector('#ba-notes').value.trim(),
        source: isEdit ? (existing.source || 'manual') : 'manual',
      };
      const lines = readLines();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(header.date) || !quality || !Number.isFinite(gsm) || gsm <= 0 ||
          !Number.isFinite(weight) || weight <= 0) {
        errBox.textContent = ar()
          ? 'أكمل التاريخ والصنف والجرام ووزن الرولة (أكبر من صفر).'
          : 'Complete date, product, GSM and roll weight (greater than zero).';
        return;
      }
      if (!lines.length || lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) {
        errBox.textContent = ar()
          ? 'أدخل مقاسًا صحيحًا وكمية أكبر من صفر لكل سطر.'
          : 'Enter a valid size and a quantity greater than zero in every row.';
        return;
      }
      const seen = new Set();
      for (const l of lines) {
        if (seen.has(String(l.size))) {
          errBox.textContent = ar()
            ? `المقاس ${l.size} مكرر — اجمع كميته في سطر واحد.`
            : `Size ${l.size} is repeated — combine its quantity into one row.`;
          return;
        }
        seen.add(String(l.size));
      }

      try {
        if (isEdit) {
          const pending = lines.map((l) => ({
            date: header.date, quality, gsm, size: l.size,
            customer: 'الإنتاج', permitNo: '', addQty: l.qty, outQty: 0,
            weight, settlement: '', notes: header.notes, source: header.source,
          }));
          await global.TX.replaceMovement(existing, pending);
          toast(ar() ? 'تم تحديث الحركة وتحديث الرصيد تلقائيًا' : 'movement updated, balances recalculated', 'ok');
        } else {
          await global.TX.saveProduction(header, lines);
          toast(ar() ? `تم تسجيل ${fmtNum(lines.reduce((s, l) => s + l.qty, 0))} لفة إنتاج وتحديث الرصيد`
            : 'production saved and balances updated', 'ok');
        }
        await refresh();
        navigate('baker');
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

  /* ---------- B. صرف للعملاء (إذن بمجموعات + ترقيم مستقل) ---------- */
  function bakerIssueForm(host, editGroup) {
    const isEdit = !!editGroup;
    const existing = editGroup || null;
    const ar = () => UI.getLang() === 'ar';
    const families = familyOptions();
    const customers = customerOptions();
    const weights = knownWeights();
    let docNoDirty = false;

    /* editing: rebuild groups from the stored rows (product/gsm/weight) */
    let initialGroups;
    let initialCls = 'ض';
    if (existing) {
      initialCls = existing.settlement === 'غ' ? 'غ' : 'ض';
      const sub = new Map();
      for (const r of existing.rows) {
        const key = global.CALC.comboGroupWOf(r); /* group = (product, gsm, weight), sizes inside */
        if (!sub.has(key)) sub.set(key, { quality: familyOf(r.quality), gsm: r.gsm, weight: r.weight, sizes: [] });
        sub.get(key).sizes.push({ size: r.size, qty: Number(r.outQty) || 0 });
      }
      initialGroups = [...sub.values()];
      initialGroups.forEach((g) => g.sizes.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0)));
    } else {
      initialGroups = null;
    }

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit
        ? (ar() ? `تعديل إذن صرف ${existing ? existing.permitNo || '' : ''}` : 'Edit issue document')
        : `${t('bakerIssue')} — ${t('baker')}`}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="bi-back">← ${t('issuedocs')}</button></div></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'أذون الصرف لها تسلسلان مستقلان: «ضريبي» و«غير ضريبي» — يُقترح الرقم التالي تلقائيًا ويمكن تعديله، ويُمنع تكرار الرقم داخل نفس التصنيف. كل مجموعة تحمل جرامها ووزن رولتها ومقاساتها.'
          : 'Issue documents have two independent sequences: tax and non-tax. The next number is suggested automatically and stays editable; duplicates within one classification are rejected. Each group carries its own GSM, roll weight and sizes.'}</p>
        <form id="bi-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="bi-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field"><span>${t('customer')} *</span>
              <input type="text" id="bi-customer" list="bi-cust-list" required placeholder="${ar() ? 'اسم العميل' : 'customer name'}"
                value="${esc(existing ? (App.canonicalCustomer(existing.customer) || '') : '')}">
              <datalist id="bi-cust-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
            <div class="field"><span>${t('classification')} *</span>
              <div class="seg-control" id="bi-cls">
                <button type="button" data-cls="ض" class="${initialCls === 'ض' ? 'active' : ''}">${t('tax')}</button>
                <button type="button" data-cls="غ" class="${initialCls === 'غ' ? 'active' : ''}">${t('nontax')}</button>
              </div></div>
            <label class="field"><span>${t('docNo')} *</span>
              <input type="text" id="bi-docno" required autocomplete="off">
              <span class="muted small" id="bi-docno-hint">${ar() ? 'يُقترح تلقائيًا — يمكن تعديله' : 'suggested automatically — editable'}</span></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="bi-notes" value="${esc(existing ? existing.notes : '')}"></label>
          </div>
          <section class="field field-wide" id="bi-groups-section">
            <div class="card-head-row"><strong>${ar() ? 'مجموعات الصرف (كل مجموعة بجرام ووزن مختلف)' : 'Issue groups (each with its own GSM & weight)'}</strong>
              <button type="button" class="btn btn-ghost" id="bi-add-group">+ ${t('addGroup')}</button></div>
            <div id="bi-groups"></div>
          </section>
          <div class="form-hint" id="bi-hint"></div>
          <div class="form-error" id="bi-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${t('save')}</button>
            <button type="button" class="btn btn-ghost" id="bi-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    const form = host.querySelector('#bi-form');
    const groupsHost = host.querySelector('#bi-groups');
    const docNoIn = host.querySelector('#bi-docno');
    let classification = initialCls;
    host.querySelector('#bi-back').addEventListener('click', () => navigate('issuedocs'));

    const suggestDocNo = async () => {
      const n = await global.TX.nextDocNumbers();
      docNoIn.value = String(classification === 'ض' ? n.tax : n.nontax);
      docNoDirty = false;
    };
    host.querySelectorAll('#bi-cls button').forEach((b) => b.addEventListener('click', () => {
      classification = b.dataset.cls;
      host.querySelectorAll('#bi-cls button').forEach((x) => x.classList.toggle('active', x === b));
      suggestDocNo(); /* selection always displays the next number of that sequence */
    }));
    docNoIn.addEventListener('input', () => { docNoDirty = true; });
    if (isEdit) docNoIn.value = existing.permitNo || '';
    else suggestDocNo();

    /* ---------- groups ---------- */
    const groupDefs = initialGroups || [];
    const makeGroupEl = (def) => {
      const def0 = def || { quality: families[0] || '', gsm: '', weight: '', sizes: [] };
      const g = el(`<div class="issue-group">
        <div class="issue-group-head">
          <strong class="g-index"></strong>
          <button type="button" class="btn btn-ghost g-remove">✕ ${ar() ? 'حذف المجموعة' : 'Remove group'}</button>
        </div>
        <div class="form-grid">
          <label class="field"><span>${t('quality')} *</span>
            <select class="g-quality">${families.map((f) => `<option value="${esc(f)}" ${def0.quality === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
          <label class="field"><span>${t('gsm')} *</span>
            <input class="g-gsm" type="number" min="1" step="any" list="bi-gsm-list" placeholder="125" value="${esc(def0.gsm == null ? '' : def0.gsm)}"></label>
          <label class="field"><span>${t('rollWeight')} *</span>
            <input class="g-weight" type="number" min="0.001" step="0.001" list="bi-w-list" placeholder="500" value="${esc(def0.weight == null ? '' : def0.weight)}"></label>
        </div>
        <div class="sz-head" aria-hidden="true">
          <span>${t('size')} (${ar() ? 'سم' : 'cm'})</span>
          <span>${ar() ? 'عدد الرولات' : 'Roll quantity'}</span>
          <span></span>
        </div>
        <div class="g-sizes"></div>
        <div class="issue-group-foot">
          <button type="button" class="btn btn-ghost g-add-size">+ ${t('addSizeRow')}</button>
          <span class="g-total muted small"></span>
        </div>
      </div>`);
      const sizesHost = g.querySelector('.g-sizes');
      const addSize = (sizeValue = '', qtyValue = '') => {
        const row = document.createElement('div');
        row.className = 'sz-row';
        row.innerHTML =
          '<input class="line-size" type="number" min="1" step="any" placeholder="100" aria-label="size">' +
          '<input class="line-qty" type="number" min="1" step="1" placeholder="0" aria-label="quantity">' +
          '<button type="button" class="btn btn-ghost remove-size-row" aria-label="remove">×</button>' +
          '<div class="line-balance small"></div>';
        row.querySelector('.line-size').value = sizeValue == null ? '' : sizeValue;
        row.querySelector('.line-qty').value = qtyValue == null ? '' : qtyValue;
        sizesHost.appendChild(row);
        row.querySelector('.remove-size-row').addEventListener('click', () => {
          if (sizesHost.querySelectorAll('.sz-row').length === 1) {
            row.querySelector('.line-size').value = '';
            row.querySelector('.line-qty').value = '';
          } else row.remove();
          refreshAll();
        });
        row.querySelector('.line-size').addEventListener('input', refreshAll);
        row.querySelector('.line-qty').addEventListener('input', refreshAll);
        return row;
      };
      g.querySelector('.g-add-size').addEventListener('click', () => { addSize(); refreshAll(); });
      g.querySelector('.g-remove').addEventListener('click', () => {
        if (groupsHost.querySelectorAll('.issue-group').length === 1) {
          g.querySelectorAll('.line-size, .line-qty').forEach((i) => { i.value = ''; });
        } else g.remove();
        renumber();
        refreshAll();
      });
      g._addSize = addSize;
      (def0.sizes && def0.sizes.length ? def0.sizes : [{}]).forEach((s) => addSize(s.size == null ? '' : s.size, s.qty == null ? '' : s.qty));
      return g;
    };

    const datalistWrap = el(`<div><datalist id="bi-gsm-list">${knownGsms(null).map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
      <datalist id="bi-w-list">${weights.map((w) => `<option value="${esc(w)}"></option>`).join('')}</datalist></div>`);
    host.appendChild(datalistWrap);

    const renumber = () => {
      groupsHost.querySelectorAll('.issue-group .g-index').forEach((elm, i) => {
        elm.textContent = `${ar() ? 'مجموعة' : 'Group'} ${fmtNum(i + 1)}`;
      });
    };
    const addGroup = (def) => {
      const g = makeGroupEl(def);
      groupsHost.appendChild(g);
      renumber();
      return g;
    };
    host.querySelector('#bi-add-group').addEventListener('click', () => {
      const first = groupsHost.querySelector('.issue-group');
      const inherit = first ? {
        quality: first.querySelector('.g-quality').value, gsm: '', weight: '', sizes: [],
      } : null;
      addGroup(inherit);
      refreshAll();
    });

    if (groupDefs.length) groupDefs.forEach((g) => addGroup(g));
    else addGroup(null);

    /* ---------- live totals + per-row balance hints ---------- */
    function refreshAll() {
      let grand = 0;
      groupsHost.querySelectorAll('.issue-group').forEach((g) => {
        const q = g.querySelector('.g-quality').value;
        const gsm = g.querySelector('.g-gsm').value === '' ? null : Number(g.querySelector('.g-gsm').value);
        const w = g.querySelector('.g-weight').value === '' ? null : Number(g.querySelector('.g-weight').value);
        let gtotal = 0;
        g.querySelectorAll('.sz-row').forEach((row) => {
          const size = Number(row.querySelector('.line-size').value);
          const qty = Number(row.querySelector('.line-qty').value) || 0;
          const hint = row.querySelector('.line-balance');
          if (q && gsm && size > 0) {
            const bal = balanceBy(q, gsm, w, size);
            let txt = (ar() ? 'المتاح: ' : 'Available: ') + fmtNum(bal.net);
            if (qty > bal.net) txt += (ar() ? ' — أكبر من المتاح' : ' — exceeds available');
            hint.textContent = txt;
          } else hint.textContent = '';
          if (size > 0) gtotal += qty;
        });
        g.querySelector('.g-total').innerHTML = `${ar() ? 'إجمالي المجموعة' : 'Group total'}: <strong>${fmtNum(global.CALC.round6(gtotal))}</strong> ${t('rolls')}`;
        grand += gtotal;
      });
      const hint = host.querySelector('#bi-hint');
      if (hint) hint.innerHTML = `${t('totalRolls')}: <strong>${fmtNum(global.CALC.round6(grand))}</strong> ${t('rolls')}`;
    }
    groupsHost.addEventListener('input', refreshAll);
    refreshAll();

    host.querySelector('#bi-cancel').addEventListener('click', () => navigate('issuedocs'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#bi-error');
      errBox.textContent = '';
      const date = host.querySelector('#bi-date').value;
      const customer = host.querySelector('#bi-customer').value.trim();
      const notes = host.querySelector('#bi-notes').value.trim();
      const docNo = docNoIn.value.trim();

      const groups = [];
      let invalid = false;
      groupsHost.querySelectorAll('.issue-group').forEach((g) => {
        const quality = g.querySelector('.g-quality').value;
        const gsm = g.querySelector('.g-gsm').value === '' ? null : Number(g.querySelector('.g-gsm').value);
        const weight = g.querySelector('.g-weight').value === '' ? null : Number(g.querySelector('.g-weight').value);
        const sizes = [];
        g.querySelectorAll('.sz-row').forEach((row) => {
          const size = Number(row.querySelector('.line-size').value);
          const qty = Number(row.querySelector('.line-qty').value);
          if (Number.isFinite(size) && size > 0) sizes.push({ size, qty });
        });
        if (!quality || !Number.isFinite(gsm) || gsm <= 0 || !Number.isFinite(weight) || weight <= 0 ||
            !sizes.length || sizes.some((s) => !Number.isFinite(s.qty) || s.qty <= 0)) invalid = true;
        groups.push({ quality, gsm, weight, sizes });
      });

      const problems = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(ar() ? 'التاريخ مطلوب بصيغة صحيحة' : 'Valid date required');
      if (!customer) problems.push(ar() ? 'اسم العميل مطلوب' : 'Customer name required');
      if (!docNo) problems.push(ar() ? 'رقم الإذن مطلوب' : 'Document number required');
      if (!groups.length || invalid) problems.push(ar()
        ? 'أكمل بيانات كل مجموعة: الصنف والجرام ووزن الرولة ومقاس صحيح بكمية أكبر من صفر'
        : 'Complete every group: product, GSM, roll weight and a valid size with a quantity greater than zero');
      /* same (gsm,weight,size) bucket inside two groups = one bucket → combine */
      const seenBucket = new Set();
      for (const g of groups) {
        for (const s of g.sizes) {
          const k = global.CALC.comboKeyW(g.quality, g.gsm, g.weight, s.size);
          if (seenBucket.has(k)) problems.push(ar()
            ? `المقاس ${s.size} (نفس الجرام والوزن) مكرر بين المجموعات — اجمع كميته في مجموعة واحدة`
            : `Size ${s.size} with the same GSM/weight repeats across groups — combine it into one group`);
          seenBucket.add(k);
        }
      }
      if (problems.length) {
        errBox.innerHTML = problems.map((p) => `• ${esc(p)}`).join('<br>');
        return;
      }

      const doc = {
        date, customer, docNo,
        classification,
        notes,
        source: isEdit ? (existing.source || 'manual') : 'manual',
        groups,
      };
      try {
        if (isEdit) {
          const pendingRows = [];
          for (const g of groups) {
            for (const s of g.sizes) {
              pendingRows.push({
                date, quality: g.quality, gsm: g.gsm, size: s.size,
                customer, permitNo: docNo, addQty: 0, outQty: s.qty,
                weight: g.weight, settlement: classification,
                notes, source: doc.source,
              });
            }
          }
          await global.TX.replaceIssueDocument(existing, pendingRows, classification, docNo);
          toast(ar() ? 'تم تحديث الإذن وتحديث الرصيد تلقائيًا' : 'document updated, balances recalculated', 'ok');
        } else {
          await global.TX.saveIssueDocument(doc);
          toast(ar() ? `تم حفظ إذن الصرف ${docNo} (${classification === 'ض' ? t('tax') : t('nontax')}) وتحديث الرصيد`
            : `Document ${docNo} saved and balances updated`, 'ok');
        }
        await refresh();
        navigate('issuedocs');
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

  /* ---------- حركة متابعة البكر — hub: بطاقتا العملية + قائمة الإضافات ---------- */
  function bakerHub(host) {
    const ar = () => UI.getLang() === 'ar';
    host.innerHTML = `
      <div class="page-head"><h2>${t('baker')}</h2></div>
      <div class="op-grid">
        <button class="op-card op-add" id="op-add">
          <span class="op-ic">➕</span>
          <span class="op-title">${t('bakerAdd')}</span>
          <span class="op-desc">${ar() ? 'تسجيل الإنتاج الجديد: صنف وجرام ووزن رولة واحد مع مقاسات متعددة — يزيد الرصيد مباشرة.' : 'Record new production: one product/GSM/weight with multiple size rows — increases stock immediately.'}</span>
        </button>
        <button class="op-card op-issue" id="op-issue">
          <span class="op-ic">🧾</span>
          <span class="op-title">${t('bakerIssue')}</span>
          <span class="op-desc">${t('issueNote')}</span>
        </button>
      </div>
      <div id="baker-table"></div>`;
    host.querySelector('#op-add').addEventListener('click', () => { App.pendingEdit = null; navigate('baker-add'); });
    host.querySelector('#op-issue').addEventListener('click', () => { App.pendingEdit = null; navigate('baker-issue'); });
    txTable(host.querySelector('#baker-table'), {
      title: ar() ? 'حركات الإضافة المسجلة' : 'Recorded production entries',
      filter: (r) => (Number(r.addQty) || 0) > 0, preset: 'add', hideAdd: true,
    });
  }

  /* =======================================================================
     shared table renderer for movement lists
     ======================================================================= */
  function txTable(host, opts) {
    const lang = UI.getLang() === 'ar';
    let rows = App.state.transactions.slice();
    rows = rows.filter(opts.filter || (() => true));
    const customers = customerOptions();
    const families = CANON_FAMILIES.filter((f) => App.state.products.some((p) => productFamily(p.quality) === f));
    const showFilters = opts.preset === 'out' || opts.preset === null;
    host.innerHTML = `
      <div class="page-head"><h2>${esc(opts.title)}</h2>
        <div class="head-actions">
          ${opts.hideAdd ? '' : `<button class="btn btn-primary" id="btn-add-tx">+ ${esc(opts.addLabel || (lang ? 'حركة جديدة' : 'New movement'))}</button>`}
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
            <th>${t('rollWeight')}</th>
            <th>${lang ? 'المقاسات والكميات' : 'Sizes & quantities'}</th>
            <th>${t('customer')}</th><th>${t('permit')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th>${t('settlement')}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map(groupRowHtml).join('') :
            `<tr><td colspan="11" class="empty">${esc(t('emptyState'))}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="7">${t('total')} (${fmtNum(total)} ${lang ? 'حركة' : 'movements'} — ${fmtNum(nRows)} ${lang ? 'سطر' : 'rows'})</td>
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
          /* the list view may show only one side of a mixed movement —
             edit & delete must always operate on the FULL group */
          const full = group.groupId
            ? App.buildGroups(App.state.transactions.filter((r) => r.groupId === group.groupId))[0]
            : group;
          if (act === 'edit') {
            if (!full.groupId) { App.openLegacyEditModal(full.rows[0]); return; }
            const hasAdd = full.add > 0, hasOut = full.out > 0;
            if (hasAdd && hasOut) { App.pendingEdit = { type: 'mixed', group: full }; navigate('addtx'); }
            else if (hasOut) { App.pendingEdit = { type: 'issue', group: full }; navigate('baker-issue'); }
            else { App.pendingEdit = { type: 'production', group: full }; navigate('baker-add'); }
          } else if (act === 'del') {
            const ok = await confirmDialog({
              title: lang ? 'حذف حركة' : 'Delete movement',
              message: lang
                ? (full.rows.length > 1
                  ? `سيتم حذف الحركة بكل مقاساتها (${full.rows.length} سطر) نهائيًا وتحديث الرصيد تلقائيًا.\nالصنف: ${full.quality} — الجرام: ${full.gsm}\nالمقاسات: ${full.sizesLabel}`
                  : `سيتم حذف الحركة نهائيًا وتحديث الرصيد تلقائيًا.\nالصنف: ${full.quality} — الجرام: ${full.gsm} — المقاس: ${full.rows[0].size} — الكمية: ${full.add || full.out}`)
                : `Delete this movement permanently and recalculate balances?\n${full.quality} / ${full.gsm} — ${full.sizesLabel}`,
              danger: true, extra: lang ? `<code>${esc(full.date)} — ${esc(canonicalCustomer(full.customer) || '')}</code>` : '',
            });
            if (ok) {
              await global.TX.deleteMovement(full);
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

    function groupWeightLabel(g) {
      const ws = [...new Set(g.rows.map((r) => (r.weight == null || r.weight === '') ? null : Number(r.weight)))];
      if (ws.length === 1 && ws[0] != null) return fmtNum(ws[0]);
      return '—';
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
        <td data-label="${t('rollWeight')}">${groupWeightLabel(g)}</td>
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
    const addBtn = host.querySelector('#btn-add-tx');
    if (addBtn) addBtn.addEventListener('click', () => {
      App.pendingEdit = null;
      const target = opts.addTarget || (opts.preset === 'out' ? 'baker-issue' : 'baker-add');
      navigate(target);
    });
    host.querySelector('#btn-exp-tx').addEventListener('click', () => {
      global.EXCEL.exportTransactions(rows);
      toast(lang ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });
    applyFilters();
  }
  App.txTable = txTable;

  /* legacy single-row editor (rows imported from Excel without a groupId);
     shared by txTable and أذون الصرف */
  function openLegacyEditModal(txRow) {
    const lang = UI.getLang() === 'ar';
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
        <label class="field"><span>${t('rollWeight')}</span><input id="e-weight" type="number" step="0.001" value="${esc(txRow.weight == null ? '' : txRow.weight)}"></label>
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
  App.openLegacyEditModal = openLegacyEditModal;

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
    const nProduction = buildGroups(tx.filter((r) => (Number(r.addQty) || 0) > 0)).length;
    const nDocs = buildGroups(tx.filter((r) => (Number(r.outQty) || 0) > 0)).length;
    const I = global.UI.ICON;
    const cards = [
      { icon: I.balance, num: fmtNum(stockTotal), label: `${t('totalBalance')} (${t('rolls')})`, accent: 'green' },
      { icon: I.products, num: fmtNum(products.length), label: t('totalProducts'), accent: 'teal' },
      { icon: I.countAdd, num: fmtNum(nProduction), label: t('countAdd'), accent: 'teal' },
      { icon: I.countOut, num: fmtNum(nDocs), label: t('countOut'), accent: 'amber' },
      { icon: I.add, num: fmtNum(g.add), label: lang ? 'إجمالي الإضافات للإنتاج' : 'Total production additions', accent: 'green' },
      { icon: I.out, num: fmtNum(g.out), label: lang ? 'إجمالي الصرف للعملاء' : 'Total customer withdrawals', accent: 'amber' },
    ];

    /* inventory by product (2 canonical families + totals) */
    const famRows = CANON_FAMILIES.map((family) => {
      let net = 0, buckets = 0;
      for (const p of products) {
        if (productFamily(p.quality) !== family) continue;
        const b = App.state.balances.get(p.combo);
        net += b ? b.net : 0;
        buckets++;
      }
      return { family, net: global.CALC.round6(net), buckets };
    }).filter((r) => r.buckets > 0);

    /* low-stock / negative buckets (roll-weight dimension) */
    const low = [];
    for (const row of App.state.balancesW.values()) {
      if (row.net <= 0 && (row.add > 0 || row.out > 0)) low.push(row);
    }
    low.sort((a, b) => a.net - b.net);

    host.innerHTML = `
      <div class="page-head"><h2>${lang ? 'لوحة التحكم' : 'Dashboard'}</h2>
        <div class="head-actions">
          ${tx.length === 0 ? `<button class="btn btn-primary" id="btn-import-dash">${t('importExcel')}</button>` : ''}
          <button class="btn btn-primary" id="btn-new-dash">+ ${t('bakerAdd')}</button>
        </div></div>
      <div class="stats-grid">
        ${cards.map((c) => `<div class="stat-card accent-${c.accent}">
          <div class="stat-icon">${c.icon}</div>
          <div class="stat-num">${c.num}</div>
          <div class="stat-label">${esc(c.label)}</div>
        </div>`).join('')}
      </div>
      <div class="card weight-line">${lang ? 'إجمالي وزن الرصيد التقديري' : 'Estimated stock weight'}: <strong>${fmtNum(weightTotal, 2)}</strong> ${t('kg')} <span class="muted">(${lang ? 'المقاس × الرصيد ×' : 'size × balance ×'} ${App.state.settings.weightFactor})</span></div>
      ${low.length ? `<div class="card notice-card low-stock-card">
        <strong>${t('lowStock')}: ${fmtNum(low.length)}</strong>
        <div class="small muted">${low.slice(0, 5).map((r) =>
          `${esc(productFamily(r.quality))} ${r.gsm == null ? '—' : fmtNum(r.gsm)}g / وزن ${r.weight == null ? '—' : fmtNum(r.weight)} / ${r.size == null ? '—' : fmtNum(r.size)} → ${fmtNum(r.net)}`).join(' · ')}${low.length > 5 ? ' …' : ''}</div>
      </div>` : ''}
      <div class="dash-grid">
        <div class="card chart-card"><h3>${t('monthlyMovement')}</h3><div class="chart-box"><canvas id="chart-monthly"></canvas></div></div>
        <div class="card chart-card"><h3>${t('topProducts')}</h3><div class="chart-box"><canvas id="chart-top"></canvas></div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head-row"><h3>${t('byProduct')}</h3>
            <button class="link-btn" data-nav="inventory">${t('viewAll')}</button></div>
          <table class="data-table">
            <thead><tr><th>${t('quality')}</th><th class="num">${lang ? 'عدد الأصناف' : 'Items'}</th><th class="num">${t('balance')} (${t('rolls')})</th></tr></thead>
            <tbody>${famRows.length ? famRows.map((r) => `<tr><td>${esc(r.family)}</td><td class="num">${fmtNum(r.buckets)}</td><td class="num"><strong>${fmtNum(r.net)}</strong></td></tr>`).join('')
              : `<tr><td colspan="3" class="empty">${esc(t('emptyState'))}</td></tr>`}</tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-head-row"><h3>${t('recentTx')}</h3>
            <button class="link-btn" data-nav="history">${t('viewAll')}</button></div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>${t('date')}</th><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th><th>${t('customer')}</th><th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th></tr></thead>
            <tbody>${recentRows(tx)}</tbody>
          </table></div>
        </div>
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
      navigate('baker-add');
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
    for (const row of App.state.balancesW.values()) {
      if (row.net > 0) arr.push({
        label: `${productFamily(row.quality)} ${row.gsm}g — ${row.weight != null ? row.weight + 'kg — ' : ''}${row.size}`,
        net: row.net,
      });
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
  App.registerView('baker', bakerHub);
  App.registerView('baker-add', (host) => {
    const pending = App.pendingEdit; App.pendingEdit = null;
    const edit = pending && pending.group ? pending.group : (pending || null);
    bakerAddForm(host, edit);
  });
  App.registerView('baker-issue', (host) => {
    const pending = App.pendingEdit; App.pendingEdit = null;
    const edit = pending && pending.group ? pending.group : (pending || null);
    bakerIssueForm(host, edit);
  });
  App.registerView('addtx', (host) => {
    const pending = App.pendingEdit; App.pendingEdit = null;
    const preset = pending ? null : (App.pendingPreset == null ? 'add' : App.pendingPreset);
    App.pendingPreset = null;
    const edit = pending && pending.group ? pending.group : (pending || null);
    txForm(host, edit, preset);
  });
  App.registerView('history', (host) => txTable(host, {
    title: global.UI.getLang() === 'ar' ? 'سجل الحركات' : 'Transaction history',
    filter: () => true, preset: null,
    addLabel: global.UI.getLang() === 'ar' ? 'حركة متابعة البكر' : 'Blank-roll movement',
    addTarget: 'baker',
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
