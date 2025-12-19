// ==UserScript==
// @name         Amazon Vine FR — Scann Éval — "Stable"
// @namespace    https://github.com/USER/REPO
// @version      2.0.5
// @description  Scann Éval (qualité) + delta + scan multi-pages (2–4s/page) + 2e ligne "Depuis éval" (date début via /vine/account) + UI table colonnes alignées + Menu affichage (Tout/Période) + Reset. Capture "Testeur Vine depuis". FIX: overlay account only when storage updated + overlay duration 2s. "Vine depuis" moved to Période column title (row global). Header Infos: Dernier Scann moved to header (right).
// @author       Cris0338
// @match        https://www.amazon.fr/vine/vine-reviews*
// @match        https://www.amazon.fr/vine/account*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      www.amazon.fr
// @run-at       document-idle
//
// @updateURL    https://raw.githubusercontent.com/USER/REPO/main/amazon-vine-eval-scan.user.js
// @downloadURL  https://raw.githubusercontent.com/USER/REPO/main/amazon-vine-eval-scan.user.js
// ==/UserScript==


(() => {
  'use strict';

  const HOST = location.hostname;
  const PATH = location.pathname;

  const LS_KEY_STATE  = `vine_eval_counts_${HOST}_completed`;
  const LS_KEY_PERIOD = `vine_eval_period_${HOST}`; // { startDate:"DD/MM/YYYY", startTs:number, savedAt:string }
  const LS_KEY_VIEW   = `vine_eval_view_${HOST}`;   // "all" | "period"
  const LS_KEY_SINCE  = `vine_eval_member_since_${HOST}`; // { sinceDate:"DD/MM/YYYY", sinceTs:number, savedAt:string }

  const NP_IF_EN_ATTENTE_OLDER_THAN_DAYS = 180;
  const ORDER = ['en attente', 'excellent', 'bien', 'juste', 'pauvre', 'n.p.'];

  const normalize = (s) => (s ?? '').toString().trim().replace(/\s+/g, ' ').toLowerCase();

  const MAP_TO_TARGET = {
    'n.p.': 'n.p.',
    'np': 'n.p.',
    'non disponible': 'n.p.',
    'non-disponible': 'n.p.',
    'n/a': 'n.p.',
    'na': 'n.p.',
    '—': 'n.p.',
    '-': 'n.p.',
    '': 'n.p.',

    'en attente': 'en attente',
    'excellent': 'excellent',
    'exellent': 'excellent',
    'bon': 'bien',
    'bien': 'bien',
    'passable': 'juste',
    'juste': 'juste',
    'mauvais': 'pauvre',
    'mauvaise': 'pauvre',
    'pauvre': 'pauvre'
  };

  const emptyCounts = () => ORDER.reduce((a, k) => (a[k] = 0, a), {});

  // ---------- View (UI only) ----------
  function loadViewMode() {
    const v = localStorage.getItem(LS_KEY_VIEW);
    return (v === 'period' || v === 'all') ? v : 'all';
  }
  function saveViewMode(v) {
    localStorage.setItem(LS_KEY_VIEW, (v === 'period') ? 'period' : 'all');
  }
  function applyViewMode() {
    const mode = loadViewMode();
    const rowGlobal = document.getElementById('vineEvalRowGlobal');
    if (!rowGlobal) return;
    rowGlobal.style.display = (mode === 'period') ? 'none' : '';
  }

  // ---------- Date parsing (DD/MM/YYYY + FR months) ----------
  function parseDDMMYYYY(s) {
    const txt = (s || '').toString().replace(/\u00a0/g, ' ').trim();

    // A) DD/MM/YYYY
    let m = txt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yyyy >= 2000 && yyyy <= 2100) {
        const dt = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
        const ts = dt.getTime();
        if (Number.isFinite(ts)) {
          return { ts, str: `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}` };
        }
      }
      return null;
    }

    // B) “05 sept. 2025” (mesi FR)
    const months = {
      'janv': 1, 'janvier': 1,
      'févr': 2, 'fevr': 2, 'février': 2, 'fevrier': 2,
      'mars': 3,
      'avr': 4, 'avril': 4,
      'mai': 5,
      'juin': 6,
      'juil': 7, 'juillet': 7,
      'août': 8, 'aout': 8,
      'sept': 9, 'septembre': 9,
      'oct': 10, 'octobre': 10,
      'nov': 11, 'novembre': 11,
      'déc': 12, 'dec': 12, 'décembre': 12, 'decembre': 12
    };

    m = txt.match(/(\d{1,2})\s+([a-zA-Zéèêëàâäîïôöûüç\.]+)\s+(\d{4})/);
    if (!m) return null;

    const dd = Number(m[1]);
    const monRaw = (m[2] || '').toLowerCase().replace(/\./g, '').trim();
    const yyyy = Number(m[3]);

    const mm = months[monRaw];
    if (!mm) return null;
    if (!(dd >= 1 && dd <= 31 && yyyy >= 2000 && yyyy <= 2100)) return null;

    const dt = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
    const ts = dt.getTime();
    if (!Number.isFinite(ts)) return null;

    return { ts, str: `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}` };
  }

  // ---------- Period helpers ----------
  function loadPeriod() {
    try {
      const raw = localStorage.getItem(LS_KEY_PERIOD);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.startTs !== 'number' || !Number.isFinite(obj.startTs)) return null;
      if (typeof obj.startDate !== 'string' || !obj.startDate.trim()) return null;
      return obj;
    } catch { return null; }
  }

  function savePeriod(startDate, startTs) {
    const payload = { startDate, startTs, savedAt: new Date().toISOString() };
    localStorage.setItem(LS_KEY_PERIOD, JSON.stringify(payload));
    return payload;
  }

  // ---------- Member since helpers ----------
  function loadMemberSince() {
    try {
      const raw = localStorage.getItem(LS_KEY_SINCE);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.sinceTs !== 'number' || !Number.isFinite(obj.sinceTs)) return null;
      if (typeof obj.sinceDate !== 'string' || !obj.sinceDate.trim()) return null;
      return obj;
    } catch { return null; }
  }

  function saveMemberSince(sinceDate, sinceTs) {
    const payload = { sinceDate, sinceTs, savedAt: new Date().toISOString() };
    localStorage.setItem(LS_KEY_SINCE, JSON.stringify(payload));
    return payload;
  }

  // ---------- Overlays ----------
  function showAccountOverlay({ startDateStr, sinceDateStr } = {}) {
    if (document.getElementById('vinePeriodOverlay')) return;

    const lines = [];
    if (startDateStr) lines.push(`<div class="vine-period-sub"><b>Période :</b> ${startDateStr}</div>`);
    if (sinceDateStr) lines.push(`<div class="vine-period-sub"><b>Testeur Vine depuis :</b> ${sinceDateStr}</div>`);

    const overlay = document.createElement('div');
    overlay.id = 'vinePeriodOverlay';
    overlay.innerHTML = `
      <div class="vine-period-card" role="dialog" aria-modal="true">
        <div class="vine-period-title">Infos mémorisées</div>
        ${startDateStr ? `<div class="vine-period-date">${startDateStr}</div>` : ''}
        ${lines.join('')}
      </div>`;
    document.documentElement.appendChild(overlay);
    setTimeout(() => overlay.remove(), 2000); // 2s
  }

  // ---------- Account capture ----------
  function tryCapturePeriodOnAccountPage() {
    const p = document.getElementById('vvp-evaluation-period-tooltip-trigger');
    if (!p) return false;

    const txt = (p.textContent || '').replace(/\u00a0/g, ' ').trim();

    const firstDate =
      (txt.match(/(\d{1,2}\s+[a-zA-Zéèêëàâäîïôöûüç\.]+\s+\d{4})\s*-/) || [])[1] ||
      (txt.match(/(\d{2}\/\d{2}\/\d{4})\s*-/) || [])[1] ||
      (txt.match(/(\d{1,2}\s+[a-zA-Zéèêëàâäîïôöûüç\.]+\s+\d{4})/) || [])[1] ||
      (txt.match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1];

    if (!firstDate) return false;

    const parsed = parseDDMMYYYY(firstDate);
    if (!parsed) return false;

    const existing = loadPeriod();
    if (!existing || existing.startTs !== parsed.ts) {
      savePeriod(parsed.str, parsed.ts);
      return true; // only when changed
    }
    return false;
  }

  function tryCaptureMemberSinceOnAccountPage() {
    const rootTxt = (document.body?.textContent || '').replace(/\u00a0/g, ' ');

    const m =
      rootTxt.match(/Testeur\s+Vine\s+depuis\s*:?\s*(\d{1,2}\s+[a-zA-Zéèêëàâäîïôöûüç\.]+\s+\d{4})/i) ||
      rootTxt.match(/Testeur\s+Vine\s+depuis\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);

    const dateStr = m?.[1];
    if (!dateStr) return false;

    const parsed = parseDDMMYYYY(dateStr);
    if (!parsed) return false;

    const existing = loadMemberSince();
    if (!existing || existing.sinceTs !== parsed.ts) {
      saveMemberSince(parsed.str, parsed.ts);
      return true; // only when changed
    }
    return false;
  }

  function captureAccountInfos() {
    const gotPeriod = tryCapturePeriodOnAccountPage();
    const gotSince  = tryCaptureMemberSinceOnAccountPage();

    const period = loadPeriod();
    const since  = loadMemberSince();

    if (gotPeriod || gotSince) {
      showAccountOverlay({
        startDateStr: period?.startDate || null,
        sinceDateStr: since?.sinceDate || null
      });
    }

    return gotPeriod || gotSince;
  }

  // ---------- Account page ----------
  if (PATH.startsWith('/vine/account')) {
    GM_addStyle(`
      #vinePeriodOverlay{position:fixed; inset:0; z-index:999999; background:rgba(0,0,0,.55);
        display:flex; align-items:center; justify-content:center;}
      #vinePeriodOverlay .vine-period-card{width:min(560px, calc(100% - 24px)); border-radius:14px;
        padding:18px 18px 16px; background:#111; border:1px solid rgba(255,255,255,.14);
        box-shadow:0 12px 40px rgba(0,0,0,.45); text-align:center;}
      #vinePeriodOverlay .vine-period-title{font-size:14px; opacity:.9; margin-bottom:10px;}
      #vinePeriodOverlay .vine-period-date{font-size:26px; font-weight:800; color:#1fbf1f; letter-spacing:.4px;
        margin:2px 0 10px; font-variant-numeric:tabular-nums;}
      #vinePeriodOverlay .vine-period-sub{font-size:12px; opacity:.85; margin-top:6px;}
      #vinePeriodOverlay .vine-period-sub b{opacity:1;}
    `);

    if (!captureAccountInfos()) {
      const mo = new MutationObserver(() => { if (captureAccountInfos()) mo.disconnect(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 20000);
    }
    return;
  }

  // ---------- Reviews page guard ----------
  const u = new URL(location.href);
  if (!PATH.startsWith('/vine/vine-reviews')) return;
  if (u.searchParams.get('review-type') !== 'completed') return;

  // ---------- State ----------
  const emptyState = () => ({
    scannedItems: 0,
    pagesScanned: 0,
    counts: emptyCounts(),
    lastScanAt: null,

    periodScannedItems: 0,
    periodCounts: emptyCounts(),

    prevCounts: null,
    prevScannedItems: null,
    prevPagesScanned: null,
    prevScanAt: null,

    prevPeriodCounts: null,
    prevPeriodScannedItems: null
  });

  const loadState = () => {
    try {
      const raw = localStorage.getItem(LS_KEY_STATE);
      if (!raw) return emptyState();
      const st = JSON.parse(raw);
      if (!st || typeof st !== 'object') return emptyState();

      st.counts ||= emptyCounts();
      st.periodCounts ||= emptyCounts();

      for (const k of ORDER) {
        if (typeof st.counts[k] !== 'number') st.counts[k] = 0;
        if (typeof st.periodCounts[k] !== 'number') st.periodCounts[k] = 0;
      }

      if (st.prevCounts && typeof st.prevCounts === 'object') {
        for (const k of ORDER) if (typeof st.prevCounts[k] !== 'number') st.prevCounts[k] = 0;
      } else st.prevCounts = null;

      if (st.prevPeriodCounts && typeof st.prevPeriodCounts === 'object') {
        for (const k of ORDER) if (typeof st.prevPeriodCounts[k] !== 'number') st.prevPeriodCounts[k] = 0;
      } else st.prevPeriodCounts = null;

      if (typeof st.scannedItems !== 'number') st.scannedItems = 0;
      if (typeof st.pagesScanned !== 'number') st.pagesScanned = 0;
      if (typeof st.lastScanAt !== 'string' && st.lastScanAt !== null) st.lastScanAt = null;
      if (typeof st.periodScannedItems !== 'number') st.periodScannedItems = 0;

      if (typeof st.prevScannedItems !== 'number' && st.prevScannedItems !== null) st.prevScannedItems = null;
      if (typeof st.prevPagesScanned !== 'number' && st.prevPagesScanned !== null) st.prevPagesScanned = null;
      if (typeof st.prevScanAt !== 'string' && st.prevScanAt !== null) st.prevScanAt = null;
      if (typeof st.prevPeriodScannedItems !== 'number' && st.prevPeriodScannedItems !== null) st.prevPeriodScannedItems = null;

      return st;
    } catch { return emptyState(); }
  };

  const saveState = (st) => localStorage.setItem(LS_KEY_STATE, JSON.stringify(st));

  const formatFR = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('fr-FR'); } catch { return iso; }
  };

  // ---------- pacing ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

  const PACE_MIN_MS = 2000;
  const PACE_MAX_MS = 4000;
  const EXTRA_PAUSE_EVERY_MIN = 8;
  const EXTRA_PAUSE_EVERY_MAX = 12;
  const EXTRA_PAUSE_MS_MIN = 1200;
  const EXTRA_PAUSE_MS_MAX = 2200;

  async function paceBetweenPages(pageIndex) {
    await sleep(randInt(PACE_MIN_MS, PACE_MAX_MS));
    if (pageIndex > 1) {
      const every = randInt(EXTRA_PAUSE_EVERY_MIN, EXTRA_PAUSE_EVERY_MAX);
      if (pageIndex % every === 0) await sleep(randInt(EXTRA_PAUSE_MS_MIN, EXTRA_PAUSE_MS_MAX));
    }
  }

  // ---------- UI Styles ----------
  GM_addStyle(`
    #vvp-review-button-container{
      display:flex !important;
      align-items:center !important;
      gap:6px !important;
      flex-wrap:wrap !important;
      white-space:nowrap !important;
      position: relative !important;
    }

    #vine-eval-scan-btn.vine-eval-scan .a-button-inner{transition: box-shadow .2s ease, border-color .2s ease;}
    #vine-eval-scan-btn.vine-eval-scan:hover .a-button-inner{
      border-color:#007185 !important; box-shadow:0 0 0 2px rgba(0,113,133,.35) inset !important;
    }
    #vine-eval-scan-btn.vine-eval-scan.vine-clicked .a-button-inner{
      border-color:#007185 !important; box-shadow:0 0 0 2px rgba(0,113,133,.6) inset !important;
    }

    #vine-eval-menu-btn.vine-eval-menu .a-button-inner{transition: box-shadow .2s ease, border-color .2s ease;}
    #vine-eval-menu-btn.vine-eval-menu:hover .a-button-inner{
      border-color:#007185 !important; box-shadow:0 0 0 2px rgba(0,113,133,.25) inset !important;
    }

    /* Menu popover — white box, dark frame */
    #vineEvalMenu{
      position:absolute;
      z-index:999999;
      top: calc(100% + 8px);
      right: 0;
      min-width: 280px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid rgba(0,0,0,.55);
      background: #ffffff;
      box-shadow: 0 14px 40px rgba(0,0,0,.45);
      padding: 10px;
    }

    #vineEvalMenu .vineMenuGroup{
      padding: 10px;
      border-radius: 10px;
      background: rgba(0,0,0,.04);
    }

    #vineEvalMenu .vineMenuTitle{
      font-size: 12px;
      font-weight: 800;
      color: rgba(0,0,0,.85);
      margin: 2px 0 8px;
    }

    #vineEvalMenu label{
      display:flex;
      align-items:center;
      gap:8px;
      font-size:13px;
      color: rgba(0,0,0,.9);
      cursor:pointer;
      user-select:none;
    }

    #vineEvalMenu label + label{ margin-top: 8px; }

    #vineEvalMenu input[type="radio"]{
      transform: translateY(-.5px);
      accent-color: #007185;
    }

    #vineEvalMenu .vineMenuDivider{
      height:1px;
      background: rgba(0,0,0,.12);
      margin: 10px 2px;
      border-radius: 999px;
    }

    #vineEvalMenu .vineMenuBtn{
      display:flex;
      align-items:center;
      justify-content:center;
      width:100%;
      padding:10px 10px;
      border-radius:10px;
      border:1px solid rgba(0,0,0,.12);
      background:#fff;
      color:#111;
      font-size:13px;
      font-weight:800;
      cursor:pointer;
    }
    #vineEvalMenu .vineMenuBtn:hover{
      background: rgba(0,113,133,.06);
      border-color: rgba(0,113,133,.35);
    }
    #vineEvalMenu .vineMenuBtn.vineDanger{
      border-color: rgba(180,0,0,.25);
      color: #8a0000;
    }
    #vineEvalMenu .vineMenuBtn.vineDanger:hover{
      background: rgba(180,0,0,.06);
      border-color: rgba(180,0,0,.35);
    }

    /* Wrapper OUTSIDE flex row */
    #vineEvalWrapper{
      width: 100% !important;
      margin-top: 10px;
    }

    #vineEvalTableWrap{
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid rgba(0,113,133,.35);
      background: rgba(255,255,255,0.02);
    }

    #vineEvalTableScroll{
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
    }

    #vineEvalTable{
      width: 100%;
      min-width: 980px;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
    }

    #vineEvalTable thead th{
      background: #007185;
      color: #fff;
      text-align: center;
      padding: 10px 10px;
      font-weight: 800;
      white-space: nowrap;
    }
    #vineEvalTable thead th:first-child,
    #vineEvalTable thead th:last-child{
      text-align: left;
      padding-left: 12px;
      padding-right: 12px;
    }

    /* ✅ Header last column: Infos left / Dernier Scann right */
    .vineEvalHeadFlex{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      width:100%;
    }
    .vineEvalHeadFlex .vineHeadRight{
      white-space:nowrap;
      text-align:right;
      font-weight:700;
      opacity:.95;
    }

    #vineEvalTable tbody td{
      padding: 10px 10px;
      border-top: 1px solid rgba(255,255,255,0.08);
      vertical-align: middle;
      text-align: center;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    #vineEvalTable tbody td:first-child,
    #vineEvalTable tbody td:last-child{
      text-align: left;
      padding-left: 12px;
      padding-right: 12px;
      white-space: normal;
    }

    #vineEvalTable tbody tr:nth-child(odd){ background: rgba(255,255,255,0.03); }
    #vineEvalTable tbody tr:nth-child(even){ background: rgba(255,255,255,0.015); }
    #vineEvalTable tbody tr:hover{ background: rgba(0,113,133,.12); }

    .vineEvalRowTitle{ font-weight: 900; }
    .vineEvalMuted{ opacity:.7; }

    .vineEvalDelta{
      display:inline-block;
      margin-left:6px;
      font-weight: 900;
      color:#10c010;
    }

    .vineEvalMetaLine{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      align-items:center;
      font-size: 12px;
      opacity: .9;
    }

    .vineEvalStatus{
      font-size: 12px;
      font-weight: 700;
      opacity: .95;
    }
  `);

  // ---------- UI Mount ----------
  function getInjectNode() { return document.querySelector('#vvp-review-button-container'); }
  function getButtonsContainer() { return document.querySelector('#vvp-review-button-container'); }

  function flashClicked(btn, ms = 3000) {
    btn.classList.add('vine-clicked');
    setTimeout(() => btn.classList.remove('vine-clicked'), ms);
  }

  function setBtnDisabled(disabled) {
    const wrap = document.getElementById('vine-eval-scan-btn');
    if (wrap) {
      wrap.style.pointerEvents = disabled ? 'none' : '';
      wrap.style.opacity = disabled ? '0.65' : '';
    }
    const menu = document.getElementById('vine-eval-menu-btn');
    if (menu) {
      menu.style.pointerEvents = disabled ? 'none' : '';
      menu.style.opacity = disabled ? '0.65' : '';
    }
  }

  function ensureWrapperPlacement() {
    const wrapper = document.getElementById('vineEvalWrapper');
    if (!wrapper) return;

    const buttons = getButtonsContainer();
    if (!buttons) return;

    const desiredParent = buttons.parentElement;
    if (!desiredParent) return;

    const isSibling = (wrapper.parentElement === desiredParent) && (wrapper.previousElementSibling === buttons);
    if (isSibling) return;

    buttons.insertAdjacentElement('afterend', wrapper);
  }

  // ---------- Reset ----------
  function resetAll() {
    const ok = window.confirm('Reset Vine scan ?\n\nCela efface :\n- le comptage\n- la période mémorisée\n- l’affichage (Tout/Période)\n- "Testeur Vine depuis"\n\nContinuer ?');
    if (!ok) return;

    localStorage.removeItem(LS_KEY_STATE);
    localStorage.removeItem(LS_KEY_PERIOD);
    localStorage.removeItem(LS_KEY_VIEW);
    localStorage.removeItem(LS_KEY_SINCE);

    closeMenu();
    render(loadState());
    applyViewMode();

    const status = document.getElementById('vineEvalStatus');
    if (status) status.textContent = 'Reset OK.';
    setTimeout(() => { if (status && !status.dataset.running) status.textContent = ''; }, 2000);
  }

  // ---------- Menu open/close ----------
  function closeMenu() {
    const m = document.getElementById('vineEvalMenu');
    if (m) m.remove();
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function onDocClick(e) {
    const m = document.getElementById('vineEvalMenu');
    const b = document.getElementById('vine-eval-menu-btn');
    if (!m) return;
    if (m.contains(e.target) || (b && b.contains(e.target))) return;
    closeMenu();
  }
  function onDocKey(e) { if (e.key === 'Escape') closeMenu(); }

  function openMenu() {
    closeMenu();

    const btnRow = getButtonsContainer();
    if (!btnRow) return;

    const menu = document.createElement('div');
    menu.id = 'vineEvalMenu';

    const mode = loadViewMode();
    menu.innerHTML = `
      <div class="vineMenuGroup">
        <div class="vineMenuTitle">Affichage</div>
        <label><input type="radio" name="vineViewMode" value="all" ${mode === 'all' ? 'checked' : ''}> Tout</label>
        <label><input type="radio" name="vineViewMode" value="period" ${mode === 'period' ? 'checked' : ''}> Période</label>

        <div class="vineMenuDivider"></div>

        <button class="vineMenuBtn vineDanger" id="vineMenuResetBtn" type="button">Reset</button>
      </div>
    `;

    btnRow.appendChild(menu);

    menu.querySelectorAll('input[name="vineViewMode"]').forEach(inp => {
      inp.addEventListener('change', () => {
        saveViewMode(inp.value);
        applyViewMode();
      });
    });

    const resetBtn = menu.querySelector('#vineMenuResetBtn');
    if (resetBtn) resetBtn.addEventListener('click', resetAll);

    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onDocKey, true);
  }

  function mountUIOnce() {
    const btnRow = getInjectNode();
    if (!btnRow) return false;

    // Scan button
    if (!document.getElementById('vine-eval-scan-btn')) {
      const scanBtn = document.createElement('span');
      scanBtn.id = 'vine-eval-scan-btn';
      scanBtn.className = 'a-button a-button-normal a-button-toggle vine-eval-scan';
      scanBtn.innerHTML = `
        <span class="a-button-inner">
          <a href="javascript:void(0)" role="button" class="a-button-text" tabindex="0">Scann Éval</a>
        </span>
      `;
      btnRow.appendChild(scanBtn);

      const a = scanBtn.querySelector('a.a-button-text');
      const onClick = (e) => {
        e.preventDefault();
        flashClicked(scanBtn, 3000);
        scanAllPages();
      };
      a.addEventListener('click', onClick);
      a.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick(e);
      });
    }

    // Menu caret button
    if (!document.getElementById('vine-eval-menu-btn')) {
      const menuBtn = document.createElement('span');
      menuBtn.id = 'vine-eval-menu-btn';
      menuBtn.className = 'a-button a-button-normal a-button-toggle vine-eval-menu';
      menuBtn.innerHTML = `
        <span class="a-button-inner">
          <a href="javascript:void(0)" role="button" class="a-button-text" tabindex="0">▼</a>
        </span>
      `;
      btnRow.appendChild(menuBtn);

      const a = menuBtn.querySelector('a.a-button-text');
      const onClick = (e) => {
        e.preventDefault();
        const existing = document.getElementById('vineEvalMenu');
        if (existing) closeMenu();
        else openMenu();
      };
      a.addEventListener('click', onClick);
      a.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick(e);
      });
    }

    // Wrapper/table
    if (!document.getElementById('vineEvalWrapper')) {
      const wrapper = document.createElement('div');
      wrapper.id = 'vineEvalWrapper';

      wrapper.innerHTML = `
        <div id="vineEvalTableWrap">
          <div id="vineEvalTableScroll">
            <table id="vineEvalTable">
              <thead>
                <tr>
                  <th style="width:260px;">Période</th>
                  <th>En attente</th>
                  <th>Excellent</th>
                  <th>Bien</th>
                  <th>Juste</th>
                  <th>Pauvre</th>
                  <th title="N.P. : Non parvenu / Non disponible.
Inclut les évaluations anciennes jamais recalculées
ou les statuts « En attente » trop anciens.">N.P.</th>

                  <!-- ✅ Infos left + Dernier Scann right in same header cell -->
                  <th style="width:360px;">
                    <div class="vineEvalHeadFlex">
                      <span>Infos</span>
                      <span class="vineHeadRight" id="vineEvalHeadLastScan">Dernier Scann: —</span>
                    </div>
                  </th>
                </tr>
              </thead>

              <tbody>
                <tr id="vineEvalRowGlobal">
                  <td class="vineEvalRowTitle" id="vineEvalGlobalTitle">Depuis toujours (toutes pages)</td>
                  <td id="g-en-attente"></td>
                  <td id="g-excellent"></td>
                  <td id="g-bien"></td>
                  <td id="g-juste"></td>
                  <td id="g-pauvre"></td>
                  <td id="g-np"></td>
                  <td>
                    <div class="vineEvalStatus" id="vineEvalStatus"></div>
                    <div class="vineEvalMetaLine" id="vineEvalMetaGlobal"></div>
                  </td>
                </tr>

                <tr id="vineEvalRowPeriod">
                  <td class="vineEvalRowTitle" id="vineEvalPeriodTitle">Depuis éval</td>
                  <td id="p-en-attente"></td>
                  <td id="p-excellent"></td>
                  <td id="p-bien"></td>
                  <td id="p-juste"></td>
                  <td id="p-pauvre"></td>
                  <td id="p-np"></td>
                  <td>
                    <div class="vineEvalMetaLine" id="vineEvalMetaPeriod"></div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      `;

      const buttons = getButtonsContainer();
      if (buttons) buttons.insertAdjacentElement('afterend', wrapper);
      else btnRow.appendChild(wrapper);
    }

    ensureWrapperPlacement();
    render(loadState());
    applyViewMode();
    return true;
  }

  // ---------- Render ----------
  function computeDeltas(nowCounts, prevCounts) {
    if (!prevCounts) return null;
    const deltas = emptyCounts();
    for (const k of ORDER) deltas[k] = (nowCounts[k] ?? 0) - (prevCounts[k] ?? 0);
    return deltas;
  }

  const CELL_ID = {
    'en attente': 'en-attente',
    'excellent': 'excellent',
    'bien': 'bien',
    'juste': 'juste',
    'pauvre': 'pauvre',
    'n.p.': 'np'
  };

  function fillRow(prefix, counts, deltas) {
    for (const k of ORDER) {
      const el = document.getElementById(`${prefix}-${CELL_ID[k]}`);
      if (!el) continue;

      const v = counts[k] ?? 0;
      const d = (deltas && deltas[k] > 0) ? ` <span class="vineEvalDelta">+${deltas[k]}</span>` : '';
      el.innerHTML = `<b>${v}</b>${d}`;
    }
  }

  function render(st) {
    const status = document.getElementById('vineEvalStatus');
    const metaG = document.getElementById('vineEvalMetaGlobal');
    const metaP = document.getElementById('vineEvalMetaPeriod');
    const periodTitle = document.getElementById('vineEvalPeriodTitle');
    const rowPeriod = document.getElementById('vineEvalRowPeriod');
    const globalTitle = document.getElementById('vineEvalGlobalTitle');

    if (!metaG || !metaP || !periodTitle || !rowPeriod) return;

    // ✅ Update header "Dernier Scann"
    const headLast = document.getElementById('vineEvalHeadLastScan');
    if (headLast) {
      headLast.innerHTML = `Dernier Scann: <b>${formatFR(st.lastScanAt)}</b>`;
    }

    // ✅ Move "Vine depuis" into the Période column title (global row)
    const since = loadMemberSince();
    if (globalTitle) {
      globalTitle.textContent = since?.sinceDate
        ? `Vine depuis: ${since.sinceDate}`
        : 'Depuis toujours (toutes pages)';
    }

    const deltasG = computeDeltas(st.counts, st.prevCounts);
    fillRow('g', st.counts, deltasG);

    const totalDeltaG = (typeof st.prevScannedItems === 'number') ? (st.scannedItems - st.prevScannedItems) : null;
    const pagesDeltaG = (typeof st.prevPagesScanned === 'number') ? (st.pagesScanned - st.prevPagesScanned) : null;

    const totalDeltaHtmlG = (totalDeltaG && totalDeltaG > 0) ? `<span class="vineEvalDelta">(+${totalDeltaG})</span>` : '';
    const pagesDeltaHtmlG = (pagesDeltaG && pagesDeltaG > 0) ? `<span class="vineEvalDelta">(+${pagesDeltaG})</span>` : '';

    // ✅ Dernier moved to header => removed from metaG
    metaG.innerHTML = `
      <span>Total: <b>${st.scannedItems}</b> ${totalDeltaHtmlG}</span>
      <span>| Pages: <b>${st.pagesScanned}</b> ${pagesDeltaHtmlG}</span>
    `;

    if (status && !status.dataset.running) status.textContent = '';

    const period = loadPeriod();
    if (!period) {
      rowPeriod.classList.add('vineEvalMuted');
      periodTitle.textContent = 'Depuis éval (—)';

      fillRow('p', emptyCounts(), null);
      metaP.textContent = `Période: — | Va sur "Compte Vine" pour récupérer la date de début`;
      applyViewMode();
      return;
    }

    rowPeriod.classList.remove('vineEvalMuted');
    periodTitle.textContent = `Depuis éval (${period.startDate})`;

    const deltasP = computeDeltas(st.periodCounts, st.prevPeriodCounts);
    fillRow('p', st.periodCounts, deltasP);

    const totalDeltaP = (typeof st.prevPeriodScannedItems === 'number') ? (st.periodScannedItems - st.prevPeriodScannedItems) : null;
    const totalDeltaHtmlP = (totalDeltaP && totalDeltaP > 0) ? `<span class="vineEvalDelta">(+${totalDeltaP})</span>` : '';

    metaP.innerHTML = `
      <span>Total: <b>${st.periodScannedItems}</b> ${totalDeltaHtmlP}</span>
    `;

    applyViewMode();
  }

  // ---------- Extraction ----------
  function getRowAgeDaysFromTimestamp(tsMs) {
    const n = Number(tsMs);
    if (!Number.isFinite(n)) return NaN;
    return (Date.now() - n) / (24 * 3600 * 1000);
  }

  function classifyEval(rawText, ageDays) {
    const raw = normalize(rawText);
    if (raw === '' || raw === '-' || raw === '—' || raw === 'n/a' || raw === 'non disponible' || raw === 'non-disponible') return 'n.p.';
    if (raw === 'en attente' && Number.isFinite(ageDays) && ageDays >= NP_IF_EN_ATTENTE_OLDER_THAN_DAYS) return 'n.p.';
    return MAP_TO_TARGET[raw] || null;
  }

  function extractFromDoc(doc) {
    const period = loadPeriod();
    const startTs = period?.startTs ?? null;

    const rows = Array.from(doc.querySelectorAll('tr.vvp-reviews-table--row'));
    const counts = emptyCounts();
    const periodCounts = emptyCounts();
    let items = 0;
    let periodItems = 0;

    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      const cellEval = tds?.[4];
      if (!cellEval) continue;

      const tdDate = row.querySelector('td[data-order-timestamp]');
      const tsStr = tdDate?.getAttribute('data-order-timestamp');
      const ts = tsStr ? Number(tsStr) : NaN;

      const ageDays = getRowAgeDaysFromTimestamp(ts);
      const klass = classifyEval(cellEval.textContent, ageDays);
      if (!klass || counts[klass] === undefined) continue;

      counts[klass]++; items++;

      if (typeof startTs === 'number' && Number.isFinite(startTs) && Number.isFinite(ts) && ts >= startTs) {
        periodCounts[klass]++; periodItems++;
      }
    }

    return { items, counts, periodItems, periodCounts };
  }

  function getLastPageFromDoc(doc) {
    const links = Array.from(doc.querySelectorAll('ul.a-pagination a[href*="page="]'));
    let max = 1;
    for (const a of links) {
      try {
        const uu = new URL(a.getAttribute('href'), 'https://www.amazon.fr');
        const p = Number(uu.searchParams.get('page'));
        if (Number.isFinite(p)) max = Math.max(max, p);
      } catch {}
      const t = (a.textContent || '').trim();
      if (/^\d+$/.test(t)) max = Math.max(max, Number(t));
    }
    return max || 1;
  }

  function pageUrl(n) {
    const uu = new URL('https://www.amazon.fr/vine/vine-reviews');
    uu.searchParams.set('review-type', 'completed');
    uu.searchParams.set('page', String(n));
    return uu.toString();
  }

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300) resolve(resp.responseText);
          else reject(new Error(`HTTP ${resp.status}`));
        },
        onerror: () => reject(new Error('GM_xmlhttpRequest error')),
        ontimeout: () => reject(new Error('GM_xmlhttpRequest timeout')),
        timeout: 30000
      });
    });
  }

  function looksBlocked(doc) {
    const txt = normalize(doc.body?.textContent || '');
    return (
      txt.includes('saisissez les caractères') ||
      txt.includes('captcha') ||
      txt.includes('robot') ||
      (txt.includes('désolé') && txt.includes('réessayez')) ||
      txt.includes('identifiez-vous') ||
      (txt.includes('connexion') && txt.includes('mot de passe'))
    );
  }

  // ---------- Scan ----------
  let scanning = false;

  async function scanAllPages() {
    if (scanning) return;
    scanning = true;

    const status = document.getElementById('vineEvalStatus');
    setBtnDisabled(true);
    if (status) { status.dataset.running = '1'; status.textContent = 'Scan en cours…'; }

    const previous = loadState();

    let st = emptyState();
    st.prevCounts = previous.counts ? { ...previous.counts } : null;
    st.prevScannedItems = (typeof previous.scannedItems === 'number') ? previous.scannedItems : null;
    st.prevPagesScanned = (typeof previous.pagesScanned === 'number') ? previous.pagesScanned : null;
    st.prevScanAt = previous.lastScanAt ?? null;

    st.prevPeriodCounts = previous.periodCounts ? { ...previous.periodCounts } : null;
    st.prevPeriodScannedItems = (typeof previous.periodScannedItems === 'number') ? previous.periodScannedItems : null;

    saveState(st);
    render(st);

    try {
      const last = getLastPageFromDoc(document);
      const cap = Math.min(Math.max(last, 1), 1000);
      let emptyStreak = 0;

      // page 1
      {
        const { items, counts, periodItems, periodCounts } = extractFromDoc(document);
        if (items > 0) {
          for (const k of ORDER) st.counts[k] += counts[k] ?? 0;
          st.scannedItems += items;

          for (const k of ORDER) st.periodCounts[k] += periodCounts[k] ?? 0;
          st.periodScannedItems += periodItems;

          st.pagesScanned += 1;
          st.lastScanAt = new Date().toISOString();
          saveState(st);
          render(st);
        }
      }

      for (let p = 2; p <= cap; p++) {
        if (status) status.textContent = `Scan… page ${p}/${cap}`;
        await paceBetweenPages(p);

        let doc, ok = false, lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const html = await httpGet(pageUrl(p));
            doc = new DOMParser().parseFromString(html, 'text/html');
            ok = true; break;
          } catch (e) {
            lastErr = e;
            await sleep(randInt(900, 1400) * attempt);
          }
        }
        if (!ok) throw lastErr || new Error('Request failed');

        const { items, counts, periodItems, periodCounts } = extractFromDoc(doc);

        if (items === 0) {
          emptyStreak++;
          if (looksBlocked(doc)) { if (status) status.textContent = `Bloqué/contrôle à la page ${p} (captcha/login). Stop.`; break; }
          if (emptyStreak >= 2) { if (status) status.textContent = `Page ${p} sans données (HTML différent). Stop.`; break; }
          continue;
        }

        emptyStreak = 0;

        for (const k of ORDER) st.counts[k] += counts[k] ?? 0;
        st.scannedItems += items;

        for (const k of ORDER) st.periodCounts[k] += periodCounts[k] ?? 0;
        st.periodScannedItems += periodItems;

        st.pagesScanned += 1;
        st.lastScanAt = new Date().toISOString();

        saveState(st);
        render(st);
      }

      if (status && !status.textContent.startsWith('Bloqué') && !status.textContent.startsWith('Page')) {
        status.textContent = `Terminé. Pages: ${st.pagesScanned} | Éléments: ${st.scannedItems}`;
      }
    } catch (e) {
      if (status) status.textContent = `Erreur: ${String(e?.message || e)}`;
    } finally {
      scanning = false;
      setBtnDisabled(false);
      if (status) { delete status.dataset.running; }
      render(loadState());
    }
  }

  // ---------- Init / mount ----------
  const tryMount = () => {
    if (mountUIOnce()) { render(loadState()); applyViewMode(); return true; }
    return false;
  };

  if (!tryMount()) {
    const mo = new MutationObserver(() => { if (tryMount()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
  }
})();
