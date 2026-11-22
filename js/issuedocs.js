/* =========================================================================
   issuedocs.js — أذون الصرف: قائمة قابلة للبحث + عرض إذن احترافي A4
   -------------------------------------------------------------------------
   A document is a movement group whose rows carry outQty. Its snapshot is
   the STORED rows themselves — later inventory changes never alter an
   already-saved document. Groups inside one document are reconstructed by
   (product, GSM, roll weight) so multi-group documents print correctly.
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, toast, confirmDialog } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';
  const familyOf = (name) => App.productFamily(name);
  const CLS_LABEL = global.TX.CLS_LABEL; /* 'ض' → ضريبي / 'غ' → غير ضريبي */

  /* ---------------- document collector ----------------
     from out-rows only; legacy single rows (no groupId) become one-row docs */
  function collectIssueDocs(transactions) {
    const outRows = transactions.filter((r) => (Number(r.outQty) || 0) > 0);
    const groups = App.buildGroups(outRows);
    for (const g of groups) {
      /* sub-groups: one printed table per (product, gsm, roll weight) */
      const subMap = new Map();
      for (const r of g.rows) {
        const key = global.CALC.comboGroupWOf(r); /* group = (product, gsm, weight), sizes inside */
        if (!subMap.has(key)) {
          subMap.set(key, { quality: r.quality, family: familyOf(r.quality), gsm: r.gsm, weight: r.weight, sizes: [] });
        }
        subMap.get(key).sizes.push({ size: r.size, qty: Number(r.outQty) || 0, id: r.id });
      }
      g.docGroups = [...subMap.values()].map((sg) => {
        sg.sizes.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
        sg.total = sg.sizes.reduce((s, x) => s + x.qty, 0);
        return sg;
      });
      g.totalRolls = g.docGroups.reduce((s, sg) => s + sg.total, 0);
      g.customer = App.canonicalCustomer(g.customer) || g.customer || '';
      g.classification = g.settlement === 'ض' || g.settlement === 'غ' ? g.settlement : '';
    }
    return groups;
  }
  App.collectIssueDocs = collectIssueDocs;

  const clsBadge = (cls) => {
    if (!cls) return `<span class="muted small">—</span>`;
    return `<span class="badge ${cls === 'ض' ? 'badge-tax' : 'badge-nontax'}">${CLS_LABEL[cls]}</span>`;
  };

  /* ================= أذون الصرف — list page ================= */
  function renderIssuedocs(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('issuedocs'))}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="docs-new">+ ${lang() ? 'إذن صرف جديد' : 'New issue document'}</button>
          <button class="btn btn-ghost" id="docs-exp">${t('exportExcel')}</button>
        </div></div>
      <div class="card filters">
        <input type="text" id="doc-q" placeholder="${lang() ? 'بحث برقم الإذن أو اسم العميل…' : 'Search doc no. / customer…'}">
        <input type="date" id="doc-from" title="${t('from')}">
        <input type="date" id="doc-to" title="${t('to')}">
        <select id="doc-cls">
          <option value="">${t('classification')}: ${t('all')}</option>
          <option value="ض">${t('tax')}</option>
          <option value="غ">${t('nontax')}</option>
        </select>
        <select id="doc-sort">
          <option value="new">${t('newest')}</option>
          <option value="old">${t('oldest')}</option>
        </select>
        <button class="btn btn-ghost" id="doc-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="doc-table-host"></div>`;

    let docs = [], page = 0;
    const PAGE_SIZE = 60;

    function applyFilters() {
      const q = host.querySelector('#doc-q').value.trim().toLowerCase();
      const from = host.querySelector('#doc-from').value;
      const to = host.querySelector('#doc-to').value;
      const cls = host.querySelector('#doc-cls').value;
      const sort = host.querySelector('#doc-sort').value;
      docs = collectIssueDocs(App.state.transactions).filter((d) =>
        (!from || d.date >= from) && (!to || d.date <= to) &&
        (!cls || d.classification === cls) &&
        (!q || String(d.permitNo || '').toLowerCase().includes(q) || String(d.customer || '').toLowerCase().includes(q)));
      docs.sort((a, b) => {
        const ta = `${a.date}|${a.rows[0].id || 0}`, tb = `${b.date}|${b.rows[0].id || 0}`;
        const cmp = ta < tb ? 1 : ta > tb ? -1 : 0; /* newest first */
        return sort === 'old' ? -cmp : cmp;
      });
      page = 0;
      renderRows();
    }

    function renderRows() {
      const host2 = host.querySelector('#doc-table-host');
      const total = docs.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      const slice = docs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const rolls = docs.reduce((s, d) => s + d.totalRolls, 0);
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${t('docNo')}</th><th>${t('customer')}</th><th>${t('date')}</th>
            <th>${t('classification')}</th><th>${lang() ? 'المقاسات' : 'Sizes'}</th>
            <th class="num">${t('totalRolls')}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map(docRowHtml).join('') :
            `<tr><td colspan="7" class="empty">${lang() ? 'لا توجد أذون صرف مطابقة' : 'No matching issue documents'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="5">${t('total')} (${fmtNum(total)} ${lang() ? 'إذن' : 'documents'})</td>
            <td class="num">${fmtNum(rolls)}</td><td></td>
          </tr></tfoot>
        </table>
        ${pages > 1 ? `<div class="pager">
          <button class="btn btn-ghost" id="dpg-prev" ${page === 0 ? 'disabled' : ''}>‹</button>
          <span>${t('page')} ${page + 1} / ${fmtNum(pages)}</span>
          <button class="btn btn-ghost" id="dpg-next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>
        </div>` : ''}`;

      host2.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
        const doc = docs.find((d) => d.key === btn.dataset.key);
        if (!doc) return;
        const act = btn.dataset.act;
        if (act === 'view') {
          App.pendingDoc = doc; App.autoPrintDoc = false;
          App.navigate('issuedoc');
        } else if (act === 'print') {
          App.pendingDoc = doc; App.autoPrintDoc = true;
          App.navigate('issuedoc');
        } else if (act === 'edit') {
          if (doc.groupId) {
            App.pendingEdit = doc;
            App.navigate('baker-issue');
          } else {
            App.openLegacyEditModal(doc.rows[0]);
          }
        } else if (act === 'del') {
          const ok = await confirmDialog({
            title: lang() ? 'حذف إذن الصرف' : 'Delete issue document',
            message: lang()
              ? `سيتم حذف الإذن "${doc.permitNo || 'بدون رقم'}" بكل أسطره (${doc.rows.length} مقاس — ${fmtNum(doc.totalRolls)} لفة) نهائيًا وتحديث الرصيد تلقائيًا.\nالعميل: ${doc.customer} — التاريخ: ${fmtDate(doc.date)}`
              : `Delete document "${doc.permitNo || ''}" permanently (${doc.totalRolls} rolls)? Balances are recalculated automatically.`,
            danger: true,
            extra: lang() ? `<code>${esc(doc.date)} — ${esc(doc.customer)}</code>` : '',
          });
          if (ok) {
            await global.TX.deleteMovement(doc);
            toast(lang() ? 'تم حذف الإذن وتحديث الرصيد' : 'document deleted, balances updated', 'ok');
            await App.refresh();
          }
        }
      }));
      const bind = (id, fn) => { const b = host2.querySelector(id); if (b) b.addEventListener('click', () => { fn(); renderRows(); }); };
      bind('#dpg-prev', () => { page--; });
      bind('#dpg-next', () => { page++; });
    }

    function docRowHtml(d) {
      const sizesLabel = d.docGroups.map((sg) =>
        `${sg.gsm == null ? '—' : fmtNum(sg.gsm)}g${sg.weight != null ? '/' + fmtNum(sg.weight) + 'كجم' : ''}: ` +
        sg.sizes.map((s) => `${fmtNum(s.size == null ? '—' : s.size)}×${fmtNum(s.qty)}`).join('، ')).join(' | ');
      return `<tr>
        <td data-label="${t('docNo')}"><strong>${esc(d.permitNo || '—')}</strong></td>
        <td data-label="${t('customer')}">${esc(d.customer || '')}</td>
        <td data-label="${t('date')}">${fmtDate(d.date)}</td>
        <td data-label="${t('classification')}">${clsBadge(d.classification)}</td>
        <td data-label="${lang() ? 'المقاسات' : 'Sizes'}"><span class="sizes-label">${esc(sizesLabel)}</span></td>
        <td class="num" data-label="${t('totalRolls')}"><strong>${fmtNum(d.totalRolls)}</strong></td>
        <td class="actions-cell">
          <button class="icon-btn" data-act="view" data-key="${esc(d.key)}" title="${t('viewDoc')}">👁</button>
          <button class="icon-btn" data-act="print" data-key="${esc(d.key)}" title="${t('printDoc')}">🖨</button>
          <button class="icon-btn" data-act="edit" data-key="${esc(d.key)}" title="${t('edit')}">✎</button>
          <button class="icon-btn danger" data-act="del" data-key="${esc(d.key)}" title="${t('del')}">🗑</button>
        </td></tr>`;
    }

    host.querySelector('#doc-q').addEventListener('input', applyFilters);
    host.querySelector('#doc-from').addEventListener('change', applyFilters);
    host.querySelector('#doc-to').addEventListener('change', applyFilters);
    host.querySelector('#doc-cls').addEventListener('change', applyFilters);
    host.querySelector('#doc-sort').addEventListener('change', applyFilters);
    host.querySelector('#doc-clear').addEventListener('click', () => {
      ['#doc-q', '#doc-from', '#doc-to', '#doc-cls'].forEach((s) => { host.querySelector(s).value = ''; });
      host.querySelector('#doc-sort').value = 'new';
      applyFilters();
    });
    host.querySelector('#docs-new').addEventListener('click', () => { App.pendingEdit = null; App.navigate('baker-issue'); });
    host.querySelector('#docs-exp').addEventListener('click', () => {
      const headers = [t('docNo'), t('customer'), t('date'), t('classification'), lang() ? 'الصنف' : 'Product',
        t('gsm'), t('rollWeight'), t('size'), t('outQty')];
      const rows = [];
      for (const d of docs) {
        for (const sg of d.docGroups) {
          for (const s of sg.sizes) {
            rows.push([d.permitNo || '', d.customer, d.date, d.classification ? CLS_LABEL[d.classification] : '',
              sg.family, sg.gsm == null ? '' : sg.gsm, sg.weight == null ? '' : sg.weight, s.size, s.qty]);
          }
        }
      }
      global.EXCEL.exportReportAOA(t('issuedocs'), headers, rows, null, 'اذون_الصرف');
      toast(lang() ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });

    applyFilters();
  }

  /* ================= إذن صرف — professional A4 document view ================= */
  function renderIssuedoc(host) {
    const d = App.pendingDoc;
    if (!d) { host.innerHTML = '<div class="card error-card">لم يتم تحديد إذن — ارجع إلى أذون الصرف.</div>'; return; }
    const company = App.state.settings.companyName || (lang() ? 'إدارة المخزن' : 'Inventory Management');

    const groupTables = d.docGroups.map((sg, i) => `
      <div class="doc-group">
        <div class="doc-group-title">${lang() ? 'مجموعة' : 'Group'} ${fmtNum(i + 1)} —
          ${esc(sg.family)} | ${t('gsm')}: <strong>${sg.gsm == null ? '—' : fmtNum(sg.gsm)}</strong> |
          ${t('rollWeight')}: <strong>${sg.weight == null ? '—' : fmtNum(sg.weight)}</strong></div>
        <table class="rp-table">
          <thead><tr><th>${t('size')} (${lang() ? 'سم' : 'cm'})</th><th>${lang() ? 'عدد الرولات' : 'Roll quantity'}</th></tr></thead>
          <tbody>${sg.sizes.map((s) => `<tr><td>${s.size == null ? '—' : fmtNum(s.size)}</td><td>${fmtNum(s.qty)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>${lang() ? 'إجمالي المجموعة' : 'Group total'}</td><td>${fmtNum(sg.total)}</td></tr></tfoot>
        </table>
      </div>`).join('');

    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('issuedoc'))} ${d.permitNo ? '— ' + esc(d.permitNo) : ''}</h2>
        <div class="head-actions doc-actions">
          <button class="btn btn-primary" id="docv-print">🖨 ${t('printDoc')} (A4)</button>
          <button class="btn btn-ghost" id="docv-edit">✎ ${t('edit')}</button>
          <button class="btn btn-ghost" id="docv-back">${lang() ? '← رجوع لأذون الصرف' : '← Back'}</button>
        </div></div>
      <div id="print-root">
        <div class="print-page doc-page">
          <div class="rp-head">
            <div class="rp-co">${esc(company)}</div>
            <div class="rp-title">${lang() ? 'إذن صرف مخزني' : 'Stock Issue Document'}</div>
            <div class="rp-sub"><div>${t('docNo')}: <strong>${esc(d.permitNo || '—')}</strong> — ${t('classification')}: <strong>${d.classification ? CLS_LABEL[d.classification] : '—'}</strong></div></div>
          </div>
          <table class="doc-meta">
            <tbody><tr>
              <th>${t('customer')}</th><td>${esc(d.customer || '—')}</td>
              <th>${t('date')}</th><td>${fmtDate(d.date)}</td>
            </tr></tbody>
          </table>
          ${groupTables}
          <table class="rp-table doc-total">
            <tbody><tr><td class="doc-total-label">${t('totalRolls')}</td><td class="doc-total-num">${fmtNum(d.totalRolls)} ${t('rolls')}</td></tr></tbody>
          </table>
          ${d.notes ? `<div class="doc-notes">${t('notes')}: ${esc(d.notes)}</div>` : ''}
          <div class="rp-foot">
            <div class="sig-row">
              <div class="sig"><span>${t('deliverer')}</span><i></i></div>
              <div class="sig"><span>${t('receiver')}</span><i></i></div>
            </div>
          </div>
        </div>
      </div>`;

    host.querySelector('#docv-print').addEventListener('click', () => window.print());
    host.querySelector('#docv-edit').addEventListener('click', () => {
      if (d.groupId) { App.pendingEdit = d; App.navigate('baker-issue'); }
      else App.openLegacyEditModal(d.rows[0]);
    });
    host.querySelector('#docv-back').addEventListener('click', () => App.navigate('issuedocs'));
    if (App.autoPrintDoc) {
      App.autoPrintDoc = false;
      setTimeout(() => window.print(), 350); /* let fonts/layout settle */
    }
  }

  App.registerView('issuedocs', renderIssuedocs);
  App.registerView('issuedoc', renderIssuedoc);
})(window);
