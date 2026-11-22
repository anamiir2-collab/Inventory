/* =========================================================================
   backup.js — النسخ الاحتياطي والاستعادة + استيراد الإكسل + الإعدادات
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, toast, confirmDialog, openModal, closeModal } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';

  /* ================= Excel import dialog with preview ================= */

  function openImportDialog(replaceMode) {
    const node = el(`<div class="import-dialog">
      <p class="muted">${lang()
        ? 'ارفع ملف الإكسل (نفس بنية ملف "الرصيد 2025.xlsx"). سيتم كشف التكرارات تلقائيًا وعرض معاينة قبل الحفظ.'
        : 'Upload the Excel file (same structure as the original). Duplicates are detected and a preview is shown before saving.'}</p>
      <div class="import-zone" id="imp-zone">
        <input type="file" id="imp-file" accept=".xlsx,.xls" hidden>
        <div class="drop-hint">📁 ${lang() ? 'اختر ملف الإكسل أو اسحبه هنا' : 'Choose the Excel file or drop it here'}</div>
        <div class="file-name" id="imp-name"></div>
      </div>
      <div id="imp-preview"></div>
      <div class="form-error" id="imp-error"></div>
      <div class="confirm-actions">
        <button class="btn btn-primary" id="imp-commit" disabled>${replaceMode ? (lang() ? 'استبدال كل البيانات' : 'Replace all data') : (lang() ? 'حفظ السجلات الجديدة' : 'Save new records')}</button>
        <button class="btn btn-ghost" id="imp-cancel">${t('cancel')}</button>
      </div></div>`);
    openModal(node, {
      title: replaceMode ? (lang() ? 'استيراد مع استبدال البيانات' : 'Import (replace)') : (lang() ? 'استيراد ملف الإكسل' : 'Import Excel file'),
      wide: true,
    });

    const zone = node.querySelector('#imp-zone');
    const fileIn = node.querySelector('#imp-file');
    const commitBtn = node.querySelector('#imp-commit');
    let parsed = null, cls = null, existing = null;

    zone.addEventListener('click', () => fileIn.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) handleFile(fileIn.files[0]); });
    node.querySelector('#imp-cancel').addEventListener('click', closeModal);

    async function handleFile(file) {
      const errBox = node.querySelector('#imp-error');
      errBox.textContent = '';
      node.querySelector('#imp-name').textContent = file.name;
      try {
        const buf = await file.arrayBuffer();
        /* NOTE: read WITHOUT cellDates → date cells arrive as Excel serial
           numbers, which excelDateToStr converts deterministically in UTC
           (no timezone drift). */
        const wb = global.XLSX.read(buf);
        parsed = global.EXCEL.parseWorkbook(wb);
        existing = {
          tx: await global.DB.getAll('transactions'),
          prod: await global.DB.getAll('products'),
        };
        cls = global.EXCEL.classifyImport(parsed.transactions, parsed.products, existing.tx, existing.prod);
        renderPreview();
        commitBtn.disabled = false;
      } catch (e) {
        console.error(e);
        errBox.textContent = lang() ? `فشل قراءة الملف: ${e.message}` : `Failed to read file: ${e.message}`;
      }
    }

    function renderPreview() {
      const s = parsed.stats;
      const box = node.querySelector('#imp-preview');
      box.innerHTML = `
        <div class="import-stats">
          <div class="imp-line"><strong>${lang() ? 'الورق المكتشفة' : 'Sheets found'}:</strong> ${s.sheets.map(esc).join(' · ')}
            ${s.balanceSheetFound ? '✓' : '⚠'} ${s.txSheetFound ? '✓' : '⚠'}</div>
          <div class="imp-grid">
            <div class="stat-mini"><span>${lang() ? 'أصناف في الملف' : 'Products in file'}</span><strong>${fmtNum(parsed.products.length)}</strong></div>
            <div class="stat-mini"><span>${lang() ? 'حركات في الملف' : 'Transactions in file'}</span><strong>${fmtNum(parsed.transactions.length)}</strong></div>
            <div class="stat-mini ok"><span>${lang() ? 'جديدة (ستُحفظ)' : 'New (to save)'}</span><strong>${fmtNum(cls.newTx.length)}</strong></div>
            <div class="stat-mini warn"><span>${lang() ? 'مكررة (موجودة في القاعدة)' : 'Duplicates (already in DB)'}</span><strong>${fmtNum(cls.dupTx.length)}</strong></div>
            <div class="stat-mini warn"><span>${lang() ? 'صفوف متطابقة داخل الملف (تُحفظ كسجلات منفصلة)' : 'Identical rows in file (kept as separate records)'}</span><strong>${fmtNum(cls.inFileDup.length)}</strong></div>
            <div class="stat-mini"><span>${lang() ? 'حركات ملغاة (لاغي)' : 'Void rows'}</span><strong>${fmtNum(s.voidTx)}</strong></div>
            <div class="stat-mini"><span>${lang() ? 'حركات ناقصة (بدون جرام/مقاس)' : 'Incomplete rows'}</span><strong>${fmtNum(s.incompleteTx)}</strong></div>
            <div class="stat-mini"><span>${lang() ? 'أصناف جديدة' : 'New products'}</span><strong>${fmtNum(cls.newProd.length)}</strong></div>
          </div>
          ${s.warnings.length ? `<div class="imp-warnings">${s.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
          <details class="imp-sample"><summary>${lang() ? 'معاينة أول 5 حركات جديدة' : 'Preview first 5 new transactions'}</summary>
            <div class="table-wrap"><table class="data-table">
              <thead><tr><th>${t('date')}</th><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th><th>${t('customer')}</th><th>${t('addQty')}</th><th>${t('outQty')}</th></tr></thead>
              <tbody>${cls.newTx.slice(0, 5).map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.quality)}</td><td>${esc(r.gsm == null ? '—' : r.gsm)}</td><td>${esc(r.size == null ? '—' : r.size)}</td><td>${esc(r.customer || '')}</td><td>${fmtNum(r.addQty)}</td><td>${fmtNum(r.outQty)}</td></tr>`).join('')}</tbody>
            </table></div>
          </details>
        </div>`;
    }

    commitBtn.addEventListener('click', async () => {
      if (!parsed) return;
      if (replaceMode) {
        const ok = await confirmDialog({
          title: lang() ? '⚠ استبدال كل البيانات' : 'Replace all data',
          message: lang()
            ? `سيتم حذف جميع البيانات الحالية (${fmtNum(existing.tx.length)} حركة و ${fmtNum(existing.prod.length)} صنف) واستبدالها بمحتوى الملف. لا يمكن التراجع إلا باستعادة نسخة احتياطية. متابعة؟`
            : `All current data (${existing.tx.length} transactions) will be replaced by the file content. Continue?`,
          danger: true,
        });
        if (!ok) return;
      }
      commitBtn.disabled = true;
      try {
        const res = await global.EXCEL.commitImport(parsed, existing.tx, existing.prod, replaceMode);
        closeModal();
        toast(lang()
          ? `تم الاستيراد: ${fmtNum(res.importedTx)} حركة جديدة، ${fmtNum(res.importedProd)} صنف جديد — تم تخطي التكرارات`
          : `Imported ${res.importedTx} new transactions, ${res.importedProd} new products — duplicates skipped`, 'ok');
        await App.refresh();
      } catch (e) {
        console.error(e);
        toast(lang() ? `فشل الحفظ: ${e.message}` : `Save failed: ${e.message}`, 'err');
        commitBtn.disabled = false;
      }
    });
  }
  global.BACKUP = { openImportDialog };

  /* ================= Backup & Restore view ================= */
  function renderBackup(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('backup'))}</h2></div>
      <div class="grid-2">
        <div class="card">
          <h3>📥 ${lang() ? 'استيراد ملف الإكسل' : 'Import Excel file'}</h3>
          <p class="muted">${lang() ? 'استيراد الملف الأصلي أو ملفات محدثة — مع كشف التكرارات ومعاينة قبل الحفظ. لا يتم حذف أي سجل تاريخي.' : 'Import the original or updated files — duplicates are detected, preview before saving. Historical records are never deleted.'}</p>
          <div class="btn-row">
            <button class="btn btn-primary" id="bk-import">📥 ${lang() ? 'استيراد وإضافة' : 'Import & merge'}</button>
            <button class="btn btn-warn" id="bk-import-replace">♻️ ${lang() ? 'استيراد مع الاستبدال' : 'Import & replace'}</button>
          </div>
          <div id="bk-lastimport" class="muted small"></div>
        </div>
        <div class="card">
          <h3>📤 ${lang() ? 'تصدير الإكسل' : 'Excel export'}</h3>
          <p class="muted">${lang() ? 'تصدير رصيد المخزن أو سجل الحركات كاملًا بصيغة إكسل.' : 'Export inventory balances or the full transaction log.'}</p>
          <div class="btn-row">
            <button class="btn btn-primary" id="bk-exp-inv">📊 ${lang() ? 'تصدير الأرصدة' : 'Export balances'}</button>
            <button class="btn btn-primary" id="bk-exp-tx">🧾 ${lang() ? 'تصدير الحركات' : 'Export transactions'}</button>
          </div>
        </div>
        <div class="card">
          <h3>💾 ${lang() ? 'نسخة احتياطية كاملة (JSON)' : 'Full JSON backup'}</h3>
          <p class="muted">${lang() ? `تحتوي على كل الأصناف والحركات والإعدادات (${fmtNum(App.state.products.length)} صنف — ${fmtNum(App.state.transactions.length)} حركة).` : `Contains all products, transactions and settings.`}</p>
          <div class="btn-row">
            <button class="btn btn-primary" id="bk-dl">💾 ${lang() ? 'تنزيل نسخة احتياطية' : 'Download backup'}</button>
            <button class="btn btn-warn" id="bk-restore">♻️ ${lang() ? 'استعادة من ملف' : 'Restore from file'}</button>
            <input type="file" id="bk-file" accept=".json" hidden>
          </div>
        </div>
        <div class="card">
          <h3>🗂 ${lang() ? 'سجل التدقيق' : 'Audit log'}</h3>
          <p class="muted">${lang() ? 'آخر العمليات المسجلة (إضافة/تعديل/حذف/استيراد).' : 'Latest recorded operations.'}</p>
          <div id="bk-audit" class="audit-list small"></div>
        </div>
      </div>`;

    host.querySelector('#bk-import').addEventListener('click', () => openImportDialog(false));
    host.querySelector('#bk-import-replace').addEventListener('click', () => openImportDialog(true));
    host.querySelector('#bk-exp-inv').addEventListener('click', () => {
      global.EXCEL.exportInventoryBuckets([...App.state.balancesW.values()], App.state.settings.weightFactor);
      toast(lang() ? 'تم التنزيل' : 'downloaded', 'ok');
    });
    host.querySelector('#bk-exp-tx').addEventListener('click', () => {
      global.EXCEL.exportTransactions(App.state.transactions);
      toast(lang() ? 'تم التنزيل' : 'downloaded', 'ok');
    });
    host.querySelector('#bk-dl').addEventListener('click', downloadBackup);
    host.querySelector('#bk-restore').addEventListener('click', () => host.querySelector('#bk-file').click());
    host.querySelector('#bk-file').addEventListener('change', (e) => { if (e.target.files[0]) restoreBackup(e.target.files[0]); });

    /* last import info */
    global.DB.getSetting('lastImport', null).then((li) => {
      const box = host.querySelector('#bk-lastimport');
      if (li) box.textContent = lang()
        ? `آخر استيراد: ${new Date(li.at).toLocaleString('ar-EG')} — جديد: ${li.newTx} — تكرار تم تخطيه: ${li.dupTx + li.inFileDup} — أصناف جديدة: ${li.newProd}`
        : `Last import: ${li.at} — new: ${li.newTx} — duplicates skipped: ${li.dupTx + li.inFileDup}`;
    });

    /* audit log */
    global.DB.getAudit(12).then((rows) => {
      const box = host.querySelector('#bk-audit');
      box.innerHTML = rows.length ? rows.map((r) => {
        const act = { add: '➕', edit: '✎', delete: '🗑', import: '📥', 'import-replace': '♻️', restore: '♻️', backup: '💾' }[r.action] || '•';
        const entity = { transaction: lang() ? 'حركة' : 'tx', movement: lang() ? 'حركة مجمعة' : 'movement', product: lang() ? 'صنف' : 'product', database: lang() ? 'قاعدة البيانات' : 'database' }[r.entity] || r.entity;
        return `<div class="audit-row">${act} ${esc(entity)} — ${esc(r.action)} — ${new Date(r.at).toLocaleString('ar-EG')} ${r.details ? `<span class="muted">${esc(r.details)}</span>` : ''}</div>`;
      }).join('') : `<div class="muted">${lang() ? 'لا توجد عمليات بعد' : 'no operations yet'}</div>`;
    });

    /* ---------- JSON backup / restore ---------- */
    async function downloadBackup() {
      const [products, transactions, settings, audit] = await Promise.all([
        global.DB.getAll('products'), global.DB.getAll('transactions'),
        global.DB.getAll('settings'), global.DB.getAudit(2000),
      ]);
      const payload = {
        app: 'inventory-pwa', schema: 1, exportedAt: new Date().toISOString(),
        products, transactions, settings, audit: audit.slice(0, 200),
      };
      const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      a.href = URL.createObjectURL(blob);
      a.download = `inventory_backup_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      await global.DB.logAudit({ entity: 'database', action: 'backup', entityId: null, before: null, after: null, details: `tx=${transactions.length}` });
      toast(lang() ? `تم تنزيل النسخة الاحتياطية (${fmtNum(transactions.length)} حركة)` : `backup downloaded (${transactions.length} transactions)`, 'ok');
    }

    async function restoreBackup(file) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.app !== 'inventory-pwa' || !Array.isArray(data.transactions)) {
          toast(lang() ? 'ملف النسخة الاحتياطية غير صالح' : 'invalid backup file', 'err');
          return;
        }
        const ok = await confirmDialog({
          title: lang() ? 'استعادة نسخة احتياطية' : 'Restore backup',
          message: lang()
            ? `سيتم استبدال جميع البيانات الحالية بمحتوى النسخة (${fmtNum(data.transactions.length)} حركة، ${fmtNum((data.products || []).length)} صنف). متابعة؟`
            : `Replace all current data with the backup (${data.transactions.length} transactions)? Continue?`,
          danger: true,
        });
        if (!ok) return;
        await global.DB.wipeAll();
        await global.DB.bulkPut('products', data.products || []);
        await global.DB.bulkPut('transactions', data.transactions || []);
        for (const s of data.settings || []) await global.DB.put('settings', s);
        await global.DB.logAudit({
          entity: 'database', action: 'restore', entityId: null, before: null, after: null,
          details: `tx=${(data.transactions || []).length}, prod=${(data.products || []).length}`,
        });
        toast(lang() ? 'تمت الاستعادة بنجاح' : 'restore complete', 'ok');
        await App.refresh();
      } catch (e) {
        console.error(e);
        toast(lang() ? `فشل الاستعادة: ${e.message}` : `Restore failed: ${e.message}`, 'err');
      }
    }
  }

  /* ================= Settings view ================= */
  function renderSettings(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('settings'))}</h2></div>
      <div class="grid-2">
        <div class="card">
          <h3>🏢 ${lang() ? 'بيانات الشركة (تظهر في التقارير)' : 'Company name (used in reports)'}</h3>
          <label class="field"><span>${lang() ? 'اسم الشركة' : 'Company name'}</span>
            <input id="set-company" type="text" value="${esc(App.state.settings.companyName)}" placeholder="${lang() ? 'مثال: مصنع الورق الحديث' : 'e.g. Modern Paper Factory'}"></label>
          <button class="btn btn-primary" id="set-save-co">${t('save')}</button>
        </div>
        <div class="card">
          <h3>🌐 ${lang() ? 'اللغة' : 'Language'}</h3>
          <label class="field"><span>${lang() ? 'لغة الواجهة' : 'UI language'}</span>
            <select id="set-lang">
              <option value="ar" ${UI.getLang() === 'ar' ? 'selected' : ''}>العربية (RTL)</option>
              <option value="en" ${UI.getLang() === 'en' ? 'selected' : ''}>English (LTR)</option>
            </select></label>
          <p class="muted small">${lang() ? 'الأرقام تُعرض بالأرقام الغربية لضمان دقة القيود.' : 'Numbers use western digits for accuracy.'}</p>
        </div>
        <div class="card">
          <h3>⚖️ ${lang() ? 'معامل الوزن' : 'Weight factor'}</h3>
          <p class="muted small">${lang() ? 'الوزن = المقاس × الرصيد × المعامل. القيمة الأصلية من ملف الإكسل هي 7.5 — لا تغيّرها إلا إذا تغيّرت طريقة الحساب.' : 'Weight = size × balance × factor. Original Excel value: 7.5.'}</p>
          <label class="field"><span>${lang() ? 'المعامل' : 'Factor'}</span>
            <input id="set-wf" type="number" step="0.1" min="0" value="${App.state.settings.weightFactor}"></label>
          <button class="btn btn-primary" id="set-save-wf">${t('save')}</button>
        </div>
        <div class="card">
          <h3>🔢 ${lang() ? 'ترقيم أذون الصرف' : 'Issue document numbering'}</h3>
          <p class="muted small">${lang()
            ? 'تسلسلان مستقلان تمامًا: الرقم المقترح لكل تصنيف = القيمة المحفوظة هنا (تُبدأ تلقائيًا من أكبر رقم تاريخي + 1). تغييرها لا يعدّل أي إذن محفوظ، والتكرار داخل نفس التصنيف يُرفض عند الحفظ.'
            : 'Two fully independent sequences: the suggested number per classification = the stored value (initialized from the largest historical number + 1). Changing it never modifies saved documents; duplicates within one classification are rejected on save.'}</p>
          <div class="form-grid">
            <label class="field"><span>${lang() ? 'الرقم القادم — ضريبي' : 'Next number — tax'}</span>
              <input id="set-seq-tax" type="number" min="1" step="1"></label>
            <label class="field"><span>${lang() ? 'الرقم القادم — غير ضريبي' : 'Next number — non-tax'}</span>
              <input id="set-seq-nontax" type="number" min="1" step="1"></label>
          </div>
          <button class="btn btn-primary" id="set-save-seq">${t('save')}</button>
        </div>
        <div class="card danger-zone">
          <h3>⚠️ ${lang() ? 'منطقة الخطر' : 'Danger zone'}</h3>
          <p class="muted small">${lang() ? 'حذف كل البيانات نهائيًا. لا يتم أبدًا حذف البيانات تلقائيًا — هذا الزر يدوي فقط ويتطلب كتابة كلمة التأكيد.' : 'Delete all data permanently. Requires typing a confirmation word.'}</p>
          <button class="btn btn-danger" id="set-wipe">🗑 ${lang() ? 'حذف كل البيانات' : 'Delete all data'}</button>
        </div>
      </div>`;

    /* document numbering sequences (independent tax / non-tax) */
    global.TX.nextDocNumbers().then((n) => {
      const taxIn = host.querySelector('#set-seq-tax');
      const nonIn = host.querySelector('#set-seq-nontax');
      if (taxIn) taxIn.value = n.tax;
      if (nonIn) nonIn.value = n.nontax;
    });
    host.querySelector('#set-save-seq').addEventListener('click', async () => {
      const taxIn = host.querySelector('#set-seq-tax');
      const nonIn = host.querySelector('#set-seq-nontax');
      const setSeq = async (key, input, cls) => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v < 1) return;
        const all = await global.DB.getAll('transactions');
        let max = 0;
        for (const r of all) {
          if ((Number(r.outQty) || 0) <= 0 || (r.settlement || '') !== cls) continue;
          const n2 = parseInt(String(r.permitNo || '').trim(), 10);
          if (Number.isFinite(n2) && n2 > max) max = n2;
        }
        if (v <= max) {
          const ok = await confirmDialog({
            title: lang() ? 'تأكيد الرقم' : 'Confirm number',
            message: lang()
              ? `توجد أذون في تصنيف «${cls === 'ض' ? 'ضريبي' : 'غير ضريبي'}» بأرقام تصل إلى ${max}. الرقم الذي اخترته قد يسبب تكرارًا — سيظل الحفظ يرفض الأرقام المكررة. متابعة؟`
              : `Documents in this classification already reach number ${max}. Saving will still reject duplicates. Continue?`,
            danger: true,
          });
          if (!ok) return;
        }
        await global.DB.setSetting(key, Math.round(v));
      };
      await setSeq('docSeqTax', taxIn, 'ض');
      await setSeq('docSeqNontax', nonIn, 'غ');
      const n = await global.TX.nextDocNumbers();
      taxIn.value = n.tax; nonIn.value = n.nontax;
      toast(lang() ? 'تم حفظ تسلسل الترقيم' : 'numbering saved', 'ok');
    });

    host.querySelector('#set-save-co').addEventListener('click', async () => {
      await global.DB.setSetting('companyName', host.querySelector('#set-company').value.trim());
      App.state.settings.companyName = host.querySelector('#set-company').value.trim();
      toast(lang() ? 'تم الحفظ' : 'saved', 'ok');
    });
    host.querySelector('#set-lang').addEventListener('change', async (e) => {
      const nl = e.target.value;
      UI.setLang(nl);
      await global.DB.setSetting('lang', nl);
      App.navigate(App.currentRoute());
    });
    host.querySelector('#set-save-wf').addEventListener('click', async () => {
      const v = Number(host.querySelector('#set-wf').value);
      if (!v || v <= 0) { toast(lang() ? 'قيمة غير صالحة' : 'invalid value', 'err'); return; }
      await global.DB.setSetting('weightFactor', v);
      App.state.settings.weightFactor = v;
      toast(lang() ? 'تم تحديث معامل الوزن' : 'saved', 'ok');
    });
    host.querySelector('#set-wipe').addEventListener('click', async () => {
      const word = lang() ? 'احذف' : 'DELETE';
      const node = el(`<div>
        <p class="confirm-msg">${lang()
          ? `اكتب "${word}" للتأكيد. سيتم حذف ${fmtNum(App.state.transactions.length)} حركة و ${fmtNum(App.state.products.length)} صنف نهائيًا. نزّل نسخة احتياطية أولًا!`
          : `Type "${word}" to confirm. ${App.state.transactions.length} transactions will be deleted permanently. Download a backup first!`}</p>
        <input id="wipe-word" type="text" placeholder="${word}">
        <div class="confirm-actions">
          <button class="btn btn-danger" id="wipe-yes" disabled>${t('yes')}</button>
          <button class="btn btn-ghost" id="wipe-no">${t('no')}</button>
        </div></div>`);
      openModal(node, { title: lang() ? '⚠️ حذف نهائي' : 'Permanent deletion' });
      const input = node.querySelector('#wipe-word');
      input.addEventListener('input', () => { node.querySelector('#wipe-yes').disabled = input.value.trim() !== word; });
      node.querySelector('#wipe-no').addEventListener('click', closeModal);
      node.querySelector('#wipe-yes').addEventListener('click', async () => {
        await global.DB.wipeAll();
        await global.DB.logAudit({ entity: 'database', action: 'delete', entityId: null, before: null, after: null, details: 'wipe all' });
        closeModal();
        toast(lang() ? 'تم حذف جميع البيانات' : 'all data deleted', 'ok');
        await App.refresh();
      });
    });
  }

  global.App.registerView('backup', renderBackup);
  global.App.registerView('settings', renderSettings);
})(window);
