// ==UserScript==
// @name         Amazon Vine FR — Scan Éval — "Light"
// @namespace    https://tampermonkey.net/
// @version      3.3.8
// @description  Light version: Scans only evaluations from the current Vine evaluation period (date captured from /vine/account). Stops automatically when reaching older reviews. Simplified UI with "Scan"/"Refresh" button and "Reset" inline. + Refresh shift-robust + deltas + rating reconcile + ASIN robust (incl. ASIN from title) + stable synthetic fallback u_<ts> + UI flex/min-width + score in header + pulse (score + Excellent) 3x + height sync (card master, table slave)
// @author       Cris0338
// @match        https://www.amazon.fr/vine/vine-reviews*
// @match        https://www.amazon.fr/vine/account*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      www.amazon.fr
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // --- Configuration ---
  const HOST = location.hostname;
  const PATH = location.pathname;
  const LS_KEY_STATE = `vine_eval_counts_${HOST}_completed_light`;
  const LS_KEY_PERIOD = `vine_eval_period_${HOST}`;
  const LS_KEY_ASIN_MAP = `vine_asin_map_${HOST}_refresh`;
  const NP_IF_EN_ATTENTE_OLDER_THAN_DAYS = 180;
  const ORDER = ['en attente', 'excellent', 'bien', 'juste', 'pauvre', 'n.p.'];

  // --- Helpers ---
  const normalize = (s) => (s ?? '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
  const MAP_TO_TARGET = {
    'n.p.': 'n.p.', 'np': 'n.p.', 'non disponible': 'n.p.', 'non-disponible': 'n.p.',
    'n/a': 'n.p.', 'na': 'n.p.', '—': 'n.p.', '-': 'n.p.', '': 'n.p.',
    'en attente': 'en attente',
    'excellent': 'excellent', 'exellent': 'excellent',
    'bon': 'bien', 'bien': 'bien',
    'passable': 'juste', 'juste': 'juste',
    'mauvais': 'pauvre', 'mauvaise': 'pauvre', 'pauvre': 'pauvre'
  };

  function emptyCounts() {
    const acc = {};
    for (const k of ORDER) acc[k] = 0;
    return acc;
  }

  // --- Date parsing (handles DD/MM/YYYY and French month names) ---
  function parseDDMMYYYY(s) {
    const txt = (s || '').toString().replace(/\u00a0/g, ' ').trim();
    let m = txt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yyyy >= 2000 && yyyy <= 2100) {
        const dt = new Date(yyyy, mm - 1, dd);
        const ts = dt.getTime();
        if (Number.isFinite(ts)) {
          return { ts, str: `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}` };
        }
      }
    }
    const months = {
      'janv':1,'janvier':1,'févr':2,'fevr':2,'février':2,'fevrier':2,'mars':3,'avr':4,'avril':4,
      'mai':5,'juin':6,'juil':7,'juillet':7,'août':8,'aout':8,'sept':9,'septembre':9,
      'oct':10,'octobre':10,'nov':11,'novembre':11,'déc':12,'dec':12,'décembre':12,'decembre':12
    };
    m = txt.match(/(\d{1,2})\s+([a-zA-Zéèêëàâäîïôöûüç\.]+)\s+(\d{4})/);
    if (!m) return null;
    const dd = Number(m[1]);
    const monRaw = (m[2] || '').toLowerCase().replace(/\./g, '').trim();
    const yyyy = Number(m[3]);
    const mm = months[monRaw];
    if (!mm || !(dd >= 1 && dd <= 31 && yyyy >= 2000 && yyyy <= 2100)) return null;
    const dt = new Date(yyyy, mm - 1, dd);
    const ts = dt.getTime();
    if (!Number.isFinite(ts)) return null;
    return { ts, str: `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}` };
  }

  // --- Period storage ---
  function loadPeriod() {
    try {
      const raw = localStorage.getItem(LS_KEY_PERIOD);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && typeof obj.startTs === 'number' && typeof obj.startDate === 'string') return obj;
    } catch {}
    return null;
  }
  function savePeriod(startDate, startTs) {
    const payload = { startDate, startTs, savedAt: new Date().toISOString() };
    localStorage.setItem(LS_KEY_PERIOD, JSON.stringify(payload));
  }

  // --- Overlay on account page ---
  function showAccountOverlay(startDateStr) {
    if (document.getElementById('vinePeriodOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'vinePeriodOverlay';
    overlay.innerHTML = `
      <div class="vine-period-card">
        <div class="vine-period-title">Période mémorisée</div>
        ${startDateStr ? `<div class="vine-period-date">${startDateStr}</div>` : ''}
      </div>`;
    document.documentElement.appendChild(overlay);
    setTimeout(() => overlay.remove(), 2000);
  }

  // --- Capture period date from account page ---
  function tryCapturePeriodOnAccountPage() {
    let el = document.getElementById('vvp-evaluation-period-tooltip-trigger');
    if (!el) {
      el = Array.from(document.querySelectorAll('span, div, p')).find(e => /période|évaluation/i.test(e.textContent));
    }
    if (!el) return false;
    const txt = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
    const patterns = [
      /(\d{1,2}\s+[a-zA-Zéèêëàâäîïôöûüç\.]+\s+\d{4})\s*-/,
      /(\d{2}\/\d{2}\/\d{4})\s*-/,
      /(\d{1,2}\s+[a-zA-Zéèêëàâäîïôöûüç\.]+)\s+\d{4}/,
      /(\d{2}\/\d{2}\/\d{4})/
    ];
    for (const pattern of patterns) {
      const match = txt.match(pattern);
      if (match && match[1]) {
        const parsed = parseDDMMYYYY(match[1]);
        if (parsed) {
          const existing = loadPeriod();
          if (!existing || existing.startTs !== parsed.ts) {
            savePeriod(parsed.str, parsed.ts);
            return true;
          }
          return false;
        }
      }
    }
    return false;
  }
  function captureAccountInfos() {
    const changed = tryCapturePeriodOnAccountPage();
    if (changed) {
      const period = loadPeriod();
      showAccountOverlay(period?.startDate || null);
    }
    return changed;
  }

  // --- Account page handling ---
  if (PATH.startsWith('/vine/account')) {
    GM_addStyle(`
      #vinePeriodOverlay{position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);
        display:flex;align-items:center;justify-content:center;}
      #vinePeriodOverlay .vine-period-card{width:min(560px,calc(100%-24px));border-radius:14px;
        padding:18px 18px 16px;background:#111;border:1px solid rgba(255,255,255,.14);
        box-shadow:0 12px 40px rgba(0,0,0,.45);text-align:center;}
      #vinePeriodOverlay .vine-period-title{font-size:14px;opacity:.9;margin-bottom:10px;color:#ffffff;}
      #vinePeriodOverlay .vine-period-date{font-size:26px;font-weight:800;color:#1fbf1f;
        letter-spacing:.4px;margin:2px 0 10px;font-variant-numeric:tabular-nums;}
    `);
    if (!captureAccountInfos()) {
      const mo = new MutationObserver(() => { if (captureAccountInfos()) mo.disconnect(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 30000);
    }
    return;
  }

  // --- Reviews page guard ---
  const url = new URL(location.href);
  if (!PATH.startsWith('/vine/vine-reviews') || url.searchParams.get('review-type') !== 'completed') return;

  // --- State management ---
  const emptyState = () => ({
    scannedItems: 0,
    pagesScanned: 0,
    counts: emptyCounts(),
    lastScanAt: null,
    prevCounts: null,
    prevScannedItems: null,
    prevPagesScanned: null,
    prevScanAt: null,
    fullScanDone: false
  });

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY_STATE);
      if (!raw) return emptyState();
      const st = JSON.parse(raw);
      st.counts ||= emptyCounts();
      for (const k of ORDER) if (typeof st.counts[k] !== 'number') st.counts[k] = 0;
      st.fullScanDone ||= false;
      return st;
    } catch { return emptyState(); }
  }
  function saveState(st) { localStorage.setItem(LS_KEY_STATE, JSON.stringify(st)); }

  function loadAsinMap() {
    try {
      const raw = localStorage.getItem(LS_KEY_ASIN_MAP);
      const map = raw ? JSON.parse(raw) : {};
      if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, 'unknown')) delete map.unknown;
      return map;
    } catch { return {}; }
  }
  function saveAsinMap(map) {
    if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, 'unknown')) delete map.unknown;
    localStorage.setItem(LS_KEY_ASIN_MAP, JSON.stringify(map));
  }

  function formatFR(iso) { return iso ? new Date(iso).toLocaleString('fr-FR') : '—'; }

  // --- Reset function ---
  function resetAllData() {
    localStorage.removeItem(LS_KEY_STATE);
    localStorage.removeItem(LS_KEY_PERIOD);
    localStorage.removeItem(LS_KEY_ASIN_MAP);
    render(emptyState());
    updateButtonText(false);
    const status = document.getElementById('vineEvalStatus');
    if (status) {
      status.textContent = 'Données réinitialisées.';
      setTimeout(() => { if (status && !status.dataset.running) status.textContent = ''; }, 2000);
    }
  }

  // --- Pacing between pages ---
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const PACE_MIN_MS = 2000;
  const PACE_MAX_MS = 4000;
  async function paceBetweenPages() { await sleep(randInt(PACE_MIN_MS, PACE_MAX_MS)); }

  // --- Weighted score ---
  function computeWeightedScore(counts) {
    const ex = counts.excellent ?? 0;
    const bi = counts.bien ?? 0;
    const ju = counts.juste ?? 0;
    const pa = counts.pauvre ?? 0;
    const total = ex + bi + ju + pa;
    if (!total) return { score: null, total: 0 };
    return { score: (4*ex + 3*bi + 2*ju + 1*pa) / total, total };
  }
  function scoreLabel(score) {
    if (score === null) return '—';
    if (score < 2) return 'Mauvais';
    if (score < 3) return 'Moyen';
    return 'Excellent';
  }

  // --- Styles ---
  GM_addStyle(`
    #vvp-review-button-container{display:flex !important;align-items:center !important;gap:6px !important;flex-wrap:wrap !important;}
    #vine-eval-scan-btn .a-button-inner{transition:box-shadow .2s,border-color .2s;}
    #vine-eval-scan-btn:hover .a-button-inner{border-color:#007185 !important;box-shadow:0 0 0 2px rgba(0,113,133,.35) inset !important;}
    #vine-eval-scan-btn.vine-clicked .a-button-inner{box-shadow:0 0 0 2px rgba(0,113,133,.6) inset !important;}

    #vineEvalWrapper{width:100% !important;margin-top:10px;box-sizing:border-box;}
    #vineEvalFlex{display:flex;gap:12px;align-items:flex-start;width:100%;box-sizing:border-box;}
    @media (max-width:1100px){#vineEvalFlex{flex-direction:column;align-items:stretch;}}

    #vineEvalTableWrap{
      flex:1 1 auto;
      min-width:0;
      display:flex;
      flex-direction:column;
      border-radius:12px;
      overflow:hidden;
      border:1px solid rgba(0,113,133,.35);
      background:rgba(255,255,255,0.02);
      box-sizing:border-box;
    }
    #vineEvalTableScroll{overflow-x:auto;min-width:0;box-sizing:border-box;flex:1 1 auto;}

    #vineEvalTable{
      width:100%;
      min-width:0;
      height:100%;
      border-collapse:separate;
      border-spacing:0;
      font-size:13px;
      table-layout:fixed;
    }
    #vineEvalTable thead th{
      background:#007185;
      color:#fff;
      text-align:center;
      padding:10px;
      font-weight:800;
      white-space:nowrap;
    }
    #vineEvalTable thead th:first-child,#vineEvalTable thead th:last-child{text-align:left;padding-left:12px;padding-right:12px;}
    .vineEvalHeadFlex{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;}
    .vineEvalHeadFlex .vineHeadRight{text-align:right;font-weight:700;opacity:.95;}
    #vineEvalTable tbody{display:table-row-group;}

    #vineEvalTable tbody td{
      padding:10px;
      text-align:center;
      border-top:1px solid rgba(255,255,255,0.08);
      font-variant-numeric:tabular-nums;
      vertical-align:middle;
      white-space:nowrap;
    }
    #vineEvalTable tbody td:first-child,#vineEvalTable tbody td:last-child{
      text-align:left;
      padding-left:12px;
      padding-right:12px;
      white-space:normal;
    }
    #vineEvalTable tbody tr:nth-child(odd){background:rgba(255,255,255,0.03);}
    #vineEvalTable tbody tr:nth-child(even){background:rgba(255,255,255,0.015);}
    #vineEvalTable tbody tr:hover{background:rgba(0,113,133,.12);}
    .vineEvalRowTitle{font-weight:900;}
    .vineEvalMuted{opacity:.7;}
    .vineEvalDeltaPos{display:inline-block;margin-left:6px;font-weight:900;color:#10c010;}
    .vineEvalDeltaNeg{display:inline-block;margin-left:6px;font-weight:900;color:#ff4d4d;}

    .vineEvalMetaLine{
      display:flex;
      gap:10px;
      flex-wrap:nowrap;
      align-items:center;
      font-size:12px;
      opacity:.9;
      width:100%;
    }
    .vineEvalMetaSpacer{flex:1;min-width:0;}
    .vineEvalStatus{font-size:12px;font-weight:700;opacity:.95;}

    .vineResetLink{
      font-size:11px;
      color:#007185;
      cursor:pointer;
      white-space:nowrap;
      margin-top:0;
      user-select:none;
    }
    .vineResetLink:hover{text-decoration:underline;}
    #vineResetLinkInline{margin-top:0;}

    #vineEvalScoreWrap{
      flex:0 0 240px;
      min-width:240px;
      border-radius:12px;
      overflow:hidden;
      border:1px solid rgba(0,113,133,.35);
      background:rgba(255,255,255,0.02);
      align-self:flex-start;
      box-sizing:border-box;
    }
    @media (max-width:1100px){#vineEvalScoreWrap{flex:1;min-width:0;align-self:stretch;}}

    #vineEvalScoreHead{
      background:#007185;
      color:#fff;
      padding:8px 10px;
      font-weight:800;
      display:flex;
      justify-content:space-between;
      align-items:center;
    }
    .vineScoreHeadRight{display:flex;align-items:baseline;gap:6px;}
    .vineScoreHeadVal{
      font-size:22px;
      font-weight:900;
      color:#26d926;
      letter-spacing:.2px;
      font-variant-numeric:tabular-nums;
      text-shadow:none !important;
      line-height:1;
    }
    .vineScoreHeadMax{opacity:.9;font-weight:800;}

    #vineEvalScoreBody{
      padding:10px;
      display:flex;
      flex-direction:column;
      gap:6px;
      min-height:0;
      justify-content:flex-start;
    }
    .vineScoreMetaRow{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .vineScoreLabel{font-size:12px;font-weight:800;opacity:.85;margin:0;}
    .vineScoreDen{font-size:12px;font-weight:800;opacity:.75;white-space:nowrap;}
    .vineScoreHint{margin:0;font-size:14px;font-weight:900;opacity:.95;}

    @keyframes vinePulse {
      0%   { transform: scale(1);    filter: drop-shadow(0 0 0 rgba(38,217,38,0)); }
      40%  { transform: scale(1.08); filter: drop-shadow(0 0 6px rgba(38,217,38,.55)); }
      100% { transform: scale(1);    filter: drop-shadow(0 0 0 rgba(38,217,38,0)); }
    }
    .vinePulse3{
      display:inline-block;
      animation: vinePulse .55s ease-in-out 0s 3;
      transform-origin:center;
      will-change: transform, filter;
    }
    .vineScoreExcellent{color:#26d926 !important;}
  `);

  // --- UI mounting ---
  function getButtonsContainer() { return document.querySelector('#vvp-review-button-container'); }
  function flashClicked(btn) { btn.classList.add('vine-clicked'); setTimeout(() => btn.classList.remove('vine-clicked'), 3000); }
  function setBtnDisabled(disabled) {
    const btn = document.getElementById('vine-eval-scan-btn');
    if (btn) { btn.style.pointerEvents = disabled ? 'none' : ''; btn.style.opacity = disabled ? '0.65' : ''; }
  }
  function updateButtonText(isRefresh) {
    const btnText = document.querySelector('#vine-eval-scan-btn .a-button-text');
    if (btnText) btnText.textContent = isRefresh ? 'Refresh' : 'Scan';
  }

  // --- Height sync: card (master) -> table (slave) ---
  function syncPanelHeights() {
    const tableWrap = document.getElementById('vineEvalTableWrap');
    const tableScroll = document.getElementById('vineEvalTableScroll');
    const scoreWrap = document.getElementById('vineEvalScoreWrap');
    if (!tableWrap || !tableScroll || !scoreWrap) return;

    const stacked = window.matchMedia && window.matchMedia('(max-width:1100px)').matches;
    if (stacked) {
      tableWrap.style.height = '';
      tableScroll.style.height = '';
      return;
    }

    const h = Math.max(0, Math.round(scoreWrap.getBoundingClientRect().height));
    if (h > 0) {
      tableWrap.style.height = `${h}px`;
      tableScroll.style.height = '100%';
    }
  }

  // --- Reset handler (delegate, once) ---
  let resetHandlerInstalled = false;
  function installResetHandlerOnce() {
    if (resetHandlerInstalled) return;
    resetHandlerInstalled = true;
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.id === 'vineResetLinkInline') {
        e.preventDefault();
        resetAllData();
      }
    }, true);
  }

  function mountUIOnce() {
    const container = getButtonsContainer();
    if (!container) return false;

    installResetHandlerOnce();

    if (!document.getElementById('vine-eval-scan-btn')) {
      const btn = document.createElement('span');
      btn.id = 'vine-eval-scan-btn';
      btn.className = 'a-button a-button-normal a-button-toggle';
      btn.innerHTML = `<span class="a-button-inner"><a href="javascript:void(0)" class="a-button-text">Scan</a></span>`;
      container.appendChild(btn);

      const onClick = (e) => {
        e.preventDefault();
        flashClicked(btn);
        const st = loadState();
        if (st.fullScanDone) refreshPending(); else scanAllPages();
      };
      btn.addEventListener('click', onClick, true);
      btn.querySelector('a')?.addEventListener('click', onClick, true);
    }

    if (!document.getElementById('vineEvalWrapper')) {
      const wrapper = document.createElement('div');
      wrapper.id = 'vineEvalWrapper';
      wrapper.innerHTML = `
        <div id="vineEvalFlex">
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
                    <th>N.P.</th>
                    <th style="width:360px;">
                      <div class="vineEvalHeadFlex">
                        <span>Infos</span>
                        <span class="vineHeadRight" id="vineEvalHeadLastScan">Dernier scan: —</span>
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr id="vineEvalRowPeriod">
                    <td class="vineEvalRowTitle" id="vineEvalPeriodTitle">Depuis éval</td>
                    <td id="p-en-attente"></td>
                    <td id="p-excellent"></td>
                    <td id="p-bien"></td>
                    <td id="p-juste"></td>
                    <td id="p-pauvre"></td>
                    <td id="p-np"></td>
                    <td>
                      <div class="vineEvalStatus" id="vineEvalStatus"></div>
                      <div class="vineEvalMetaLine" id="vineEvalMetaPeriod"></div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div id="vineEvalScoreWrap">
            <div id="vineEvalScoreHead">
              <div>Score pondéré</div>
              <div class="vineScoreHeadRight">
                <span class="vineScoreHeadVal" id="vineScoreHeadVal">—</span>
                <span class="vineScoreHeadMax">/4</span>
              </div>
            </div>
            <div id="vineEvalScoreBody">
              <div class="vineScoreMetaRow">
                <div class="vineScoreLabel" id="vineScorePeriodLabel">Depuis éval</div>
                <div class="vineScoreDen" id="vineScorePeriodDen">0 avis notés</div>
              </div>
              <div class="vineScoreHint" id="vineScorePeriodHint">—</div>
            </div>
          </div>
        </div>`;
      container.insertAdjacentElement('afterend', wrapper);

      window.addEventListener('resize', () => requestAnimationFrame(syncPanelHeights), { passive: true });
    }

    const st = loadState();
    render(st);
    updateButtonText(st.fullScanDone);
    requestAnimationFrame(syncPanelHeights);
    return true;
  }

  // --- Rendering ---
  const CELL_ID = { 'en attente':'en-attente', 'excellent':'excellent', 'bien':'bien', 'juste':'juste', 'pauvre':'pauvre', 'n.p.':'np' };

  function computeDeltas(now, prev) {
    if (!prev) return null;
    const d = emptyCounts();
    for (const k of ORDER) d[k] = (now[k] ?? 0) - (prev[k] ?? 0);
    return d;
  }

  function fillRow(counts, deltas) {
    for (const k of ORDER) {
      const el = document.getElementById(`p-${CELL_ID[k]}`);
      if (!el) continue;
      const val = counts[k] ?? 0;

      let deltaHtml = '';
      if (deltas && typeof deltas[k] === 'number' && deltas[k] !== 0) {
        const dd = deltas[k];
        const cls = dd > 0 ? 'vineEvalDeltaPos' : 'vineEvalDeltaNeg';
        const sign = dd > 0 ? '+' : '';
        deltaHtml = ` <span class="${cls}">${sign}${dd}</span>`;
      }
      el.innerHTML = `<b>${val}</b>${deltaHtml}`;
    }
  }

  function pulse3(el) {
    if (!el) return;
    el.classList.remove('vinePulse3');
    void el.offsetWidth;
    el.classList.add('vinePulse3');
  }

  function updateScoreCard(st) {
    const period = loadPeriod();
    const headValEl = document.getElementById('vineScoreHeadVal');
    const denEl = document.getElementById('vineScorePeriodDen');
    const hintEl = document.getElementById('vineScorePeriodHint');
    const labelEl = document.getElementById('vineScorePeriodLabel');

    if (labelEl) labelEl.textContent = 'Depuis éval';

    if (!period) {
      if (headValEl) headValEl.textContent = '—';
      if (denEl) denEl.textContent = '0 avis notés';
      if (hintEl) {
        hintEl.textContent = 'Va sur "Compte Vine"';
        hintEl.classList.remove('vineScoreExcellent');
        hintEl.classList.remove('vinePulse3');
      }
      if (headValEl) headValEl.classList.remove('vinePulse3');
      requestAnimationFrame(syncPanelHeights);
      return;
    }

    const { score, total } = computeWeightedScore(st.counts);
    const scoreTxt = (score === null ? '—' : score.toFixed(2));
    if (headValEl) headValEl.textContent = scoreTxt;
    if (denEl) denEl.textContent = `${total} avis notés`;

    const label = scoreLabel(score);
    if (hintEl) hintEl.textContent = label;
    if (hintEl) hintEl.classList.toggle('vineScoreExcellent', label === 'Excellent');

    if (score !== null) {
      pulse3(headValEl);
      pulse3(hintEl);
    } else {
      if (headValEl) headValEl.classList.remove('vinePulse3');
      if (hintEl) hintEl.classList.remove('vinePulse3');
    }

    requestAnimationFrame(syncPanelHeights);
  }

  function render(st) {
    const meta = document.getElementById('vineEvalMetaPeriod');
    const title = document.getElementById('vineEvalPeriodTitle');
    const row = document.getElementById('vineEvalRowPeriod');
    const headLast = document.getElementById('vineEvalHeadLastScan');

    if (headLast) headLast.innerHTML = `Dernier scan: <b>${formatFR(st.lastScanAt)}</b>`;

    const period = loadPeriod();
    if (!period) {
      row.classList.add('vineEvalMuted');
      title.textContent = 'Depuis éval (—)';
      fillRow(emptyCounts(), null);
      meta.innerHTML = `Période: — | Va sur "Compte Vine" pour récupérer la date
        <span class="vineEvalMetaSpacer"></span>
        <span class="vineResetLink" id="vineResetLinkInline">Reset</span>`;
      updateScoreCard(st);
      requestAnimationFrame(syncPanelHeights);
      return;
    }

    row.classList.remove('vineEvalMuted');
    title.textContent = `Depuis éval (${period.startDate})`;

    const deltas = computeDeltas(st.counts, st.prevCounts);
    fillRow(st.counts, deltas);

    const itemDelta = (typeof st.prevScannedItems === 'number') ? st.scannedItems - st.prevScannedItems : null;
    const pageDelta = (typeof st.prevPagesScanned === 'number') ? st.pagesScanned - st.prevPagesScanned : null;

    const fmtDelta = (d) => {
      if (typeof d !== 'number' || d === 0) return '';
      const cls = d > 0 ? 'vineEvalDeltaPos' : 'vineEvalDeltaNeg';
      const sign = d > 0 ? '+' : '';
      return ` <span class="${cls}">(${sign}${d})</span>`;
    };

    meta.innerHTML = `
      <span>Total: <b>${st.scannedItems}</b>${fmtDelta(itemDelta)}</span>
      <span>| Pages: <b>${st.pagesScanned}</b>${fmtDelta(pageDelta)}</span>
      <span class="vineEvalMetaSpacer"></span>
      <span class="vineResetLink" id="vineResetLinkInline">Reset</span>
    `;

    updateScoreCard(st);
    requestAnimationFrame(syncPanelHeights);
  }

  // --- Extraction helpers ---
  function getRowAgeDays(tsMs) {
    const n = Number(tsMs);
    if (!Number.isFinite(n)) return NaN;
    return (Date.now() - n) / (86400 * 1000);
  }

  function classifyEval(text, ageDays) {
    const raw = normalize(text);
    if (['', '-', '—', 'n/a', 'non disponible', 'non-disponible'].includes(raw)) return 'n.p.';
    if (raw === 'en attente' && Number.isFinite(ageDays) && ageDays >= NP_IF_EN_ATTENTE_OLDER_THAN_DAYS) return 'n.p.';
    return MAP_TO_TARGET[raw] || null;
  }

  // ---------- FIX: extract ASIN even when product is "not available" ----------
  function extractAsinFromRow(row) {
    // 1) dataset
    const ds = row.getAttribute('data-asin') || (row.dataset ? row.dataset.asin : null);
    if (ds && /^[A-Z0-9]{10}$/.test(ds)) return ds;

    // 2) links (/dp/ or /gp/product/)
    const links = row.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      let m = href.match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/);
      if (m) return m[1];
      m = href.match(/\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/);
      if (m) return m[1];
    }

    // 3) title text often contains "(B0XXXXXXXX)" even if article is unavailable
    // Prefer the title cell if present
    const titleCell = row.querySelector('td.vvp-reviews-table--text-col');
    const txt = (titleCell ? titleCell.textContent : row.textContent) || '';
    const m3 = txt.match(/\(([A-Z0-9]{10})\)/);
    if (m3) return m3[1];

    return null;
  }

  function extractFromDoc(doc, startTs) {
    const rows = doc.querySelectorAll('tr.vvp-reviews-table--row');
    const counts = emptyCounts();
    let items = 0;
    const currentAsins = {};

    for (const row of rows) {
      const evalCell = row.querySelector('td:nth-child(5)');
      const tsCell = row.querySelector('td[data-order-timestamp]');
      if (!evalCell || !tsCell) continue;

      const ts = Number(tsCell.getAttribute('data-order-timestamp'));
      if (!Number.isFinite(ts) || ts < startTs) continue;

      const klass = classifyEval(evalCell.textContent, getRowAgeDays(ts));
      if (!klass || counts[klass] === undefined) continue;

      // ASIN stable extraction
      let asin = extractAsinFromRow(row);

      // FINAL fallback must be STABLE across page shifts:
      // use only timestamp (ts) so it never changes between refreshes.
      if (!asin) asin = `u_${ts}`;

      counts[klass] += 1;
      items += 1;
      currentAsins[asin] = { state: klass, pending: klass === 'en attente' };
    }

    return { items, counts, currentAsins };
  }

  function getLastPageFromDoc(doc) {
    const links = doc.querySelectorAll('ul.a-pagination a[href*="page="]');
    let max = 1;
    for (const a of links) {
      try {
        const p = Number(new URL(a.href).searchParams.get('page'));
        if (Number.isFinite(p)) max = Math.max(max, p);
      } catch {}
      const txt = a.textContent.trim();
      if (/^\d+$/.test(txt)) max = Math.max(max, Number(txt));
    }
    return max || 1;
  }

  function pageUrl(page) {
    const u = new URL(location.href);
    u.searchParams.set('page', String(page));
    return u.toString();
  }

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: r => r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
        onerror: () => reject(new Error('Network error')),
        timeout: 30000
      });
    });
  }

  function looksBlocked(doc) {
    if (!doc || !doc.documentElement) return true;
    if (doc.querySelector('tr.vvp-reviews-table--row')) return false;
    if (doc.querySelector('form[action*="validateCaptcha"], input[name="captcha"], img[src*="captcha"]')) return true;
    if (doc.querySelector('form#ap_signin_form, input#ap_email, input[name="email"], input#ap_password')) return true;
    const title = normalize(doc.title || '');
    if (title.includes('captcha') || title.includes('robot')) return true;
    return false;
  }

  function isValidReviewsDoc(doc) {
    return !!doc && doc.querySelectorAll('tr.vvp-reviews-table--row').length > 0;
  }

  function pageHasAnyInPeriod(doc, startTs) {
    const cells = doc.querySelectorAll('tr.vvp-reviews-table--row td[data-order-timestamp]');
    for (const c of cells) {
      const ts = Number(c.getAttribute('data-order-timestamp'));
      if (Number.isFinite(ts) && ts >= startTs) return true;
    }
    return false;
  }

  // --- Scanning ---
  let scanning = false;

  async function scanAllPages() {
    const period = loadPeriod();
    const status = document.getElementById('vineEvalStatus');

    if (!period) {
      if (status) status.textContent = 'Période non définie. Va sur "Compte Vine".';
      return;
    }

    const startTs = period.startTs;
    if (scanning) return;

    scanning = true;
    setBtnDisabled(true);

    if (status) { status.dataset.running = '1'; status.textContent = 'Scan en cours…'; }

    const prev = loadState();
    let st = emptyState();
    st.prevCounts = prev.counts ? { ...prev.counts } : null;
    st.prevScannedItems = prev.scannedItems ?? null;
    st.prevPagesScanned = prev.pagesScanned ?? null;
    st.prevScanAt = prev.lastScanAt ?? null;
    saveState(st);
    render(st);

    const asinMap = {};

    try {
      const lastPage = getLastPageFromDoc(document);
      const cap = Math.min(lastPage, 1000);

      let extracted = extractFromDoc(document, startTs);
      let items = extracted.items;
      let counts = extracted.counts;
      let currentAsins = extracted.currentAsins;

      if (items === 0) {
        if (status) status.textContent = 'Aucune évaluation dans la période.';
        scanning = false;
        setBtnDisabled(false);
        return;
      }

      Object.assign(asinMap, currentAsins);
      for (const k of Object.keys(counts)) st.counts[k] += counts[k];
      st.scannedItems += items;
      st.pagesScanned = 1;
      st.lastScanAt = new Date().toISOString();
      saveState(st);
      render(st);

      let emptyStreak = 0;

      for (let p = 2; p <= cap; p++) {
        if (status) status.textContent = `Scan… page ${p}/${cap}`;
        await paceBetweenPages();

        let html, doc;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            html = await httpGet(pageUrl(p));
            doc = new DOMParser().parseFromString(html, 'text/html');
            break;
          } catch {
            await sleep(1000 * attempt);
          }
        }

        extracted = extractFromDoc(doc, startTs);
        items = extracted.items;
        counts = extracted.counts;
        currentAsins = extracted.currentAsins;

        if (items === 0) {
          emptyStreak++;
          if (looksBlocked(doc)) {
            if (status) status.textContent = `Bloqué à la page ${p}. Stop.`;
            break;
          }
          if (emptyStreak >= 2) {
            if (status) status.textContent = `Fin de période atteinte (page ${p}).`;
            break;
          }
          continue;
        }

        emptyStreak = 0;

        Object.assign(asinMap, currentAsins);
        for (const k of Object.keys(counts)) st.counts[k] += counts[k];
        st.scannedItems += items;
        st.pagesScanned += 1;
        st.lastScanAt = new Date().toISOString();
        saveState(st);
        render(st);
      }

      saveAsinMap(asinMap);

      st.fullScanDone = true;
      saveState(st);
      updateButtonText(true);

      if (status && !status.textContent.includes('Bloqué') && !status.textContent.includes('Fin de période')) {
        status.textContent = `Terminé. Pages: ${st.pagesScanned} | Éléments: ${st.scannedItems}`;
      }

    } catch (err) {
      if (status) status.textContent = `Erreur: ${err.message || err}`;
    } finally {
      scanning = false;
      setBtnDisabled(false);
      if (status) delete status.dataset.running;
      render(loadState());
    }
  }

  // --- Refresh (SHIFT-ROBUST + VALID DOC CHECKS + RATING CHANGES) ---
  async function refreshPending() {
    const period = loadPeriod();
    if (!period) return;

    const startTs = period.startTs;
    if (scanning) return;

    scanning = true;
    setBtnDisabled(true);

    const status = document.getElementById('vineEvalStatus');
    if (status) { status.dataset.running = '1'; status.textContent = 'Refresh en cours…'; }

    let st = loadState();
    let asinMap = loadAsinMap();
    let changes = 0;

    st.prevCounts = st.counts ? { ...st.counts } : emptyCounts();
    st.prevScannedItems = typeof st.scannedItems === 'number' ? st.scannedItems : 0;
    st.prevPagesScanned = typeof st.pagesScanned === 'number' ? st.pagesScanned : 0;
    st.prevScanAt = st.lastScanAt ?? null;

    const pendingTargets = new Set(
      Object.entries(asinMap).filter(([, v]) => v && v.pending).map(([asin]) => asin)
    );

    if (status) status.textContent = `Refresh en cours… pending: ${pendingTargets.size}`;

    const seenThisRefresh = new Set();
    let outOfPeriodStreak = 0;

    try {
      let page = 1;
      const maxPagesFailsafe = 500;

      while (page <= maxPagesFailsafe && pendingTargets.size > 0 && outOfPeriodStreak < 2) {
        if (status) status.textContent = `Refresh… page ${page} | pending: ${pendingTargets.size}`;

        let doc = (page === 1) ? document : null;

        if (doc) {
          if (!isValidReviewsDoc(doc)) {
            if (looksBlocked(doc)) {
              if (status) status.textContent = `Bloqué (captcha/login) page 1. Stop.`;
            } else {
              if (status) status.textContent = `Erreur: page 1 invalide. Stop.`;
            }
            break;
          }
        } else {
          await paceBetweenPages();

          let html = null;
          doc = null;

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              html = await httpGet(pageUrl(page));
              const tmp = new DOMParser().parseFromString(html, 'text/html');

              if (isValidReviewsDoc(tmp)) { doc = tmp; break; }

              if (looksBlocked(tmp)) {
                if (status) status.textContent = `Bloqué (captcha/login) à la page ${page}. Stop.`;
                doc = null;
                break;
              }

              await sleep(1200 * attempt);
            } catch {
              await sleep(1000 * attempt);
            }
          }

          if (!doc) {
            if (status && !status.textContent.includes('Bloqué')) {
              status.textContent = `Erreur: page ${page} invalide (HTML vide/redirect). Stop.`;
            }
            break;
          }
        }

        const hasAnyInPeriod = pageHasAnyInPeriod(doc, startTs);
        if (!hasAnyInPeriod) {
          outOfPeriodStreak++;
          page++;
          continue;
        } else {
          outOfPeriodStreak = 0;
        }

        const { currentAsins } = extractFromDoc(doc, startTs);

        for (const [asin, info] of Object.entries(currentAsins)) {
          if (!asin) continue;
          if (seenThisRefresh.has(asin)) continue;
          seenThisRefresh.add(asin);

          const old = asinMap[asin];

          if (old) {
            if (old.state !== info.state) {
              st.counts[old.state] = Math.max(0, (st.counts[old.state] ?? 0) - 1);
              st.counts[info.state] = (st.counts[info.state] ?? 0) + 1;
              changes++;
            }
          } else {
            st.counts[info.state] = (st.counts[info.state] ?? 0) + 1;
            st.scannedItems = (st.scannedItems ?? 0) + 1;
            changes++;
          }

          asinMap[asin] = info;

          if (pendingTargets.has(asin) && !info.pending) pendingTargets.delete(asin);
        }

        page++;
      }

      saveAsinMap(asinMap);

      st.lastScanAt = new Date().toISOString();
      saveState(st);
      render(st);

      if (status) {
        if (pendingTargets.size === 0) {
          status.textContent = changes > 0
            ? `Mis à jour ! ${changes} changement${changes > 1 ? 's' : ''} | Pending résolus`
            : 'Aucun changement | Pending résolus';
        } else if (outOfPeriodStreak >= 2) {
          status.textContent = changes > 0
            ? `Stop (hors période). ${changes} changement${changes > 1 ? 's' : ''} | Pending restants: ${pendingTargets.size}`
            : `Stop (hors période). Pending restants: ${pendingTargets.size}`;
        } else {
          if (!status.textContent || status.textContent === 'Refresh en cours…') {
            status.textContent = `Stop. Pending restants: ${pendingTargets.size}`;
          }
        }
      }

    } catch (err) {
      if (status) status.textContent = `Erreur refresh: ${err.message || err}`;
    } finally {
      scanning = false;
      setBtnDisabled(false);
      if (status) delete status.dataset.running;
      render(loadState());
    }
  }

  // --- Initial mount ---
  if (!mountUIOnce()) {
    const mo = new MutationObserver(() => { if (mountUIOnce()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
  }
})();
