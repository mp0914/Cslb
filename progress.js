/* progress.js — study tracking for the CSLB practice portal.
 *
 * Both practice tests run the same engine, so the tracking lives here once
 * instead of twice. A page hands over its question bank and category labels,
 * and this module owns everything else: stable question ids, the local store,
 * syncing to D1, the "what to study" panel, and the missed-question review.
 *
 * localStorage is the source of truth on the device. Every answer is written
 * there synchronously, so nothing is lost with no signal or a closed tab. The
 * sync to the worker is a push of the whole local store; the worker merges it
 * (counters take the max, state follows the newer answer) and hands back the
 * merged truth. That makes the same list of missed questions show up on any
 * device, and makes a failed sync harmless.
 */
(function () {
  'use strict';

  var API = 'https://cslb-api.matthew-13b.workers.dev';
  var STORE_KEY = 'cslb-progress-v1';
  var TOKEN_KEY = 'cslb-token';

  // How many correct answers in a row clear a question off the missed list.
  // One is too easy to hit by guessing.
  var MASTERY_STREAK = 2;

  var SYNC_DEBOUNCE_MS = 4000;

  var cfg = null;      // { exam, bank, labels, colors, passMark, onRetest }
  var byId = {};       // qid -> question object from the bank
  var store = null;
  var syncTimer = null;
  var syncState = 'off';
  var lastSyncError = '';

  /* ---------- stable question ids ---------------------------------------- */

  // The banks get edited often, so an array index would silently reassign a
  // history to a different question. Hash the text instead. Two different
  // 32-bit hashes concatenated make collisions across a few thousand
  // questions a non-issue, and it stays synchronous.
  //
  // The category is part of the hash because the same stem legitimately shows
  // up under two topics (the pre-1978 lead presumption is in both surface prep
  // and lead-safe work). Without it those two share one record, so missing one
  // marks the other missed and only one of them reaches the review screen. The
  // cost is that re-tagging a question starts its history over, which the
  // orphan prune in init() cleans up.
  function normalize(t) {
    return String(t == null ? '' : t).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function fnv1a(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function djb2(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  function pad8(n) {
    var s = n.toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  function qidFor(exam, cat, text) {
    var n = cat + '|' + normalize(text);
    return exam + ':' + pad8(fnv1a(n)) + pad8(djb2(n));
  }

  /* ---------- local store ------------------------------------------------ */

  function blankStore() {
    return { v: 1, progress: {}, attempts: [], pending: false };
  }

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.v === 1 && o.progress) {
          if (!Array.isArray(o.attempts)) o.attempts = [];
          return o;
        }
      }
    } catch (e) { /* private mode, blocked storage, corrupt JSON */ }
    return blankStore();
  }

  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
  }

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- queries ---------------------------------------------------- */

  function rec(qid) { return store.progress[qid] || null; }

  // Missed at least once and not yet proven known.
  function isOutstanding(r) {
    return !!r && r.wrong > 0 && r.streak < MASTERY_STREAK;
  }

  function examQids() {
    return Object.keys(byId);
  }

  // Worst first: most misses, then whichever has gone longest without a look.
  function outstandingQids(cat) {
    var list = [];
    examQids().forEach(function (qid) {
      var r = rec(qid);
      if (!isOutstanding(r)) return;
      if (cat && byId[qid].cat !== cat) return;
      list.push(qid);
    });
    list.sort(function (a, b) {
      var ra = rec(a), rb = rec(b);
      if (rb.wrong !== ra.wrong) return rb.wrong - ra.wrong;
      return ra.last_ms - rb.last_ms;
    });
    return list;
  }

  function catStats() {
    var cats = {};
    Object.keys(cfg.bank).forEach(function (c) {
      cats[c] = { cat: c, total: 0, seen: 0, answers: 0, wrong: 0, outstanding: 0, unseen: 0, mastered: 0 };
    });
    examQids().forEach(function (qid) {
      var s = cats[byId[qid].cat];
      if (!s) return;
      s.total++;
      var r = rec(qid);
      if (!r || !r.seen) { s.unseen++; return; }
      s.seen++;
      s.answers += r.seen;
      s.wrong += r.wrong;
      if (isOutstanding(r)) s.outstanding++;
      else s.mastered++;
    });
    return Object.keys(cats).map(function (c) {
      var s = cats[c];
      s.accuracy = s.answers ? Math.round(((s.answers - s.wrong) / s.answers) * 100) : null;
      return s;
    });
  }

  function overall() {
    var o = { total: 0, seen: 0, answers: 0, wrong: 0, outstanding: 0, unseen: 0 };
    examQids().forEach(function (qid) {
      o.total++;
      var r = rec(qid);
      if (!r || !r.seen) { o.unseen++; return; }
      o.seen++;
      o.answers += r.seen;
      o.wrong += r.wrong;
      if (isOutstanding(r)) o.outstanding++;
    });
    o.accuracy = o.answers ? Math.round(((o.answers - o.wrong) / o.answers) * 100) : null;
    return o;
  }

  function recentAttempts(n) {
    return store.attempts
      .filter(function (a) { return a.exam === cfg.exam; })
      .sort(function (a, b) { return b.ended_ms - a.ended_ms; })
      .slice(0, n || 5);
  }

  /* ---------- recording -------------------------------------------------- */

  function record(qid, cat, correct) {
    if (!qid || !cfg) return;
    var r = store.progress[qid];
    if (!r) {
      r = store.progress[qid] = { exam: cfg.exam, cat: cat, seen: 0, wrong: 0, streak: 0, last_ms: 0, last_ok: 0 };
    }
    r.exam = cfg.exam;
    if (cat) r.cat = cat;
    r.seen++;
    if (correct) { r.streak++; r.last_ok = 1; }
    else { r.wrong++; r.streak = 0; r.last_ok = 0; }
    r.last_ms = Date.now();
    store.pending = true;
    saveStore();
    scheduleSync();
  }

  function recordAttempt(mode, total, correct) {
    if (!total || !cfg) return;
    store.attempts.push({
      uid: uid(),
      exam: cfg.exam,
      mode: String(mode || 'all'),
      total: total,
      correct: correct,
      ended_ms: Date.now()
    });
    if (store.attempts.length > 400) store.attempts = store.attempts.slice(-400);
    store.pending = true;
    saveStore();
    scheduleSync();
  }

  /* ---------- sync ------------------------------------------------------- */

  function setSync(state, err) {
    syncState = state;
    lastSyncError = err || '';
    paintSyncPill();
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncTimer = null; syncNow(); }, SYNC_DEBOUNCE_MS);
  }

  function mergeDown(data) {
    // Server truth replaces local progress wholesale; it already merged in
    // whatever this device just pushed.
    var next = {};
    (data.progress || []).forEach(function (r) {
      next[r.qid] = {
        exam: r.exam,
        cat: r.cat,
        seen: r.seen,
        wrong: r.wrong,
        streak: r.streak,
        last_ms: r.last_ms,
        last_ok: r.last_ok ? 1 : 0
      };
    });
    store.progress = next;

    // Attempts are a union by uid, so a local one that fell outside the
    // server's return window is not thrown away.
    var seen = {};
    var merged = [];
    (data.attempts || []).concat(store.attempts).forEach(function (a) {
      if (!a || !a.uid || seen[a.uid]) return;
      seen[a.uid] = 1;
      merged.push(a);
    });
    merged.sort(function (a, b) { return b.ended_ms - a.ended_ms; });
    store.attempts = merged.slice(0, 400);

    store.pending = false;
    saveStore();
  }

  function syncNow() {
    var token = getToken();
    if (!token) { setSync('off'); return Promise.resolve(false); }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSync(store.pending ? 'local' : 'idle');
      return Promise.resolve(false);
    }
    setSync('syncing');

    var rows = Object.keys(store.progress).map(function (qid) {
      var r = store.progress[qid];
      return {
        qid: qid,
        exam: r.exam,
        cat: r.cat,
        seen: r.seen,
        wrong: r.wrong,
        streak: r.streak,
        last_ms: r.last_ms,
        last_ok: r.last_ok
      };
    });

    return fetch(API + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ progress: rows, attempts: store.attempts })
    }).then(function (res) {
      if (res.status === 401) { setToken(''); setSync('off'); return false; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (data) {
        mergeDown(data);
        setSync('idle');
        render();
        return true;
      });
    }).catch(function (e) {
      setSync('local', e && e.message ? e.message : 'failed');
      return false;
    });
  }

  function login(passphrase) {
    return fetch(API + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: passphrase })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.token) throw new Error(data.error || ('HTTP ' + res.status));
        setToken(data.token);
        return syncNow();
      });
    });
  }

  /* ---------- styles ----------------------------------------------------- */

  var CSS = [
    '.cslb-pill{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:700;',
    'padding:5px 11px;border-radius:20px;border:1px solid #2a2d3e;background:#161925;color:#6b7280;',
    'cursor:pointer;letter-spacing:.3px;transition:all .15s;font-family:inherit}',
    '.cslb-pill:hover{border-color:#3a3d50;color:#9ca3af}',
    '.cslb-pill .dot{width:7px;height:7px;border-radius:50%;background:#6b7280;flex-shrink:0}',
    '.cslb-pill.ok{color:#4ade80;border-color:#166534}.cslb-pill.ok .dot{background:#4ade80}',
    '.cslb-pill.busy{color:#60a5fa;border-color:#1e3a5f}.cslb-pill.busy .dot{background:#60a5fa}',
    '.cslb-pill.warn{color:#facc15;border-color:#854d0e}.cslb-pill.warn .dot{background:#facc15}',

    '.cslb-panel{background:#161925;border:1px solid #2a2d3e;border-radius:14px;padding:20px;margin-bottom:16px}',
    '.cslb-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}',
    '.cslb-panel h3{font-size:12px;font-weight:700;color:#9ca3af;letter-spacing:.6px;text-transform:uppercase;margin:0}',
    '.cslb-verdict{font-size:14px;color:#f0f2f8;line-height:1.5;margin-bottom:16px;font-weight:600}',
    '.cslb-verdict em{color:#facc15;font-style:normal;font-weight:700}',
    '.cslb-verdict.clear em{color:#4ade80}',

    '.cslb-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:18px}',
    '@media(max-width:560px){.cslb-tiles{grid-template-columns:repeat(2,1fr)}}',
    '.cslb-tile{background:#0f1117;border:1px solid #23263a;border-radius:10px;padding:12px 10px;text-align:center}',
    '.cslb-tile .n{font-size:21px;font-weight:800;color:#fff;line-height:1.1}',
    '.cslb-tile .l{font-size:9.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-top:5px;line-height:1.3}',
    '.cslb-tile.bad .n{color:#f87171}.cslb-tile.good .n{color:#4ade80}.cslb-tile.dim .n{color:#9ca3af}',

    '.cslb-row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:10px 0;border-bottom:1px solid #1f2235}',
    '.cslb-row:last-child{border-bottom:none}',
    '.cslb-row .name{font-size:12.5px;color:#d1d5db;font-weight:600}',
    '.cslb-row .num{font-size:12px;font-weight:700;color:#fff;white-space:nowrap;text-align:right}',
    '.cslb-row .num .sub{color:#6b7280;font-weight:600;font-size:11px}',
    '.cslb-row .bar{grid-column:1/-1;height:4px;background:#23263a;border-radius:4px;overflow:hidden}',
    '.cslb-row .bar span{display:block;height:100%;border-radius:4px}',
    '.cslb-row .meta{grid-column:1/-1;font-size:10.5px;color:#6b7280;margin-top:1px}',

    '.cslb-btn{display:block;width:100%;padding:14px;border-radius:12px;font-size:13.5px;font-weight:700;',
    'cursor:pointer;text-align:center;transition:all .15s;margin-top:10px;border:1px solid #2a2d3e;',
    'background:#161925;color:#d1d5db;font-family:inherit}',
    '.cslb-btn:hover{border-color:#3a3d50;color:#fff}',
    '.cslb-btn.primary{background:linear-gradient(135deg,#4c1d1d,#3b1616);border-color:#dc262655;color:#fca5a5}',
    '.cslb-btn.primary:hover{background:linear-gradient(135deg,#dc262633,#4c1d1d)}',
    '.cslb-btn:disabled{opacity:.45;cursor:default}',
    '.cslb-btn:disabled:hover{border-color:#2a2d3e;color:#d1d5db}',

    '#cslb-review{display:none;max-width:720px;margin:32px auto;padding:0 20px 80px}',
    '.cslb-rev-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}',
    '.cslb-rev-title{font-size:22px;font-weight:800;color:#fff}',
    '.cslb-rev-sub{color:#6b7280;font-size:12.5px;line-height:1.6;margin-bottom:22px}',
    '.cslb-group{margin-bottom:22px}',
    '.cslb-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}',
    '.cslb-group-name{font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}',
    '.cslb-group-retest{background:none;border:1px solid #2a2d3e;color:#9ca3af;font-size:10.5px;font-weight:700;',
    'padding:5px 10px;border-radius:7px;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap}',
    '.cslb-group-retest:hover{color:#fff;border-color:#3a3d50}',

    '.cslb-item{background:#161925;border:1px solid #2a2d3e;border-radius:12px;margin-bottom:9px;overflow:hidden}',
    '.cslb-item-top{display:flex;align-items:flex-start;gap:11px;padding:14px 16px;cursor:pointer;width:100%;',
    'background:none;border:none;text-align:left;font-family:inherit;transition:background .15s}',
    '.cslb-item-top:hover{background:#1a1d2e}',
    '.cslb-item-q{flex:1;font-size:13px;color:#e8eaf0;line-height:1.5;font-weight:600}',
    '.cslb-item-badge{font-size:9.5px;font-weight:700;color:#f87171;background:#2a0a0a;border:1px solid #dc262644;',
    'padding:3px 8px;border-radius:20px;white-space:nowrap;letter-spacing:.3px;flex-shrink:0;margin-top:1px}',
    '.cslb-item-badge.near{color:#facc15;background:#2a2109;border-color:#854d0e}',
    '.cslb-item-chev{color:#6b7280;font-size:11px;flex-shrink:0;margin-top:3px;transition:transform .18s}',
    '.cslb-item.open .cslb-item-chev{transform:rotate(90deg)}',
    '.cslb-item-body{display:none;padding:0 16px 16px}',
    '.cslb-item.open .cslb-item-body{display:block}',
    '.cslb-ans{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:9px;',
    'background:#0f1117;border:1px solid #23263a;margin-bottom:7px}',
    '.cslb-ans.right{background:#052e16;border-color:#16a34a}',
    '.cslb-ans .ltr{width:21px;height:21px;border-radius:50%;background:#2a2d3e;color:#9ca3af;font-size:10px;',
    'font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}',
    '.cslb-ans.right .ltr{background:#16a34a;color:#fff}',
    '.cslb-ans .txt{font-size:12.5px;color:#9ca3af;line-height:1.45}',
    '.cslb-ans.right .txt{color:#fff;font-weight:600}',
    '.cslb-why{margin-top:11px;padding:13px 15px;background:#0d1f3c;border:1px solid #1e3a5f;',
    'border-radius:10px;font-size:12px;color:#93c5fd;line-height:1.6}',
    '.cslb-why strong{color:#60a5fa}',
    '.cslb-empty{background:#161925;border:1px solid #2a2d3e;border-radius:12px;padding:34px 20px;text-align:center}',
    '.cslb-empty .big{font-size:32px;margin-bottom:10px;color:#4ade80}',
    '.cslb-empty .t{font-size:14px;color:#e8eaf0;font-weight:700;margin-bottom:6px}',
    '.cslb-empty .s{font-size:12px;color:#6b7280;line-height:1.6}',

    '.cslb-login{margin-top:12px;margin-bottom:16px;padding:14px;background:#0f1117;border:1px solid #23263a;border-radius:11px;display:none}',
    '.cslb-login.show{display:block}',
    '.cslb-login p{font-size:11.5px;color:#6b7280;line-height:1.5;margin-bottom:10px}',
    '.cslb-login-row{display:flex;gap:8px}',
    '.cslb-login input{flex:1;min-width:0;background:#161925;border:1px solid #2a2d3e;border-radius:9px;',
    'padding:10px 12px;color:#e8eaf0;font-size:13px;font-family:inherit}',
    '.cslb-login input:focus{outline:none;border-color:#1e3a5f}',
    '.cslb-login button{background:#1e3a5f;border:1px solid #1e40af55;color:#60a5fa;font-size:12.5px;',
    'font-weight:700;padding:10px 16px;border-radius:9px;cursor:pointer;font-family:inherit;white-space:nowrap}',
    '.cslb-login button:hover{background:#1e40af44}',
    '.cslb-login .err{font-size:11.5px;color:#f87171;margin-top:9px;display:none;line-height:1.5}',
    '.cslb-login .err.show{display:block}',

    '.cslb-hist{display:flex;gap:7px;flex-wrap:wrap}',
    '.cslb-hist span{font-size:11px;font-weight:700;padding:5px 10px;border-radius:7px;',
    'background:#0f1117;border:1px solid #23263a;color:#9ca3af}',
    '.cslb-hist span.p{color:#4ade80;border-color:#16a34a55}',
    '.cslb-hist span.f{color:#f87171;border-color:#dc262655}'
  ].join('');

  /* ---------- DOM -------------------------------------------------------- */

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function injectUI() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var hub = el('hub');
    if (!hub) return;

    var mount = document.createElement('div');
    mount.id = 'cslb-mount';
    mount.innerHTML =
      '<div class="cslb-panel">' +
        '<div class="cslb-panel-head">' +
          '<h3>What To Study</h3>' +
          '<button class="cslb-pill" id="cslb-sync-pill" type="button"><span class="dot"></span><span id="cslb-sync-text">Sync off</span></button>' +
        '</div>' +
        '<div class="cslb-login" id="cslb-login">' +
          '<p>Turn on sync so your missed questions follow you between your phone and your computer.</p>' +
          '<div class="cslb-login-row">' +
            '<input type="password" id="cslb-pass" placeholder="Passphrase" autocomplete="current-password">' +
            '<button type="button" id="cslb-login-go">Turn on</button>' +
          '</div>' +
          '<div class="err" id="cslb-login-err"></div>' +
        '</div>' +
        '<div id="cslb-body"></div>' +
      '</div>';

    // Sits directly above the category grid, under the hub intro copy.
    var grid = hub.querySelector('.category-grid');
    if (grid) hub.insertBefore(mount, grid);
    else hub.appendChild(mount);

    var review = document.createElement('div');
    review.id = 'cslb-review';
    document.body.appendChild(review);

    el('cslb-sync-pill').addEventListener('click', onPillClick);
    el('cslb-login-go').addEventListener('click', doLogin);
    el('cslb-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
  }

  function onPillClick() {
    if (getToken()) { syncNow(); return; }
    var box = el('cslb-login');
    if (!box) return;
    box.classList.toggle('show');
    if (box.classList.contains('show')) el('cslb-pass').focus();
  }

  function doLogin() {
    var input = el('cslb-pass');
    var err = el('cslb-login-err');
    var btn = el('cslb-login-go');
    if (!input || !input.value) return;
    btn.disabled = true;
    err.classList.remove('show');
    setSync('syncing');
    login(input.value).then(function () {
      input.value = '';
      btn.disabled = false;
      el('cslb-login').classList.remove('show');
      render();
    }).catch(function (e) {
      btn.disabled = false;
      setSync('off');
      var msg = e && e.message;
      err.textContent =
        msg === 'Wrong passphrase' ? 'Wrong passphrase.' :
        msg === 'Server not configured' ? 'Sync is not set up on the server yet.' :
        'Could not reach the server. Your progress is still saved on this device.';
      err.classList.add('show');
    });
  }

  function paintSyncPill() {
    var pill = el('cslb-sync-pill'), text = el('cslb-sync-text');
    if (!pill || !text) return;
    pill.className = 'cslb-pill';
    if (syncState === 'syncing') { pill.classList.add('busy'); text.textContent = 'Syncing...'; }
    else if (syncState === 'idle') { pill.classList.add('ok'); text.textContent = 'Synced'; }
    else if (syncState === 'local') { pill.classList.add('warn'); text.textContent = 'Saved on this device'; }
    else { text.textContent = 'Sync off'; }
    pill.title = lastSyncError || '';
  }

  function tile(n, label, cls) {
    return '<div class="cslb-tile ' + (cls || '') + '"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
  }

  function verdictLine(o, stats) {
    if (!o.answers) {
      return '<div class="cslb-verdict">Nothing tracked yet. Take any section and every question you miss lands here.</div>';
    }
    if (!o.outstanding) {
      var left = o.unseen;
      return '<div class="cslb-verdict clear">Nothing outstanding &mdash; <em>you have cleared every question you missed</em>.' +
        (left ? ' ' + left + ' question' + (left === 1 ? '' : 's') + ' you have not seen yet.' : '') + '</div>';
    }
    // Weakest category by accuracy, once there is enough of a sample to mean
    // anything; otherwise just point at wherever the misses are piled up.
    var pool = stats.filter(function (s) { return s.answers >= 5 && s.accuracy !== null; });
    var worst;
    if (pool.length) {
      pool.sort(function (a, b) { return a.accuracy - b.accuracy; });
      worst = pool[0];
    } else {
      worst = stats.filter(function (s) { return s.outstanding > 0; })
        .sort(function (a, b) { return b.outstanding - a.outstanding; })[0];
    }
    if (!worst) return '<div class="cslb-verdict">' + o.outstanding + ' questions to review.</div>';
    var name = cfg.labels[worst.cat] || worst.cat;
    var detail = worst.accuracy !== null
      ? worst.accuracy + '% correct, ' + worst.outstanding + ' to review'
      : worst.outstanding + ' to review';
    return '<div class="cslb-verdict">Start here: <em>' + esc(name) + '</em> &mdash; ' + detail + '.</div>';
  }

  function render() {
    paintSyncPill();
    var body = el('cslb-body');
    if (!body || !cfg) return;

    var o = overall();
    var stats = catStats();
    var hist = recentAttempts(5);

    var html = verdictLine(o, stats);

    html += '<div class="cslb-tiles">' +
      tile(o.outstanding, 'To review', o.outstanding ? 'bad' : 'good') +
      tile(o.accuracy === null ? '--' : o.accuracy + '%', 'Accuracy',
           o.accuracy === null ? 'dim' : (o.accuracy >= cfg.passMark ? 'good' : 'bad')) +
      tile(o.seen, 'Questions tried', 'dim') +
      tile(o.unseen, 'Not seen yet', 'dim') +
      '</div>';

    // Weakest first, but keep untouched categories at the bottom.
    var ordered = stats.slice().sort(function (a, b) {
      if (a.answers && b.answers) {
        if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
        return b.outstanding - a.outstanding;
      }
      if (a.answers) return -1;
      if (b.answers) return 1;
      return 0;
    });

    ordered.forEach(function (s) {
      var color = cfg.colors[s.cat] || '#60a5fa';
      var pct = s.accuracy === null ? 0 : s.accuracy;
      var num = s.accuracy === null
        ? '<span class="sub">not started</span>'
        : s.accuracy + '% <span class="sub">of ' + s.answers + '</span>';
      var waiting = s.total === 1 ? '1 question waiting' : s.total + ' questions waiting';
      var meta = s.outstanding
        ? s.outstanding + ' to review &middot; ' + s.unseen + ' of ' + s.total + ' not seen'
        : (s.seen ? 'nothing outstanding &middot; ' + s.unseen + ' of ' + s.total + ' not seen'
                  : waiting);
      html += '<div class="cslb-row">' +
        '<div class="name">' + esc(cfg.labels[s.cat] || s.cat) + '</div>' +
        '<div class="num">' + num + '</div>' +
        '<div class="bar"><span style="width:' + pct + '%;background:' + color + '"></span></div>' +
        '<div class="meta">' + meta + '</div>' +
        '</div>';
    });

    if (hist.length) {
      html += '<div class="cslb-panel-head" style="margin-top:18px"><h3>Recent Scores</h3></div><div class="cslb-hist">';
      hist.forEach(function (a) {
        var p = Math.round((a.correct / a.total) * 100);
        html += '<span class="' + (p >= cfg.passMark ? 'p' : 'f') + '">' + p +
          '% <span style="color:#6b7280">' + a.correct + '/' + a.total + '</span></span>';
      });
      html += '</div>';
    }

    html += '<button class="cslb-btn primary" id="cslb-retest-btn" type="button"></button>' +
            '<button class="cslb-btn" id="cslb-review-btn" type="button"></button>';

    body.innerHTML = html;

    var n = o.outstanding;
    var rt = el('cslb-retest-btn'), rv = el('cslb-review-btn');
    rt.textContent = n ? 'Retest Missed Questions (' + n + ')' : 'Nothing to retest';
    rt.disabled = !n;
    rt.onclick = function () { if (n) cfg.onRetest(null); };
    rv.textContent = n ? 'Review Missed Questions (' + n + ')' : 'No missed questions to review';
    rv.disabled = !n;
    rv.onclick = function () { if (n) showReview(); };
  }

  /* ---------- missed-question review ------------------------------------ */

  function showReview() {
    var hub = el('hub'), quiz = el('quiz'), results = el('results'), review = el('cslb-review');
    if (hub) hub.style.display = 'none';
    if (quiz) quiz.style.display = 'none';
    if (results) results.style.display = 'none';
    if (!review) return;

    var qids = outstandingQids(null);
    var groups = {};
    qids.forEach(function (qid) {
      var c = byId[qid].cat;
      (groups[c] = groups[c] || []).push(qid);
    });

    var html =
      '<div class="cslb-rev-head"><div class="cslb-rev-title">Missed Questions</div>' +
      '<button class="cslb-group-retest" id="cslb-rev-back" type="button">&larr; Back</button></div>' +
      '<div class="cslb-rev-sub">' + qids.length + ' question' + (qids.length === 1 ? '' : 's') +
      ' you have gotten wrong and not yet proven you know. Tap one to see the right answer and why. ' +
      'A question clears off this list once you get it right ' + MASTERY_STREAK + ' times in a row.</div>';

    if (!qids.length) {
      html += '<div class="cslb-empty"><div class="big">&#10003;</div>' +
        '<div class="t">Nothing to review</div>' +
        '<div class="s">Every question you have missed is cleared.</div></div>';
    } else {
      html += '<button class="cslb-btn primary" id="cslb-rev-retest-all" type="button">Retest All ' + qids.length + '</button>';

      Object.keys(cfg.bank).forEach(function (c) {
        var list = groups[c];
        if (!list || !list.length) return;
        var color = cfg.colors[c] || '#60a5fa';
        html += '<div class="cslb-group"><div class="cslb-group-head">' +
          '<div class="cslb-group-name" style="color:' + color + '">' +
          esc(cfg.labels[c] || c) + ' &middot; ' + list.length + '</div>' +
          '<button class="cslb-group-retest" data-retest="' + esc(c) + '" type="button">Retest these</button>' +
          '</div>';

        list.forEach(function (qid) {
          var q = byId[qid], r = rec(qid);
          var near = r.streak === MASTERY_STREAK - 1;
          var badge = near ? '1 more to clear'
                           : 'missed ' + r.wrong + (r.wrong === 1 ? ' time' : ' times');
          html += '<div class="cslb-item" data-qid="' + esc(qid) + '">' +
            '<button class="cslb-item-top" type="button">' +
              '<span class="cslb-item-chev">&#9656;</span>' +
              '<span class="cslb-item-q">' + esc(q.q) + '</span>' +
              '<span class="cslb-item-badge' + (near ? ' near' : '') + '">' + badge + '</span>' +
            '</button><div class="cslb-item-body">';
          ['A', 'B', 'C', 'D'].forEach(function (ltr, i) {
            if (q.opts[i] == null) return;
            var right = i === q.ans;
            html += '<div class="cslb-ans' + (right ? ' right' : '') + '">' +
              '<span class="ltr">' + ltr + '</span><span class="txt">' + esc(q.opts[i]) + '</span></div>';
          });
          html += '<div class="cslb-why"><strong>Why:</strong> ' + esc(q.exp) + '</div>';
          html += '</div></div>';
        });
        html += '</div>';
      });
    }

    review.innerHTML = html;
    review.style.display = 'block';
    window.scrollTo(0, 0);

    el('cslb-rev-back').onclick = hideReview;
    var all = el('cslb-rev-retest-all');
    if (all) all.onclick = function () { hideReview(); cfg.onRetest(null); };

    Array.prototype.forEach.call(review.querySelectorAll('[data-retest]'), function (b) {
      b.onclick = function () { hideReview(); cfg.onRetest(b.getAttribute('data-retest')); };
    });
    Array.prototype.forEach.call(review.querySelectorAll('.cslb-item-top'), function (b) {
      b.onclick = function () { b.parentNode.classList.toggle('open'); };
    });
  }

  function hideReview() {
    var review = el('cslb-review');
    if (review) { review.style.display = 'none'; review.innerHTML = ''; }
    var hub = el('hub');
    if (hub) hub.style.display = 'block';
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- public ----------------------------------------------------- */

  function init(options) {
    cfg = {
      exam: options.exam,
      bank: options.bank,
      labels: options.labels || {},
      colors: options.colors || {},
      passMark: options.passMark || 70,
      onRetest: options.onRetest || function () {}
    };
    store = loadStore();

    // Tag every question in the bank with its id, and build the lookup the
    // review screen reads from.
    byId = {};
    Object.keys(cfg.bank).forEach(function (c) {
      (cfg.bank[c] || []).forEach(function (q) {
        var id = qidFor(cfg.exam, c, q.q);
        q.__qid = id;
        if (!q.cat) q.cat = c;
        byId[id] = q;
      });
    });

    // An edited or deleted question leaves an orphan record behind. Drop it so
    // the counts on screen always match the bank that is actually loaded.
    var changed = false;
    Object.keys(store.progress).forEach(function (qid) {
      if (store.progress[qid].exam === cfg.exam && !byId[qid]) {
        delete store.progress[qid];
        changed = true;
      }
    });
    if (changed) { store.pending = true; saveStore(); }

    injectUI();
    setSync(getToken() ? (store.pending ? 'local' : 'idle') : 'off');
    render();

    if (getToken()) syncNow();

    window.addEventListener('online', function () { if (store.pending) syncNow(); });
    // Last chance to get a finished quiz up before the tab goes away.
    window.addEventListener('pagehide', function () {
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; syncNow(); }
    });
  }

  // Questions to retest: worst first, so a short session still hits the
  // weakest ones. `cat` limits it to one category.
  function retestQuestions(cat) {
    return outstandingQids(cat).map(function (qid) {
      var q = byId[qid], copy = {};
      Object.keys(q).forEach(function (k) { copy[k] = q[k]; });
      return copy;
    });
  }

  window.CSLB = {
    init: init,
    record: record,
    recordAttempt: recordAttempt,
    retestQuestions: retestQuestions,
    outstandingCount: function () { return outstandingQids(null).length; },
    onHub: function () { hideReview(); },
    refresh: render,
    syncNow: syncNow
  };
})();
