/* =========================================================================
   ui.js — عناصر الواجهة المشتركة: ترجمة، تنبيهات، حوارات، تنسيق
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------------- i18n ---------------- */
  const I18N = {
    ar: {
      appName: 'نظام إدارة رصيد المخزن',
      dashboard: 'الرئيسية', inventory: 'رصيد المخزن', addtx: 'تعديل حركة',
      baker: 'حركة متابعة البكر', bakerAdd: 'إضافة إنتاج', bakerIssue: 'صرف للعملاء',
      issuedocs: 'أذون الصرف', issuedoc: 'عرض إذن صرف',
      additions: 'إنتاج وإضافات', withdrawals: 'الصرف والمبيعات', history: 'سجل الحركات',
      reports: 'التقارير والطباعة', products: 'إدارة الأصناف', backup: 'النسخ الاحتياطي',
      settings: 'الإعدادات',
      // issue documents
      rollWeight: 'وزن الرولة (كجم)', classification: 'التصنيف',
      tax: 'ضريبي', nontax: 'غير ضريبي', docNo: 'رقم الإذن',
      addGroup: 'إضافة مجموعة', addSizeRow: 'إضافة مقاس',
      totalRolls: 'إجمالي الرولات', viewDoc: 'عرض الإذن', printDoc: 'طباعة الإذن',
      deliverer: 'المُسلِّم (أمين المخزن)', receiver: 'المستلم (العميل)',
      newest: 'الأحدث أولًا', oldest: 'الأقدم أولًا',
      productionNote: 'تسجيل إنتاج جديد بمقاسات متعددة تحت نفس الجرام والوزن',
      issueNote: 'إصدار إذن صرف لعميل بترقيم تلقائي مستقل (ضريبي / غير ضريبي)',
      lowStock: 'أصناف منتهية أو سالبة', byProduct: 'الرصيد حسب الصنف',
      // dashboard
      totalProducts: 'إجمالي الأصناف', totalBalance: 'إجمالي رصيد المخزن',
      totalAdd: 'إجمالي الإضافات', totalOut: 'إجمالي المنصرف',
      countAdd: 'عدد حركات الإنتاج', countOut: 'عدد أذون الصرف',
      recentTx: 'أحدث الحركات', monthlyMovement: 'الإضافات والصرف الشهري',
      topProducts: 'أعلى 10 أصناف بالرصيد', viewAll: 'عرض الكل',
      // common
      quality: 'اسم الصنف', gsm: 'الجرام', size: 'المقاس', balance: 'رصيد المخزن',
      weight: 'الوزن', date: 'التاريخ', customer: 'العميل / الجهة', permit: 'رقم إذن الصرف',
      addQty: 'الكمية المضافة', outQty: 'الكمية المنصرفة', settlement: 'تصفيه',
      notes: 'ملاحظات', net: 'الصافي', actions: 'إجراءات', search: 'بحث',
      save: 'حفظ', cancel: 'إلغاء', edit: 'تعديل', del: 'حذف', details: 'تفاصيل',
      print: 'طباعة', exportExcel: 'تصدير Excel', add: 'إضافة', out: 'صرف',
      all: 'الكل', from: 'من تاريخ', to: 'إلى تاريخ', type: 'نوع الحركة',
      close: 'إغلاق', confirm: 'تأكيد', yes: 'نعم', no: 'لا', filter: 'تصفية',
      reset: 'مسح الفلاتر', total: 'الإجمالي', page: 'صفحة',
      // misc
      rolls: 'لفة', kg: 'كجم', txCount: 'عدد الحركات',
      install: 'تثبيت التطبيق', online: 'متصل', offline: 'غير متصل — يعمل بدون إنترنت',
      emptyState: 'لا توجد بيانات بعد — ابدأ باستيراد ملف الإكسل',
      importExcel: 'استيراد ملف الإكسل',
    },
    en: {
      appName: 'Inventory Balance System',
      dashboard: 'Dashboard', inventory: 'Inventory', addtx: 'Edit movement',
      baker: 'Blank-roll movements', bakerAdd: 'Production entry', bakerIssue: 'Customer issue',
      issuedocs: 'Issue documents', issuedoc: 'Issue document view',
      additions: 'Additions', withdrawals: 'Withdrawals', history: 'History',
      reports: 'Reports & Printing', products: 'Products', backup: 'Backup & Restore',
      settings: 'Settings',
      rollWeight: 'Roll weight (kg)', classification: 'Classification',
      tax: 'Tax', nontax: 'Non-tax', docNo: 'Document No.',
      addGroup: 'Add group', addSizeRow: 'Add size',
      totalRolls: 'Total rolls', viewDoc: 'View document', printDoc: 'Print document',
      deliverer: 'Delivered by (storekeeper)', receiver: 'Received by (customer)',
      newest: 'Newest first', oldest: 'Oldest first',
      productionNote: 'Record new production with multiple sizes under one GSM and weight',
      issueNote: 'Issue to a customer with independent auto numbering (tax / non-tax)',
      lowStock: 'Zero or negative items', byProduct: 'Stock by product',
      totalProducts: 'Total products', totalBalance: 'Total stock balance',
      totalAdd: 'Total additions', totalOut: 'Total withdrawals',
      countAdd: 'Production movements', countOut: 'Issue documents',
      recentTx: 'Recent transactions', monthlyMovement: 'Monthly additions vs withdrawals',
      topProducts: 'Top 10 products by balance', viewAll: 'View all',
      quality: 'Product', gsm: 'GSM', size: 'Size', balance: 'Balance',
      weight: 'Weight', date: 'Date', customer: 'Customer / Party', permit: 'Permit No.',
      addQty: 'Added qty', outQty: 'Withdrawn qty', settlement: 'Settlement',
      notes: 'Notes', net: 'Net', actions: 'Actions', search: 'Search',
      save: 'Save', cancel: 'Cancel', edit: 'Edit', del: 'Delete', details: 'Details',
      print: 'Print', exportExcel: 'Export Excel', add: 'Add', out: 'Issue',
      all: 'All', from: 'From date', to: 'To date', type: 'Type',
      close: 'Close', confirm: 'Confirm', yes: 'Yes', no: 'No', filter: 'Filter',
      reset: 'Clear filters', total: 'Total', page: 'Page',
      rolls: 'rolls', kg: 'kg', txCount: 'Transactions',
      install: 'Install app', online: 'Online', offline: 'Offline — working locally',
      emptyState: 'No data yet — start by importing the Excel file',
      importExcel: 'Import Excel file',
    },
  };

  let lang = 'ar';

  function setLang(l) {
    lang = l === 'en' ? 'en' : 'ar';
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((elm) => {
      const k = elm.getAttribute('data-i18n');
      if (I18N[lang][k] !== undefined) elm.textContent = I18N[lang][k];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((elm) => {
      const k = elm.getAttribute('data-i18n-placeholder');
      if (I18N[lang][k] !== undefined) elm.setAttribute('placeholder', I18N[lang][k]);
    });
    try { localStorage.setItem('inv_lang', lang); } catch (e) { /* private mode */ }
    global.EventBus && global.EventBus.emit('lang', lang);
  }
  function getLang() { return lang; }
  function t(key) { return (I18N[lang] && I18N[lang][key]) || I18N.ar[key] || key; }

  /* ---------------- formatting ---------------- */
  function fmtNum(n, decimals) {
    if (n === null || n === undefined || isNaN(n)) return '';
    const d = decimals === undefined ? (Number.isInteger(n) ? 0 : 3) : decimals;
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso);
    return `${m[3]}/${m[2]}/${m[1]}`;
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /* ---------------- tiny DOM helper ---------------- */
  function el(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html).trim();
    return tpl.content.firstElementChild;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- toasts ---------------- */
  let toastHost = null;
  function toast(msg, type, duration) {
    if (!toastHost) {
      toastHost = el('<div id="toast-host" aria-live="polite"></div>');
      document.body.appendChild(toastHost);
    }
    const node = el(`<div class="toast toast-${esc(type || 'info')}">${esc(msg)}</div>`);
    toastHost.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    setTimeout(() => { node.classList.remove('show'); setTimeout(() => node.remove(), 300); }, duration || 4200);
  }

  /* ---------------- inline SVG icons (small, professional) ----------------
     24×24 grid, stroke-based, inherit currentColor — used on stat cards
     and section headers instead of emoji for a business-like look. */
  const svg = (paths, sw) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="${sw || 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    products: svg('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
    balance: svg('<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 6a3.5 3.5 0 0 0 6 0L5 7z"/><path d="M19 7l-3 6a3.5 3.5 0 0 0 6 0l-3-6z"/>'),
    add: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
    out: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
    countAdd: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M7 13h10M7 17h7"/>'),
    countOut: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
    chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    print: svg('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  };

  /* ---------------- modal + confirm ---------------- */
  function openModal(contentNode, opts) {
    closeModal();
    const overlay = el(`<div class="modal-overlay" role="dialog" aria-modal="true">
       <div class="modal ${opts && opts.wide ? 'modal-wide' : ''}"></div></div>`);
    const box = overlay.querySelector('.modal');
    if (opts && opts.title) {
      box.appendChild(el(`<div class="modal-head"><h3>${esc(opts.title)}</h3>
        <button class="icon-btn modal-x" aria-label="close">✕</button></div>`));
      box.querySelector('.modal-x').addEventListener('click', closeModal);
    }
    box.appendChild(contentNode);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');
    return overlay;
  }
  function closeModal() {
    document.querySelectorAll('.modal-overlay').forEach((n) => n.remove());
    document.body.classList.remove('modal-open');
  }

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const node = el(`<div class="confirm-body">
        <p class="confirm-msg">${esc(opts.message || '')}</p>
        ${opts.extra ? `<div class="confirm-extra">${opts.extra}</div>` : ''}
        <div class="confirm-actions">
          <button class="btn btn-${opts.danger ? 'danger' : 'primary'} confirm-yes">${esc(opts.yesLabel || t('confirm'))}</button>
          <button class="btn btn-ghost confirm-no">${esc(opts.noLabel || t('cancel'))}</button>
        </div></div>`);
      openModal(node, { title: opts.title || t('confirm') });
      node.querySelector('.confirm-yes').addEventListener('click', () => { closeModal(); resolve(true); });
      node.querySelector('.confirm-no').addEventListener('click', () => { closeModal(); resolve(false); });
      node.querySelector('.confirm-no').focus();
    });
  }

  /* simple pub/sub for cross-module updates */
  const listeners = {};
  const EventBus = {
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    emit(evt, data) { (listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
  };

  global.UI = { I18N, setLang, getLang, t, fmtNum, fmtDate, todayISO, el, esc, toast, openModal, closeModal, confirmDialog, EventBus, ICON };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.UI;
})(typeof window !== 'undefined' ? window : globalThis);
