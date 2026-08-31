// ==UserScript==
// @name         Amazon Vine FR — Scan Éval — "Light"
// @namespace    https://tampermonkey.net/
// @version      3.4.0-dev
// @description  v3.3.9 baseline + Non approuvé workflow (real Amazon edit links, inline editability check, dedicated view, real modification tracking)
// @author       Cris0338
// @match        https://www.amazon.fr/vine/vine-reviews*
// @match        https://www.amazon.fr/vine/account*
// @match        https://www.amazon.fr/review/create-review*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      www.amazon.fr
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const HOST = location.hostname;
  const PATH = location.pathname;
  const LS_KEY_STATE = `vine_eval_counts_${HOST}_completed_light`;
  const LS_KEY_PERIOD = `vine_eval_period_${HOST}`;
  const LS_KEY_ASIN_MAP = `vine_asin_map_${HOST}_refresh`;
  const NP_IF_EN_ATTENTE_OLDER_THAN_DAYS = 180;
  const STATE_SCHEMA_VERSION = 3;
  const ORDER = ['en attente', 'excellent', 'bien', 'juste', 'pauvre', 'n.p.'];
  const VISIBLE_ORDER = ['en attente', 'excellent', 'bien', 'juste', 'pauvre'];
  const NON_APPROVED_VIEW_PARAM = 'vine-eval-non-approved';

  const normalize = (s) => (s ?? '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
  const normalizeLoose = (s) => normalize(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/’/g, "'");

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

  function emptyState() {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      scannedItems: 0,
      pagesScanned: 0,
      counts: emptyCounts(),
      pendingApproval: 0,
      nonApprovedModifiable: 0,
      nonApprovedNonModifiable: 0,
      nonApprovedUnknown: 0,
      lastScanAt: null,
      prevCounts: null,
      prevPendingApproval: null,
      prevScannedItems: null,
      prevPagesScanned: null,
      prevScanAt: null,
      fullScanDone: false
    };
  }

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
    localStorage.setItem(LS_KEY_PERIOD, JSON.stringify({
      startDate,
      startTs,
      savedAt: new Date().toISOString()
    }));
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY_STATE);
      if (!raw) return emptyState();
      const st = JSON.parse(raw);
      const schemaMatches = st.schemaVersion === STATE_SCHEMA_VERSION;

      st.counts ||= emptyCounts();
      for (const k of ORDER) if (typeof st.counts[k] !== 'number') st.counts[k] = 0;
      if (typeof st.pendingApproval !== 'number') st.pendingApproval = 0;
      if (typeof st.nonApprovedModifiable !== 'number') st.nonApprovedModifiable = 0;
      if (typeof st.nonApprovedNonModifiable !== 'number') st.nonApprovedNonModifiable = 0;
      if (typeof st.nonApprovedUnknown !== 'number') st.nonApprovedUnknown = 0;
      if (typeof st.prevPendingApproval !== 'number') st.prevPendingApproval = null;

      st.fullScanDone = schemaMatches ? !!st.fullScanDone : false;
      st.schemaVersion = STATE_SCHEMA_VERSION;
      return st;
    } catch {
      return emptyState();
    }
  }

  function saveState(st) {
    localStorage.setItem(LS_KEY_STATE, JSON.stringify(st));
  }

  function loadAsinMap() {
    try {
      const raw = localStorage.getItem(LS_KEY_ASIN_MAP);
      const map = raw ? JSON.parse(raw) : {};
      if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, 'unknown')) delete map.unknown;
      return map && typeof map === 'object' ? map : {};
    } catch {
      return {};
    }
  }

  function saveAsinMap(map) {
    if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, 'unknown')) delete map.unknown;
    localStorage.setItem(LS_KEY_ASIN_MAP, JSON.stringify(map || {}));
  }

  function formatFR(iso) {
    return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
  }

  function absoluteAmazonUrl(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      if (u.hostname !== HOST) return null;
      return u.href;
    } catch {
      return null;
    }
  }

  function normalizeUrlForMatch(raw) {
    try {
      const u = new URL(raw, location.origin);
      u.hash = '';
      return u.href;
    } catch {
      return String(raw || '');
    }
  }

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

  function extractAsinFromAnyNode(root = document) {
    const dataNode = root.querySelector?.('[data-asin]');
    const ds = dataNode?.getAttribute?.('data-asin');
    if (ds && /^[A-Z0-9]{10}$/i.test(ds)) return ds.toUpperCase();

    for (const el of root.querySelectorAll?.('input[value], a[href]') || []) {
      const v = el.getAttribute('value') || el.getAttribute('href') || '';
      const m = v.match(/(?:\/dp\/|\/gp\/product\/|asin[=\/])([A-Z0-9]{10})(?:[/?&#]|$)/i);
      if (m) return m[1].toUpperCase();
    }

    const txt = root.body?.textContent || root.textContent || '';
    const m = txt.match(/\b(B0[A-Z0-9]{8})\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  function captureReviewEditorSnapshot() {
    const title = document.querySelector('#reviewTitle')?.value ?? '';
    const text = document.querySelector('#reviewText')?.value ?? '';

    const checkedRating = document.querySelector(
      'input[type="radio"][name*="star"]:checked, input[type="radio"][name*="rating"]:checked'
    );
    const rating =
      checkedRating?.value ??
      document.querySelector('[data-hook="rating-out-of-text"]')?.textContent ??
      document.querySelector('[aria-label*="étoile"][aria-checked="true"]')?.getAttribute('aria-label') ??
      document.querySelector('[aria-label*="star"][aria-checked="true"]')?.getAttribute('aria-label') ??
      '';

    const files = Array.from(document.querySelectorAll('input[type="file"]'))
      .flatMap(input => Array.from(input.files || []))
      .map(f => `${f.name}|${f.size}|${f.type}|${f.lastModified}`)
      .sort();

    const media = Array.from(document.querySelectorAll(
      '[data-hook*="media"] img[src], [data-hook*="media"] video[src], .ryp-media img[src], .ryp-media video[src]'
    ))
      .map(el => el.getAttribute('src') || '')
      .filter(Boolean)
      .sort();

    return JSON.stringify({ title, text, rating: normalize(rating), files, media });
  }

  function findStoredReviewForCurrentEditor() {
    const map = loadAsinMap();
    const current = normalizeUrlForMatch(location.href);
    const asin = extractAsinFromAnyNode(document);

    if (asin && map[asin]) return { key: asin, record: map[asin], map };

    for (const [key, rec] of Object.entries(map)) {
      if (!rec) continue;
      if (rec.editResolvedUrl && normalizeUrlForMatch(rec.editResolvedUrl) === current) {
        return { key, record: rec, map };
      }
      if (rec.editUrl && normalizeUrlForMatch(rec.editUrl) === current) {
        return { key, record: rec, map };
      }
    }
    return null;
  }

  function initRealReviewModificationTracking() {
    if (!PATH.startsWith('/review/create-review')) return false;
    if (window.top !== window.self) return true;

    const start = () => {
      const form = document.querySelector('#in-context-ryp-form');
      const text = document.querySelector('#reviewText');
      const title = document.querySelector('#reviewTitle');
      if (!form || !text || !title) return false;

      const target = findStoredReviewForCurrentEditor();
      if (!target) return true;

      const initialSnapshot = captureReviewEditorSnapshot();
      let marked = false;

      const markIfReallyChanged = () => {
        if (marked) return;
        const currentSnapshot = captureReviewEditorSnapshot();
        if (currentSnapshot === initialSnapshot) return;

        const latest = loadAsinMap();
        const rec = latest[target.key];
        if (!rec) return;
        rec.modified = true;
        rec.modifiedAt = new Date().toISOString();
        latest[target.key] = rec;
        saveAsinMap(latest);
        marked = true;
      };

      form.addEventListener('submit', markIfReallyChanged, true);

      document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button, input[type="submit"], input[type="button"], a');
        if (!btn) return;
        const label = normalizeLoose(btn.textContent || btn.value || btn.getAttribute('aria-label') || '');
        if (label === 'envoyer' || label.includes('envoyer')) {
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
          markIfReallyChanged();
        }
      }, true);

      return true;
    };

    if (!start()) {
      const mo = new MutationObserver(() => {
        if (start()) mo.disconnect();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 20000);
    }
    return true;
  }

  if (initRealReviewModificationTracking()) return;

  if (PATH.startsWith('/vine/account')) {
    GM_addStyle(`
      #vinePeriodOverlay{position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;}
      #vinePeriodOverlay .vine-period-card{width:min(560px,calc(100% - 24px));border-radius:14px;padding:18px;background:#111;border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 40px rgba(0,0,0,.45);text-align:center;}
      #vinePeriodOverlay .vine-period-title{font-size:14px;opacity:.9;margin-bottom:10px;color:#fff;}
      #vinePeriodOverlay .vine-period-date{font-size:26px;font-weight:800;color:#1fbf1f;letter-spacing:.4px;font-variant-numeric:tabular-nums;}
    `);

    if (!captureAccountInfos()) {
      const mo = new MutationObserver(() => {
        if (captureAccountInfos()) mo.disconnect();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 30000);
    }
    return;
  }

  const url = new URL(location.href);
  if (!PATH.startsWith('/vine/vine-reviews') || url.searchParams.get('review-type') !== 'completed') return;

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

  function isApprovalPendingStatus(text) {
    return normalizeLoose(text) === "en attente d'approbation";
  }

  function isNonApprovedStatus(text) {
    const status = normalizeLoose(text);
    return status === 'non approuve' || status === 'non approuvee';
  }

  function extractAsinFromRow(row) {
    const ds = row.getAttribute('data-asin') || row.dataset?.asin;
    if (ds && /^[A-Z0-9]{10}$/i.test(ds)) return ds.toUpperCase();

    for (const a of row.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      let m = href.match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i);
      if (m) return m[1].toUpperCase();
      m = href.match(/\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i);
      if (m) return m[1].toUpperCase();
    }

    const titleCell = row.querySelector('td.vvp-reviews-table--text-col');
    const txt = (titleCell ? titleCell.textContent : row.textContent) || '';
    const m = txt.match(/\(([A-Z0-9]{10})\)/i);
    return m ? m[1].toUpperCase() : null;
  }

  function extractAmazonEditLink(row) {
    const links = Array.from(row.querySelectorAll('a[href]'));
    const byText = links.find(a => {
      const t = normalizeLoose(a.textContent || a.getAttribute('aria-label') || '');
      return (t.includes('modifier') && (t.includes('commentaire') || t.includes('avis'))) ||
        t.includes('edit review');
    });

    if (byText) return absoluteAmazonUrl(byText.getAttribute('href'));

    const byPath = links.find(a => {
      const href = a.getAttribute('href') || '';
      return /\/review\/create-review/i.test(href);
    });
    return byPath ? absoluteAmazonUrl(byPath.getAttribute('href')) : null;
  }

  function extractProductMeta(row, ts) {
    const image = row.querySelector('td.vvp-reviews-table--image-col img, img');
    const productLink = row.querySelector(
      'td.vvp-reviews-table--text-col a[href*="/dp/"], td.vvp-reviews-table--text-col a[href*="/gp/product/"]'
    );
    const textCell = row.querySelector('td.vvp-reviews-table--text-col');
    const tsCell = row.querySelector('td[data-order-timestamp]');
    const firstTextLink = textCell?.querySelector('a');

    const title = firstTextLink?.textContent?.trim() ||
      (textCell?.textContent || '').trim() ||
      'Produit';

    return {
      productTitle: title,
      productUrl: productLink ? absoluteAmazonUrl(productLink.getAttribute('href')) : null,
      imageUrl: image?.getAttribute('src') || image?.getAttribute('data-src') || null,
      orderDateText: (tsCell?.textContent || '').replace(/\s+/g, ' ').trim(),
      orderTs: ts
    };
  }

  function extractEntriesFromDoc(doc, startTs) {
    const rows = doc?.querySelectorAll?.('tr.vvp-reviews-table--row') || [];
    const entries = [];

    for (const row of rows) {
      const reviewStatusCell = row.querySelector('td:nth-child(4)');
      const evalCell = row.querySelector('td:nth-child(5)');
      const tsCell = row.querySelector('td[data-order-timestamp]');
      if (!evalCell || !tsCell) continue;

      const ts = Number(tsCell.getAttribute('data-order-timestamp'));
      if (!Number.isFinite(ts) || ts < startTs) continue;

      const state = classifyEval(evalCell.textContent, getRowAgeDays(ts));
      if (!state || state === undefined) continue;

      const statusText = (reviewStatusCell?.textContent || '').replace(/\s+/g, ' ').trim();
      const approvalPending = isApprovalPendingStatus(statusText);
      const nonApproved = isNonApprovedStatus(statusText);

      let asin = extractAsinFromRow(row);
      if (!asin) asin = `u_${ts}`;

      const meta = extractProductMeta(row, ts);
      entries.push({
        key: asin,
        state,
        pending: state === 'en attente',
        approvalPending,
        nonApproved,
        reviewStatus: statusText,
        editUrl: nonApproved ? extractAmazonEditLink(row) : null,
        ...meta
      });
    }

    return entries;
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
    u.searchParams.delete(NON_APPROVED_VIEW_PARAM);
    u.searchParams.set('page', String(page));
    return u.toString();
  }

  function httpGet(targetUrl) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: targetUrl,
        onload: r => r.status >= 200 && r.status < 300
          ? resolve({ text: r.responseText, finalUrl: r.finalUrl || targetUrl })
          : reject(new Error(`HTTP ${r.status}`)),
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
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
    return title.includes('captcha') || title.includes('robot');
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

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function checkAmazonEditability(editUrl) {
    if (!editUrl) {
      return { editability: 'unknown', editResolvedUrl: null, checkedAt: new Date().toISOString() };
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { text, finalUrl } = await httpGet(editUrl);
        const doc = new DOMParser().parseFromString(text, 'text/html');

        if (
          doc.querySelector('.ryp-error-page-text, #ryp-error-page-text, .ryp-icon-alert, #ryp-icon-alert') ||
          text.includes('ryp-error-page-text') ||
          text.includes('ryp-icon-alert')
        ) {
          return {
            editability: 'non-modifiable',
            editResolvedUrl: finalUrl || editUrl,
            checkedAt: new Date().toISOString()
          };
        }

        if (
          doc.querySelector('#in-context-ryp-form') &&
          doc.querySelector('#reviewText') &&
          doc.querySelector('#reviewTitle')
        ) {
          return {
            editability: 'modifiable',
            editResolvedUrl: finalUrl || editUrl,
            checkedAt: new Date().toISOString()
          };
        }
      } catch {}

      if (attempt < 3) await sleep(700 * attempt);
    }

    return {
      editability: 'unknown',
      editResolvedUrl: editUrl,
      checkedAt: new Date().toISOString()
    };
  }

  const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const PACE_MIN_MS = 2000;
  const PACE_MAX_MS = 4000;

  async function paceBetweenPages() {
    await sleep(randInt(PACE_MIN_MS, PACE_MAX_MS));
  }

  function applyNonApprovedTotalsFromMap(st, map) {
    let modifiable = 0;
    let nonModifiable = 0;
    let unknown = 0;

    for (const rec of Object.values(map)) {
      if (!rec?.nonApproved) continue;
      if (rec.editability === 'modifiable') modifiable++;
      else if (rec.editability === 'non-modifiable') nonModifiable++;
      else unknown++;
    }

    st.nonApprovedModifiable = modifiable;
    st.nonApprovedNonModifiable = nonModifiable;
    st.nonApprovedUnknown = unknown;
  }

  async function enrichNonApproved(entry, oldRecord = null) {
    const base = {
      ...(oldRecord || {}),
      ...entry,
      modified: !!oldRecord?.modified,
      modifiedAt: oldRecord?.modifiedAt || null
    };

    if (!entry.nonApproved) {
      base.editability = null;
      base.checkedAt = null;
      base.editResolvedUrl = null;
      base.editUrl = null;
      return base;
    }

    if (!entry.editUrl) {
      base.editability = 'unknown';
      base.checkedAt = new Date().toISOString();
      return base;
    }

    const checked = await checkAmazonEditability(entry.editUrl);
    return { ...base, ...checked };
  }

  GM_addStyle(`
    #vvp-review-button-container{display:flex !important;align-items:center !important;gap:6px !important;flex-wrap:wrap !important;}
    #vine-eval-scan-btn .a-button-inner{transition:box-shadow .2s,border-color .2s;}
    #vine-eval-scan-btn:hover .a-button-inner{border-color:#007185 !important;box-shadow:0 0 0 2px rgba(0,113,133,.35) inset !important;}
    #vine-eval-scan-btn.vine-clicked .a-button-inner{box-shadow:0 0 0 2px rgba(0,113,133,.6) inset !important;}
    #vineEvalWrapper{width:100% !important;margin-top:10px;box-sizing:border-box;}
    #vineEvalFlex{display:flex;gap:12px;align-items:flex-start;width:100%;box-sizing:border-box;}
    @media (max-width:1100px){#vineEvalFlex{flex-direction:column;align-items:stretch;}}
    #vineEvalTableWrap{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;border:1px solid rgba(0,113,133,.35);background:rgba(255,255,255,.02);box-sizing:border-box;}
    #vineEvalTableScroll{overflow-x:auto;min-width:0;box-sizing:border-box;flex:1 1 auto;}
    #vineEvalTable{width:100%;height:100%;border-collapse:separate;border-spacing:0;font-size:13px;table-layout:fixed;}
    #vineEvalTable thead th{background:#007185;color:#fff;text-align:center;padding:10px;font-weight:800;white-space:nowrap;}
    #vineEvalTable thead th:first-child,#vineEvalTable thead th:last-child{text-align:left;padding-left:12px;padding-right:12px;}
    #vineEvalTable tbody td{padding:10px;text-align:center;border-top:1px solid rgba(255,255,255,.08);font-variant-numeric:tabular-nums;vertical-align:middle;white-space:nowrap;}
    #vineEvalTable tbody td:first-child,#vineEvalTable tbody td:last-child{text-align:left;padding-left:12px;padding-right:12px;white-space:normal;}
    #vineEvalTable tbody tr:nth-child(odd){background:rgba(255,255,255,.03);}
    #vineEvalTable tbody tr:nth-child(even){background:rgba(255,255,255,.015);}
    #vineEvalTable tbody tr:hover{background:rgba(0,113,133,.12);}
    .vineEvalHeadFlex{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;}
    .vineEvalHeadFlex .vineHeadRight{text-align:right;font-weight:700;opacity:.95;}
    .vineEvalRowTitle{font-weight:900;}
    .vineEvalMuted{opacity:.7;}
    .vineEvalDeltaPos{display:inline-block;margin-left:6px;font-weight:900;color:#10c010;}
    .vineEvalDeltaNeg{display:inline-block;margin-left:6px;font-weight:900;color:#ff4d4d;}
    .vineEvalMetaLine{display:flex;gap:10px;flex-wrap:nowrap;align-items:center;font-size:12px;opacity:.9;width:100%;}
    .vineEvalMetaSpacer{flex:1;min-width:0;}
    .vineEvalStatus{font-size:12px;font-weight:700;opacity:.95;}
    .vineResetLink{font-size:11px;color:#007185;cursor:pointer;white-space:nowrap;user-select:none;}
    .vineResetLink:hover{text-decoration:underline;}
    #p-non-approved a{color:#007185;text-decoration:none;font-weight:900;cursor:pointer;}
    #p-non-approved a:hover{text-decoration:underline;}
    .vineNonApprovedUnknown{margin-left:4px;font-size:10px;opacity:.65;}
    #vineEvalScoreWrap{flex:0 0 240px;min-width:240px;border-radius:12px;overflow:hidden;border:1px solid rgba(0,113,133,.35);background:rgba(255,255,255,.02);align-self:flex-start;box-sizing:border-box;}
    @media (max-width:1100px){#vineEvalScoreWrap{flex:1;min-width:0;align-self:stretch;}}
    #vineEvalScoreHead{background:#007185;color:#fff;padding:8px 10px;font-weight:800;display:flex;justify-content:space-between;align-items:center;}
    .vineScoreHeadRight{display:flex;align-items:baseline;gap:6px;}
    .vineScoreHeadVal{font-size:22px;font-weight:900;color:#26d926;letter-spacing:.2px;font-variant-numeric:tabular-nums;line-height:1;}
    .vineScoreHeadMax{opacity:.9;font-weight:800;}
    #vineEvalScoreBody{padding:10px;display:flex;flex-direction:column;gap:6px;}
    .vineScoreMetaRow{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .vineScoreLabel{font-size:12px;font-weight:800;opacity:.85;}
    .vineScoreDen{font-size:12px;font-weight:800;opacity:.75;white-space:nowrap;}
    .vineScoreHint{font-size:14px;font-weight:900;opacity:.95;}
    .vineScoreExcellent{color:#26d926 !important;}
    @keyframes vinePulse{0%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(38,217,38,0));}40%{transform:scale(1.08);filter:drop-shadow(0 0 6px rgba(38,217,38,.55));}100%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(38,217,38,0));}}
    .vinePulse3{display:inline-block;animation:vinePulse .55s ease-in-out 0s 3;transform-origin:center;will-change:transform,filter;}
    #vineNonApprovedPage{margin:16px 0 28px;border:1px solid #d5d9d9;border-radius:12px;overflow:hidden;background:#fff;color:#111;}
    #vineNonApprovedPage .nap-head{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#007185;color:#fff;padding:14px 16px;}
    #vineNonApprovedPage .nap-head h2{margin:0;font-size:20px;}
    #vineNonApprovedPage .nap-back{color:#fff;text-decoration:underline;font-weight:700;}
    #vineNonApprovedPage .nap-section{padding:16px;}
    #vineNonApprovedPage .nap-section h3{margin:0 0 12px;font-size:18px;}
    #vineNonApprovedPage .nap-separator{height:8px;background:linear-gradient(90deg,#007185,#d5d9d9,#007185);margin:4px 0;border-top:1px solid #007185;border-bottom:1px solid #007185;}
    #vineNonApprovedPage .nap-table-wrap{overflow-x:auto;}
    #vineNonApprovedPage table{width:100%;border-collapse:collapse;min-width:820px;}
    #vineNonApprovedPage th{background:#f0f2f2;text-align:left;padding:9px;border-bottom:1px solid #d5d9d9;white-space:nowrap;}
    #vineNonApprovedPage td{padding:9px;border-bottom:1px solid #eee;vertical-align:middle;}
    #vineNonApprovedPage .nap-img{width:64px;height:64px;object-fit:contain;}
    #vineNonApprovedPage .nap-action{display:inline-block;padding:6px 10px;border-radius:16px;background:#ffd814;border:1px solid #fcd200;color:#111;text-decoration:none;font-weight:700;white-space:nowrap;}
    #vineNonApprovedPage .nap-verify{background:#fff;border-color:#888;}
    #vineNonApprovedPage .nap-modified{font-weight:900;color:#067d62;}
    #vineNonApprovedPage .nap-empty{padding:12px;border:1px dashed #aaa;border-radius:8px;opacity:.75;}
  `);

  function getButtonsContainer() {
    return document.querySelector('#vvp-review-button-container');
  }

  function flashClicked(btn) {
    btn.classList.add('vine-clicked');
    setTimeout(() => btn.classList.remove('vine-clicked'), 3000);
  }

  function setBtnDisabled(disabled) {
    const btn = document.getElementById('vine-eval-scan-btn');
    if (btn) {
      btn.style.pointerEvents = disabled ? 'none' : '';
      btn.style.opacity = disabled ? '0.65' : '';
    }
  }

  function updateButtonText(isRefresh) {
    const btnText = document.querySelector('#vine-eval-scan-btn .a-button-text');
    if (btnText) btnText.textContent = isRefresh ? 'Refresh' : 'Scan';
  }

  function syncPanelHeights() {
    const tableWrap = document.getElementById('vineEvalTableWrap');
    const tableScroll = document.getElementById('vineEvalTableScroll');
    const scoreWrap = document.getElementById('vineEvalScoreWrap');
    if (!tableWrap || !tableScroll || !scoreWrap) return;

    const stacked = window.matchMedia?.('(max-width:1100px)').matches;
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

  function resetAllData() {
    localStorage.removeItem(LS_KEY_STATE);
    localStorage.removeItem(LS_KEY_PERIOD);
    localStorage.removeItem(LS_KEY_ASIN_MAP);
    render(emptyState());
    updateButtonText(false);
    const status = document.getElementById('vineEvalStatus');
    if (status) {
      status.textContent = 'Données réinitialisées.';
      setTimeout(() => {
        if (status && !status.dataset.running) status.textContent = '';
      }, 2000);
    }
  }

  let resetHandlerInstalled = false;
  function installResetHandlerOnce() {
    if (resetHandlerInstalled) return;
    resetHandlerInstalled = true;
    document.addEventListener('click', (e) => {
      if (e.target?.id === 'vineResetLinkInline') {
        e.preventDefault();
        resetAllData();
      }
    }, true);
  }

  function nonApprovedPageUrl() {
    const u = new URL(location.href);
    u.searchParams.delete('page');
    u.searchParams.set(NON_APPROVED_VIEW_PARAM, '1');
    return u.href;
  }

  function normalReviewsUrl() {
    const u = new URL(location.href);
    u.searchParams.delete(NON_APPROVED_VIEW_PARAM);
    u.searchParams.delete('page');
    return u.href;
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
                    <th style="width:170px;">En attente d'approbation</th>
                    <th>En attente</th>
                    <th>Excellent</th>
                    <th>Bien</th>
                    <th>Juste</th>
                    <th>Pauvre</th>
                    <th style="width:145px;">Non approuvé</th>
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
                    <td id="p-approval-pending"></td>
                    <td id="p-en-attente"></td>
                    <td id="p-excellent"></td>
                    <td id="p-bien"></td>
                    <td id="p-juste"></td>
                    <td id="p-pauvre"></td>
                    <td id="p-non-approved"></td>
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

    if (url.searchParams.get(NON_APPROVED_VIEW_PARAM) === '1') {
      renderNonApprovedPage();
    }

    requestAnimationFrame(syncPanelHeights);
    return true;
  }

  const CELL_ID = {
    'en attente':'en-attente',
    'excellent':'excellent',
    'bien':'bien',
    'juste':'juste',
    'pauvre':'pauvre'
  };

  function computeDeltas(now, prev) {
    if (!prev) return null;
    const d = emptyCounts();
    for (const k of ORDER) d[k] = (now[k] ?? 0) - (prev[k] ?? 0);
    return d;
  }

  function fillRow(counts, deltas) {
    for (const k of VISIBLE_ORDER) {
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

  function fillApprovalPending(value, delta) {
    const el = document.getElementById('p-approval-pending');
    if (!el) return;

    const val = Number.isFinite(Number(value)) ? Number(value) : 0;
    let deltaHtml = '';
    if (typeof delta === 'number' && delta !== 0) {
      const cls = delta > 0 ? 'vineEvalDeltaPos' : 'vineEvalDeltaNeg';
      const sign = delta > 0 ? '+' : '';
      deltaHtml = ` <span class="${cls}">${sign}${delta}</span>`;
    }
    el.innerHTML = `<b>${val}</b>${deltaHtml}`;
  }

  function fillNonApproved(st) {
    const el = document.getElementById('p-non-approved');
    if (!el) return;

    const mod = Number(st.nonApprovedModifiable || 0);
    const no = Number(st.nonApprovedNonModifiable || 0);
    el.innerHTML = `<a href="${nonApprovedPageUrl()}" title="Voir les Non approuvés">${mod} ✏️</a> (${no} 🚫)`;
  }

  function computeWeightedScore(counts) {
    const ex = counts.excellent ?? 0;
    const bi = counts.bien ?? 0;
    const ju = counts.juste ?? 0;
    const pa = counts.pauvre ?? 0;
    const total = ex + bi + ju + pa;
    if (!total) return { score: null, total: 0 };
    return { score: (4*ex + 3*bi + 2*ju + pa) / total, total };
  }

  function scoreLabel(score) {
    if (score === null) return '—';
    if (score < 2) return 'Mauvais';
    if (score < 3) return 'Moyen';
    return 'Excellent';
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

    if (!period) {
      if (headValEl) headValEl.textContent = '—';
      if (denEl) denEl.textContent = '0 avis notés';
      if (hintEl) {
        hintEl.textContent = 'Va sur "Compte Vine"';
        hintEl.classList.remove('vineScoreExcellent', 'vinePulse3');
      }
      headValEl?.classList.remove('vinePulse3');
      requestAnimationFrame(syncPanelHeights);
      return;
    }

    const { score, total } = computeWeightedScore(st.counts);
    if (headValEl) headValEl.textContent = score === null ? '—' : score.toFixed(2);
    if (denEl) denEl.textContent = `${total} avis notés`;

    const label = scoreLabel(score);
    if (hintEl) {
      hintEl.textContent = label;
      hintEl.classList.toggle('vineScoreExcellent', label === 'Excellent');
    }

    if (score !== null) {
      pulse3(headValEl);
      pulse3(hintEl);
    }

    requestAnimationFrame(syncPanelHeights);
  }

  function render(st) {
    const meta = document.getElementById('vineEvalMetaPeriod');
    const title = document.getElementById('vineEvalPeriodTitle');
    const row = document.getElementById('vineEvalRowPeriod');
    const headLast = document.getElementById('vineEvalHeadLastScan');
    if (!meta || !title || !row) return;

    if (headLast) headLast.innerHTML = `Dernier scan: <b>${formatFR(st.lastScanAt)}</b>`;

    const period = loadPeriod();
    if (!period) {
      row.classList.add('vineEvalMuted');
      title.textContent = 'Depuis éval (—)';
      fillApprovalPending(0, null);
      fillRow(emptyCounts(), null);
      fillNonApproved(emptyState());
      meta.innerHTML = `Période: — | Va sur "Compte Vine" pour récupérer la date
        <span class="vineEvalMetaSpacer"></span>
        <span class="vineResetLink" id="vineResetLinkInline">Reset</span>`;
      updateScoreCard(st);
      return;
    }

    row.classList.remove('vineEvalMuted');
    title.textContent = `Depuis éval (${period.startDate})`;

    const deltas = computeDeltas(st.counts, st.prevCounts);
    const approvalDelta = typeof st.prevPendingApproval === 'number'
      ? (st.pendingApproval ?? 0) - st.prevPendingApproval
      : null;

    fillApprovalPending(st.pendingApproval ?? 0, approvalDelta);
    fillRow(st.counts, deltas);
    fillNonApproved(st);

    const itemDelta = typeof st.prevScannedItems === 'number' ? st.scannedItems - st.prevScannedItems : null;
    const pageDelta = typeof st.prevPagesScanned === 'number' ? st.pagesScanned - st.prevPagesScanned : null;
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
      <span class="vineResetLink" id="vineResetLinkInline">Reset</span>`;

    updateScoreCard(st);
    requestAnimationFrame(syncPanelHeights);

    if (url.searchParams.get(NON_APPROVED_VIEW_PARAM) === '1') renderNonApprovedPage();
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderNonApprovedPage() {
    const existing = document.getElementById('vineNonApprovedPage');
    const map = loadAsinMap();

    const modifiable = Object.entries(map)
      .filter(([, r]) => r?.nonApproved && r.editability === 'modifiable')
      .sort((a, b) => (b[1].orderTs || 0) - (a[1].orderTs || 0));

    const nonModifiable = Object.entries(map)
      .filter(([, r]) => r?.nonApproved && r.editability === 'non-modifiable')
      .sort((a, b) => (b[1].orderTs || 0) - (a[1].orderTs || 0));

    const root = existing || document.createElement('div');
    root.id = 'vineNonApprovedPage';

    const productCell = (r) => {
      const title = escapeHtml(r.productTitle || 'Produit');
      return r.productUrl
        ? `<a href="${escapeHtml(r.productUrl)}" target="_blank" rel="noopener">${title}</a>`
        : title;
    };

    const imageCell = (r) => r.imageUrl
      ? `<img class="nap-img" src="${escapeHtml(r.imageUrl)}" alt="">`
      : '—';

    const modRows = modifiable.map(([, r]) => `
      <tr>
        <td>${imageCell(r)}</td>
        <td>${productCell(r)}</td>
        <td>${escapeHtml(r.orderDateText || '—')}</td>
        <td>${escapeHtml(r.reviewStatus || 'Non approuvé')}</td>
        <td>${r.modified ? '<span class="nap-modified">✓ Modifié</span>' : '—'}</td>
        <td><a class="nap-action" href="${escapeHtml(r.editUrl)}" target="_blank" rel="noopener">Modifier le commentaire</a></td>
      </tr>`).join('');

    const nonModRows = nonModifiable.map(([, r]) => `
      <tr>
        <td>${imageCell(r)}</td>
        <td>${productCell(r)}</td>
        <td>${escapeHtml(r.orderDateText || '—')}</td>
        <td>${escapeHtml(r.reviewStatus || 'Non approuvé')}</td>
        <td>${r.editUrl
          ? `<a class="nap-action nap-verify" href="${escapeHtml(r.editUrl)}" target="_blank" rel="noopener">Vérifier</a>`
          : '—'}</td>
      </tr>`).join('');

    root.innerHTML = `
      <div class="nap-head">
        <h2>Non approuvés</h2>
        <a class="nap-back" href="${normalReviewsUrl()}">← Retour aux avis</a>
      </div>

      <section class="nap-section">
        <h3>Modifiables — ${modifiable.length} ✏️</h3>
        ${modifiable.length ? `
          <div class="nap-table-wrap">
            <table>
              <thead><tr>
                <th>Image</th><th>Produit</th><th>Date de la commande</th>
                <th>Statut du commentaire</th><th>Modifié</th><th>Action</th>
              </tr></thead>
              <tbody>${modRows}</tbody>
            </table>
          </div>` : '<div class="nap-empty">Aucun commentaire modifiable.</div>'}
      </section>

      <div class="nap-separator"></div>

      <section class="nap-section">
        <h3>Non modifiables — ${nonModifiable.length} 🚫</h3>
        ${nonModifiable.length ? `
          <div class="nap-table-wrap">
            <table>
              <thead><tr>
                <th>Image</th><th>Produit</th><th>Date de la commande</th>
                <th>Statut du commentaire</th><th>Action</th>
              </tr></thead>
              <tbody>${nonModRows}</tbody>
            </table>
          </div>` : '<div class="nap-empty">Aucun commentaire non modifiable.</div>'}
      </section>`;

    if (!existing) {
      const wrapper = document.getElementById('vineEvalWrapper');
      wrapper?.insertAdjacentElement('afterend', root);

      document.querySelectorAll('.vvp-reviews-table, #vvp-reviews-table, ul.a-pagination').forEach(el => {
        if (!root.contains(el)) el.style.display = 'none';
      });
    }
  }

  let scanning = false;

  async function processFullScanEntries(entries, st, asinMap, status, pageNo) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      if (status && entry.nonApproved) {
        status.textContent = `Scan… page ${pageNo} | Non approuvé ${i + 1}/${entries.length}: contrôle…`;
      }

      const enriched = await enrichNonApproved(entry, null);
      asinMap[entry.key] = enriched;

      st.counts[entry.state] = (st.counts[entry.state] ?? 0) + 1;
      if (entry.approvalPending) st.pendingApproval += 1;
      st.scannedItems += 1;

      applyNonApprovedTotalsFromMap(st, asinMap);
      st.lastScanAt = new Date().toISOString();
      saveState(st);
      saveAsinMap(asinMap);
      render(st);
    }
  }

  async function scanAllPages() {
    const period = loadPeriod();
    const status = document.getElementById('vineEvalStatus');

    if (!period) {
      if (status) status.textContent = 'Période non définie. Va sur "Compte Vine".';
      return;
    }
    if (scanning) return;

    scanning = true;
    setBtnDisabled(true);
    if (status) {
      status.dataset.running = '1';
      status.textContent = 'Scan en cours…';
    }

    const prev = loadState();
    const st = emptyState();
    st.prevCounts = prev.counts ? { ...prev.counts } : null;
    st.prevPendingApproval = typeof prev.pendingApproval === 'number' ? prev.pendingApproval : null;
    st.prevScannedItems = prev.scannedItems ?? null;
    st.prevPagesScanned = prev.pagesScanned ?? null;
    st.prevScanAt = prev.lastScanAt ?? null;
    saveState(st);

    const asinMap = {};

    try {
      const lastPage = getLastPageFromDoc(document);
      const cap = Math.min(lastPage, 1000);

      let entries = extractEntriesFromDoc(document, period.startTs);
      if (!entries.length) {
        if (status) status.textContent = 'Aucune évaluation dans la période.';
        return;
      }

      st.pagesScanned = 1;
      await processFullScanEntries(entries, st, asinMap, status, 1);

      let emptyStreak = 0;

      for (let p = 2; p <= cap; p++) {
        if (status) status.textContent = `Scan… page ${p}/${cap}`;
        await paceBetweenPages();

        let doc = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const { text } = await httpGet(pageUrl(p));
            doc = new DOMParser().parseFromString(text, 'text/html');
            if (isValidReviewsDoc(doc) || !looksBlocked(doc)) break;
          } catch {}
          await sleep(1000 * attempt);
        }

        entries = extractEntriesFromDoc(doc, period.startTs);

        if (!entries.length) {
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
        st.pagesScanned += 1;
        await processFullScanEntries(entries, st, asinMap, status, p);
      }

      applyNonApprovedTotalsFromMap(st, asinMap);
      st.fullScanDone = true;
      st.lastScanAt = new Date().toISOString();
      saveAsinMap(asinMap);
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

  async function refreshPending() {
    const period = loadPeriod();
    if (!period || scanning) return;

    scanning = true;
    setBtnDisabled(true);

    const status = document.getElementById('vineEvalStatus');
    if (status) {
      status.dataset.running = '1';
      status.textContent = 'Refresh en cours…';
    }

    const st = loadState();
    const asinMap = loadAsinMap();
    let changes = 0;

    st.prevCounts = st.counts ? { ...st.counts } : emptyCounts();
    st.prevPendingApproval = typeof st.pendingApproval === 'number' ? st.pendingApproval : 0;
    st.prevScannedItems = typeof st.scannedItems === 'number' ? st.scannedItems : 0;
    st.prevPagesScanned = typeof st.pagesScanned === 'number' ? st.pagesScanned : 0;
    st.prevScanAt = st.lastScanAt ?? null;

    const pendingTargets = new Set(
      Object.entries(asinMap)
        .filter(([, v]) => v && (v.pending || v.approvalPending || v.nonApproved))
        .map(([key]) => key)
    );

    if (status) status.textContent = `Refresh en cours… cibles: ${pendingTargets.size}`;

    const seenThisRefresh = new Set();
    let outOfPeriodStreak = 0;

    try {
      let page = 1;
      const maxPagesFailsafe = 500;

      while (page <= maxPagesFailsafe && pendingTargets.size > 0 && outOfPeriodStreak < 2) {
        if (status) status.textContent = `Refresh… page ${page} | cibles: ${pendingTargets.size}`;

        let doc = page === 1 ? document : null;
        if (doc) {
          if (!isValidReviewsDoc(doc)) {
            status.textContent = looksBlocked(doc)
              ? 'Bloqué (captcha/login) page 1. Stop.'
              : 'Erreur: page 1 invalide. Stop.';
            break;
          }
        } else {
          await paceBetweenPages();
          doc = null;

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const { text } = await httpGet(pageUrl(page));
              const tmp = new DOMParser().parseFromString(text, 'text/html');
              if (isValidReviewsDoc(tmp)) {
                doc = tmp;
                break;
              }
              if (looksBlocked(tmp)) break;
            } catch {}
            await sleep(1000 * attempt);
          }

          if (!doc) {
            if (status) status.textContent = `Erreur: page ${page} invalide. Stop.`;
            break;
          }
        }

        if (!pageHasAnyInPeriod(doc, period.startTs)) {
          outOfPeriodStreak++;
          page++;
          continue;
        }
        outOfPeriodStreak = 0;

        const entries = extractEntriesFromDoc(doc, period.startTs);

        for (const entry of entries) {
          if (!entry.key || seenThisRefresh.has(entry.key)) continue;
          seenThisRefresh.add(entry.key);

          const old = asinMap[entry.key] || null;

          if (status && entry.nonApproved) {
            status.textContent = `Refresh… page ${page} | Non approuvé: contrôle…`;
          }

          const info = await enrichNonApproved(entry, old);

          if (old) {
            let changedThisItem = false;

            if (old.state !== info.state) {
              st.counts[old.state] = Math.max(0, (st.counts[old.state] ?? 0) - 1);
              st.counts[info.state] = (st.counts[info.state] ?? 0) + 1;
              changedThisItem = true;
            }

            if (!!old.approvalPending !== !!info.approvalPending) {
              st.pendingApproval = Math.max(
                0,
                (st.pendingApproval ?? 0) + (info.approvalPending ? 1 : -1)
              );
              changedThisItem = true;
            }

            if (
              !!old.nonApproved !== !!info.nonApproved ||
              old.editability !== info.editability ||
              old.editUrl !== info.editUrl ||
              old.reviewStatus !== info.reviewStatus
            ) {
              changedThisItem = true;
            }

            if (changedThisItem) changes++;
          } else {
            st.counts[info.state] = (st.counts[info.state] ?? 0) + 1;
            if (info.approvalPending) st.pendingApproval = (st.pendingApproval ?? 0) + 1;
            st.scannedItems = (st.scannedItems ?? 0) + 1;
            changes++;
          }

          asinMap[entry.key] = info;
          applyNonApprovedTotalsFromMap(st, asinMap);

          if (
            pendingTargets.has(entry.key) &&
            !info.pending &&
            !info.approvalPending &&
            !info.nonApproved
          ) {
            pendingTargets.delete(entry.key);
          } else if (pendingTargets.has(entry.key) && info.nonApproved) {
            pendingTargets.delete(entry.key);
          }

          saveAsinMap(asinMap);
          saveState(st);
          render(st);
        }

        page++;
      }

      applyNonApprovedTotalsFromMap(st, asinMap);
      st.lastScanAt = new Date().toISOString();
      saveAsinMap(asinMap);
      saveState(st);
      render(st);

      if (status) {
        if (pendingTargets.size === 0) {
          status.textContent = changes > 0
            ? `Mis à jour ! ${changes} changement${changes > 1 ? 's' : ''} | Cibles résolues`
            : 'Aucun changement | Cibles contrôlées';
        } else if (outOfPeriodStreak >= 2) {
          status.textContent = changes > 0
            ? `Stop (hors période). ${changes} changement${changes > 1 ? 's' : ''} | Cibles restantes: ${pendingTargets.size}`
            : `Stop (hors période). Cibles restantes: ${pendingTargets.size}`;
        } else if (!status.textContent || status.textContent === 'Refresh en cours…') {
          status.textContent = `Stop. Cibles restantes: ${pendingTargets.size}`;
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

  if (!mountUIOnce()) {
    const mo = new MutationObserver(() => {
      if (mountUIOnce()) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
  }
})();
