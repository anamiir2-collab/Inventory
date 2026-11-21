/* =========================================================================
   reports.js — التقارير والطباعة
   7 report types · A4 pagination with real page numbers · repeated table
   headers on every page · signature spaces · window.print() · Excel export
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, toast } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';

  const REPORTS = [
    { id: 'balance', icon: '📊', name: 'تقرير الرصيد الحالي', en: 'Current balance report' },
    { id: 'additions', icon: '➕', name: 'تقرير حركة الإضافات', en: 'Additions report' },
    { id: 'withdrawals', icon: '➖', name: 'تقرير حركة الصرف', en: 'Withdrawals report' },
    { id: 'product', icon: '📦', name: 'تقرير حركة صنف معين', en: 'Product movement report' },
    { id: 'customer', icon: '👤', name: 'تقرير حركة عميل معين', en: 'Customer movement report' },
    { id: 'period', icon: '🗓', name: 'تقرير حركة المخزن خلال فترة محددة', en: 'Period movement report' },
    { id: 'stocktake', icon: '🗂', name: 'تقرير الجرد الشامل', en: 'Full stock-take report' },
  ];

  /* ---------------- view ---------------- */
  function renderReports(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('reports'))}</h2></div>
      <div class="report-picker">${REPORTS.map((r) => `
        <button class="report-card ${r.id === 'balance' ? 'active' : ''}" data-report="${r.id}">
          <span class="report-ic">${r.icon}</span>
          <span>${lang() ? r.name : r.en}</span></button>`).join('')}
      </div>
      <div class="card filters" id="rep-filters"></div>
      <div class="rep-actions">
        <button class="btn btn-primary" id="rep-print">🖨 ${lang() ? 'طباعة التقرير (A4)' : 'Print report (A4)'}</button>
        <button class="btn btn-ghost" id="rep-excel">${t('exportExcel')}</button>
      </div>
      <div id="print-root"></div>`;

    let current = 'balance';
    let lastModel = null; // { headers, rows, totals, title, subtitle, opening/closing... }

    host.querySelectorAll('.report-card').forEach((b) => b.addEventListener('click', () => {
      current = b.dataset.report;
      host.querySelectorAll('.report-card').forEach((x) => x.classList.toggle('active', x === b));
      buildFilters();
      build();
    }));

    /* ---------- filters per report ---------- */
    function buildFilters() {
      const products = [...new Set(App.state.products.map((p) => p.quality))].sort((a, b) => a.localeCompare(b, 'ar'));
      const customers = [...new Set(App.state.transactions.map((x) => x.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
      const needs = {
        balance: ['product', 'gsm', 'size'],
        additions: ['from', 'to', 'product', 'gsm', 'size', 'customer'],
        withdrawals: ['from', 'to', 'product', 'gsm', 'size', 'customer'],
        product: ['from', 'to', 'productCombo'],
        customer: ['from', 'to', 'customer'],
        period: ['from', 'to', 'product', 'gsm', 'size', 'customer', 'type'],
        stocktake: ['product', 'gsm', 'size'],
      }[current];
      const F = host.querySelector('#rep-filters');
      F.innerHTML = '';
      const add = (html) => F.appendChild(el(html));
      if (needs.includes('from')) add(`<label class="fl"><span>${t('from')}</span><input type="date" id="rf-from"></label>`);
      if (needs.includes('to')) add(`<label class="fl"><span>${t('to')}</span><input type="date" id="rf-to"></label>`);
      if (needs.includes('product') || needs.includes('productCombo'))
        add(`<label class="fl"><span>${t('quality')}</span><select id="rf-product"><option value="">${lang() ? '— اختر الصنف —' : '— select —'}</option>${products.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>`);
      if (needs.includes('productCombo')) {
        add(`<label class="fl"><span>${t('gsm')}</span><select id="rf-pgsm"><option value="">—</option></select></label>`);
        add(`<label class="fl"><span>${t('size')}</span><select id="rf-psize"><option value="">—</option></select></label>`);
        F.querySelector('#rf-product').addEventListener('change', () => {
          const combos = App.state.products.filter((p) => p.quality === F.querySelector('#rf-product').value);
          F.querySelector('#rf-pgsm').innerHTML = `<option value="">—</option>` + [...new Set(combos.map((c) => String(c.gsm)))].map((g) => `<option>${esc(g)}</option>`).join('');
          F.querySelector('#rf-psize').innerHTML = `<option value="">—</option>`;
        });
        F.querySelector('#rf-pgsm').addEventListener('change', () => {
          const combos = App.state.products.filter((p) => p.quality === F.querySelector('#rf-product').value && String(p.gsm) === F.querySelector('#rf-pgsm').value);
          F.querySelector('#rf-psize').innerHTML = `<option value="">—</option>` + [...new Set(combos.map((c) => String(c.size)))].map((s) => `<option>${esc(s)}</option>`).join('');
        });
      }
      if (needs.includes('gsm') && !needs.includes('productCombo')) {
        const gsms = [...new Set(App.state.products.map((p) => String(p.gsm)))].sort((a, b) => Number(a) - Number(b));
        add(`<label class="fl"><span>${t('gsm')}</span><select id="rf-gsm"><option value="">${t('all')}</option>${gsms.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label>`);
      }
      if (needs.includes('size') && !needs.includes('productCombo')) {
        const sizes = [...new Set(App.state.products.map((p) => String(p.size)))].sort((a, b) => Number(a) - Number(b));
        add(`<label class="fl"><span>${t('size')}</span><select id="rf-size"><option value="">${t('all')}</option>${sizes.map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>`);
      }
      if (needs.includes('customer'))
        add(`<label class="fl"><span>${t('customer')}</span><select id="rf-customer"><option value="">${lang() ? '— اختر العميل —' : '— select —'}</option>${customers.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>`);
      if (needs.includes('type'))
        add(`<label class="fl"><span>${t('type')}</span><select id="rf-type"><option value="">${t('all')}</option><option value="add">${t('add')}</option><option value="out">${t('out')}</option></select></label>`);
      const btnWrap = el(`<div class="fl fl-btn"><button class="btn btn-primary" id="rf-run">${lang() ? 'عرض التقرير' : 'Generate'}</button></div>`);
      F.appendChild(btnWrap);
      btnWrap.querySelector('#rf-run').addEventListener('click', build);
      F.querySelectorAll('input, select').forEach((i) => i.addEventListener('change', build));
    }

    const val = (id) => { const n = host.querySelector('#' + id); return n ? n.value : ''; };

    /* ---------- build report model ---------- */
    function build() {
      const wf = App.state.settings.weightFactor;
      const from = val('rf-from'), to = val('rf-to');
      const product = val('rf-product') || val('rf-product') || '';
      const gsm = val('rf-gsm') || val('rf-pgsm') || '';
      const size = val('rf-size') || val('rf-psize') || '';
      const customer = val('rf-customer');
      const type = val('rf-type');

      const filterCombo = (r) => (!product || r.quality === product) && (!gsm || String(r.gsm) === gsm) && (!size || String(r.size) === size);
      const filterPeriod = (r) => (!from || r.date >= from) && (!to || r.date <= to);

      let model = null;
      const rep = REPORTS.find((r) => r.id === current);
      const title = lang() ? rep.name : rep.en;

      if (current === 'balance' || current === 'stocktake') {
        const familyOf = (name) => {
          const value = String(name || '').replace(/[\\s\\u0640]+/g, ' ').trim().toLowerCase();
          if (value.includes('تست') && value.includes('لينر') && value.includes('معالج')) return 'تست لينر معالج';
          if (value.includes('توب') && value.includes('لاينر')) return 'توب لاينر';
          return String(name || '').trim();
        };
        const familyOrder = ['تست لينر معالج', 'توب لاينر'];
        let rows = App.state.products.map((p) => {
          const b = App.state.balances.get(p.combo);
          const net = b ? b.net : 0;
          return { quality: p.quality, family: familyOf(p.quality), gsm: p.gsm, size: p.size, net, weight: global.CALC.productWeight(p.size, net, wf), combo: p.combo };
        }).filter(filterCombo).filter((r) => r.net !== 0);
        rows.sort((a, b) => {
          const ia = familyOrder.indexOf(a.family), ib = familyOrder.indexOf(b.family);
          const oa = ia < 0 ? familyOrder.length : ia, ob = ib < 0 ? familyOrder.length : ib;
          return oa - ob || a.family.localeCompare(b.family, 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size);
        });
        const totals = {
          net: global.CALC.round6(rows.reduce((s, r) => s + r.net, 0)),
          weight: global.CALC.round6(rows.reduce((s, r) => s + r.weight, 0)),
        };
        model = {
          title,
          subtitle: [fmtSubtitle()],
          headers: [t('quality'), t('gsm'), t('size'), t('balance'), t('weight') + ' (' + t('kg') + ')'],
          // Show each main product name once per consecutive group; list only its available GSM/size variants below it.
          rows: rows.map((r, index) => [
            index === 0 || rows[index - 1].family !== r.family ? r.family : '',
            fmtNum(r.gsm), fmtNum(r.size), fmtNum(r.net), fmtNum(r.weight, 3),
          ]),
          totalsRow: [lang() ? 'الإجمالي' : 'Total', `${fmtNum(rows.length)} ${lang() ? 'صنف' : 'items'}`, '', fmtNum(totals.net), fmtNum(totals.weight, 3)],
          summary: current === 'stocktake' ? [
            `${lang() ? 'عدد الأصناف' : 'Items'}: ${fmtNum(rows.length)}`,
            `${lang() ? 'أصناف برصيد سالب' : 'Negative-balance items'}: ${fmtNum(rows.filter((r) => r.net < 0).length)}`,
          ] : null,
        };
      } else if (current === 'additions' || current === 'withdrawals') {
        const isAdd = current === 'additions';
        let rows = App.state.transactions.filter((r) => (isAdd ? (Number(r.addQty) || 0) > 0 : (Number(r.outQty) || 0) > 0))
          .filter(filterCombo).filter(filterPeriod);
        if (customer) rows = rows.filter((r) => r.customer === customer);
        rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
        const qtySum = global.CALC.round6(rows.reduce((s, r) => s + (isAdd ? (Number(r.addQty) || 0) : (Number(r.outQty) || 0)), 0));
        const wSum = global.CALC.round6(rows.reduce((s, r) => s + (Number(r.weight) || 0), 0));
        model = {
          title,
          subtitle: [fmtSubtitle(), `${t('from')}: ${from ? fmtDate(from) : '—'}   ${t('to')}: ${to ? fmtDate(to) : '—'}`],
          headers: [t('date'), t('permit'), t('quality'), t('gsm'), t('size'), t('customer'), isAdd ? t('addQty') : t('outQty'), `${t('weight')} (${t('kg')})`],
          rows: rows.map((r) => [fmtDate(r.date), r.permitNo || '', r.quality, fmtNum(r.gsm), fmtNum(r.size), r.customer || '',
            fmtNum(isAdd ? r.addQty : r.outQty), r.weight != null ? fmtNum(r.weight, 3) : '']),
          totalsRow: [lang() ? 'الإجمالي' : 'Total', `${fmtNum(rows.length)} ${lang() ? 'حركة' : 'rows'}`, '', '', '', '', fmtNum(qtySum), fmtNum(wSum, 3)],
        };
      } else if (current === 'product') {
        const q = val('rf-product'), g = val('rf-pgsm'), s = val('rf-psize');
        if (!q || g === '' || s === '') {
          global.UI.toast(lang() ? 'اختر الصنف والجرام والمقاس أولًا' : 'Select product, GSM and size first', 'warn');
          host.querySelector('#print-root').innerHTML = '';
          return;
        }
        const comboTx = App.state.transactions
          .filter((r) => global.CALC.sameCombo(r, q, Number(g), Number(s)))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
        /* opening = net of rows before the period start; when the period
           starts at the beginning (no from-date) the opening is 0 */
        const opening = from
          ? global.CALC.openingBalance(App.state.transactions, q, Number(g), Number(s), from)
          : 0;
        let run = opening;
        const rows = [];
        for (const r of comboTx) {
          if (!filterPeriod(r)) continue;
          run += (Number(r.addQty) || 0) - (Number(r.outQty) || 0);
          rows.push([fmtDate(r.date), r.customer || '', r.permitNo || '', r.addQty ? fmtNum(r.addQty) : '', r.outQty ? fmtNum(r.outQty) : '', fmtNum(global.CALC.round6(run)), r.settlement || '']);
        }
        const inPeriodAdd = comboTx.filter(filterPeriod).reduce((s2, r) => s2 + (Number(r.addQty) || 0), 0);
        const inPeriodOut = comboTx.filter(filterPeriod).reduce((s2, r) => s2 + (Number(r.outQty) || 0), 0);
        model = {
          title,
          subtitle: [
            `${t('quality')}: ${q} — ${t('gsm')}: ${g} — ${t('size')}: ${s}`,
            `${t('from')}: ${from ? fmtDate(from) : '—'}   ${t('to')}: ${to ? fmtDate(to) : '—'}`,
          ],
          openingClosing: [
            `${lang() ? 'الرصيد الافتتاحي' : 'Opening balance'}: ${fmtNum(opening)}`,
            `${lang() ? 'إجمالي الإضافات في الفترة' : 'Additions in period'}: ${fmtNum(global.CALC.round6(inPeriodAdd))}`,
            `${lang() ? 'إجمالي الصرف في الفترة' : 'Withdrawals in period'}: ${fmtNum(global.CALC.round6(inPeriodOut))}`,
            `${lang() ? 'الرصيد الختامي' : 'Closing balance'}: ${fmtNum(global.CALC.round6(run))}`,
          ],
          headers: [t('date'), t('customer'), t('permit'), t('addQty'), t('outQty'), lang() ? 'الرصيد الجاري' : 'Running balance', t('settlement')],
          rows,
          totalsRow: [lang() ? 'الإجمالي' : 'Total', `${fmtNum(rows.length)} ${lang() ? 'حركة' : 'rows'}`, '', fmtNum(global.CALC.round6(inPeriodAdd)), fmtNum(global.CALC.round6(inPeriodOut)), fmtNum(global.CALC.round6(run)), ''],
        };
      } else if (current === 'customer') {
        const c = val('rf-customer');
        if (!c) { toast(lang() ? 'اختر العميل أولًا' : 'Select a customer first', 'warn'); host.querySelector('#print-root').innerHTML = ''; return; }
        let rows = App.state.transactions.filter((r) => r.customer === c).filter(filterCombo).filter(filterPeriod);
        rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
        const addSum = global.CALC.round6(rows.reduce((s, r) => s + (Number(r.addQty) || 0), 0));
        const outSum = global.CALC.round6(rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0));
        model = {
          title,
          subtitle: [`${t('customer')}: ${c}`, fmtSubtitle(), `${t('from')}: ${from ? fmtDate(from) : '—'}   ${t('to')}: ${to ? fmtDate(to) : '—'}`],
          headers: [t('date'), t('quality'), t('gsm'), t('size'), t('permit'), t('addQty'), t('outQty'), t('settlement')],
          rows: rows.map((r) => [fmtDate(r.date), r.quality, fmtNum(r.gsm), fmtNum(r.size), r.permitNo || '', r.addQty ? fmtNum(r.addQty) : '', r.outQty ? fmtNum(r.outQty) : '', r.settlement || '']),
          totalsRow: [lang() ? 'الإجمالي' : 'Total', `${fmtNum(rows.length)} ${lang() ? 'حركة' : 'rows'}`, '', '', '', fmtNum(addSum), fmtNum(outSum), ''],
          summary: [
            `${t('totalAdd')}: ${fmtNum(addSum)}`,
            `${t('totalOut')}: ${fmtNum(outSum)}`,
            `${lang() ? 'الصافي للعميل' : 'Net for customer'}: ${fmtNum(global.CALC.round6(addSum - outSum))}`,
          ],
        };
      } else if (current === 'period') {
        let rows = App.state.transactions.filter(filterPeriod).filter(filterCombo);
        if (customer) rows = rows.filter((r) => r.customer === customer);
        if (type) rows = rows.filter((r) => (type === 'add' ? (Number(r.addQty) || 0) > 0 : (Number(r.outQty) || 0) > 0));
        rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
        const addSum = global.CALC.round6(rows.reduce((s, r) => s + (Number(r.addQty) || 0), 0));
        const outSum = global.CALC.round6(rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0));
        model = {
          title,
          subtitle: [fmtSubtitle(), `${t('from')}: ${from ? fmtDate(from) : '—'}   ${t('to')}: ${to ? fmtDate(to) : '—'}`],
          summary: [
            `${t('countAdd')}: ${fmtNum(rows.filter((r) => (Number(r.addQty) || 0) > 0).length)} — ${t('totalAdd')}: ${fmtNum(addSum)}`,
            `${t('countOut')}: ${fmtNum(rows.filter((r) => (Number(r.outQty) || 0) > 0).length)} — ${t('totalOut')}: ${fmtNum(outSum)}`,
            `${lang() ? 'صافي الحركة خلال الفترة' : 'Net movement in period'}: ${fmtNum(global.CALC.round6(addSum - outSum))}`,
          ],
          headers: [t('date'), t('type'), t('quality'), t('gsm'), t('size'), t('customer'), t('permit'), t('addQty'), t('outQty'), t('settlement')],
          rows: rows.map((r) => [fmtDate(r.date), (Number(r.addQty) || 0) > 0 ? t('add') : t('out'), r.quality, fmtNum(r.gsm), fmtNum(r.size), r.customer || '', r.permitNo || '', r.addQty ? fmtNum(r.addQty) : '', r.outQty ? fmtNum(r.outQty) : '', r.settlement || '']),
          totalsRow: [lang() ? 'الإجمالي' : 'Total', `${fmtNum(rows.length)} ${lang() ? 'حركة' : 'rows'}`, '', '', '', '', '', fmtNum(addSum), fmtNum(outSum), ''],
        };
      }

      // Hide zero values consistently in every report view and Excel export.
      // Keep text labels and non-zero values; blank only cells that represent numeric zero.
      const isZeroDisplay = (value) => {
        if (typeof value === 'number') return Number.isFinite(value) && value === 0;
        if (typeof value !== 'string') return false;
        const normalized = value.trim().replace(/,/g, '');
        return normalized !== '' && /^[-+]?0+(?:\\.0+)?$/.test(normalized);
      };
      const hideZeroCells = (row) => Array.isArray(row)
        ? row.map((cell) => isZeroDisplay(cell) ? '' : cell)
        : row;
      if (model) {
        model.rows = (model.rows || []).map(hideZeroCells);
        if (model.totalsRow) model.totalsRow = hideZeroCells(model.totalsRow);
        // Remove summary statements whose reported numeric values are all zero.
        if (Array.isArray(model.summary)) {
          model.summary = model.summary.filter((line) => {
            const values = String(line).match(/(?:[:：]\\s*)([-+]?\\d[\\d,]*(?:\\.\\d+)?)/g) || [];
            return values.length === 0 || values.some((part) => {
              const number = Number(part.replace(/^.*[:：]\\s*/, '').replace(/,/g, ''));
              return Number.isFinite(number) && number !== 0;
            });
          });
        }
        if (Array.isArray(model.openingClosing)) {
          model.openingClosing = model.openingClosing.filter((line) => {
            const match = String(line).match(/[:：]\\s*([-+]?\\d[\\d,]*(?:\\.\\d+)?)/);
            return !match || Number(match[1].replace(/,/g, '')) !== 0;
          });
        }
      }
      if (model && Array.isArray(model.summary)) {
        model.summary = model.summary.filter((line) => !/(?:^|[:：])\s*(?:0+(?:[.,]0+)?)(?:\s|$)/.test(String(line)));
      }
      lastModel = model;
      if (model) renderPreview(model);
    }

    function fmtSubtitle() {
      const cn = App.state.settings.companyName;
      return `${lang() ? 'التاريخ' : 'Generated'}: ${fmtDate(global.UI.todayISO())}${cn ? ' — ' + cn : ''}`;
    }

    /* ---------- A4 pagination & preview ---------- */
    function renderPreview(model) {
      const root = host.querySelector('#print-root');
      root.innerHTML = '';
      const pages = paginate(model);
      pages.forEach((p, i) => root.appendChild(p));
      /* page counter annotation for screen */
    }

    function paginate(model) {
      const meta = {
        title: model.title,
        company: App.state.settings.companyName || (lang() ? 'إدارة المخزن' : 'Inventory Management'),
        subtitle: model.subtitle || [],
        summary: model.summary || null,
        openingClosing: model.openingClosing || null,
        headers: model.headers,
        totalsRow: model.totalsRow || null,
        totalPages: 0,
      };
      /* measure a sample of rows in a fixed-height probe page:
         .rp-content clientHeight = real per-page space for rows */
      const SAMPLE = 50;
      const probe = buildPage(meta, model.rows.slice(0, SAMPLE), 1, 1);
      probe.classList.add('probe');
      probe.style.cssText = 'position:fixed; visibility:hidden; left:-9999px; top:0;';
      document.body.appendChild(probe);
      const contentEl = probe.querySelector('.rp-content');
      const theadH = probe.querySelector('thead').offsetHeight;
      const tfootEl = probe.querySelector('tfoot');
      const tfootH = tfootEl ? tfootEl.offsetHeight : 0;
      const trs = [...probe.querySelectorAll('tbody tr')];
      const hs = trs.map((tr) => tr.offsetHeight);
      const avgH = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : 20;
      /* read content space while the probe is STILL attached to the DOM —
         a detached element reports clientHeight = 0 */
      const contentSpace = contentEl.clientHeight;
      const theadSpace = theadH;
      const tfootSpace = tfootH;
      probe.remove();
      /* 46px safety margin: print metrics differ slightly from screen and
         the signature footer must never spill onto an extra page */
      const availH = Math.max(140, contentSpace - theadSpace - tfootSpace - 46);
      const capacity = Math.max(5, Math.floor(availH / Math.max(avgH, 16)));
      const total = model.rows.length;
      const chunks = [];
      if (total === 0) chunks.push([]);
      for (let i = 0; i < total; i += capacity) chunks.push(model.rows.slice(i, i + capacity));
      return chunks.map((rowsChunk, i) => buildPage(meta, rowsChunk, i + 1, chunks.length));
    }

    function buildPage(meta, rows, pageNo, total) {
      const page = el(`<div class="print-page">
        <div class="rp-head">
          <div class="rp-co">${esc(meta.company)}</div>
          <div class="rp-title">${esc(meta.title)}</div>
          <div class="rp-sub">${meta.subtitle.map((s) => `<div>${esc(s)}</div>`).join('')}</div>
          ${meta.openingClosing ? `<div class="rp-ob">${meta.openingClosing.map((s) => `<span>${esc(s)}</span>`).join(' — ')}</div>` : ''}
          ${meta.summary && pageNo === 1 ? `<div class="rp-ob">${meta.summary.map((s) => `<span>${esc(s)}</span>`).join(' — ')}</div>` : ''}
          <div class="rp-meta"><span>${lang() ? 'صفحة' : 'Page'} ${pageNo} / ${total}</span><span>${lang() ? 'تاريخ الطباعة' : 'Printed'}: ${fmtDate(global.UI.todayISO())}</span></div>
        </div>
        <div class="rp-content">
          <table class="rp-table">
            <thead><tr>${meta.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
              : `<tr><td colspan="${meta.headers.length}" class="empty">${lang() ? 'لا توجد بيانات' : 'No data'}</td></tr>`}</tbody>
            ${meta.totalsRow ? `<tfoot><tr>${meta.totalsRow.map((c) => `<td>${esc(c)}</td>`).join('')}</tr></tfoot>` : ''}
          </table>
        </div>
        <div class="rp-foot">
          <div class="sig-row">
            <div class="sig"><span>${lang() ? 'أمين المخزن' : 'Storekeeper'}</span><i></i></div>
            <div class="sig"><span>${lang() ? 'المحاسب' : 'Accountant'}</span><i></i></div>
            <div class="sig"><span>${lang() ? 'مدير المخزن' : 'Warehouse manager'}</span><i></i></div>
          </div>
        </div>
      </div>`);
      return page;
    }

    /* print & export */
    host.querySelector('#rep-print').addEventListener('click', () => {
      if (!lastModel) build();
      if (!lastModel) return;
      window.print();
    });
    host.querySelector('#rep-excel').addEventListener('click', () => {
      if (!lastModel) build();
      if (!lastModel) return;
      global.EXCEL.exportReportAOA(
        lastModel.title,
        lastModel.headers,
        lastModel.rows,
        lastModel.totalsRow,
        lastModel.title.replace(/\s+/g, '_'),
      );
      toast(lang() ? 'تم تنزيل التقرير بصيغة إكسل' : 'report exported', 'ok');
    });

    buildFilters();
    build();
  }

  global.App.registerView('reports', renderReports);
})(window);
