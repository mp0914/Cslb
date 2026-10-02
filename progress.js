/* progress.js — study tracking for the CSLB practice portal.
 *
 * Both practice tests run the same engine, so the tracking lives here once
 * instead of twice. A page hands over its question bank and category labels,
 * and this module owns everything else: stable question ids, the local store,
 * syncing to D1, the topic page (readiness, review, scores, topic cards), and
 * the missed-question review. The look lives in theme.css.
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

  var cfg = null;      // { exam, bank, labels, colors, icons, passMark, examName, fullCount, onStart, onRetest }
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

  /* ---------- DOM -------------------------------------------------------- */

  // All styling lives in theme.css; this file only builds markup.

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function icon(paths) {
    return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>';
  }

  var ARROW = icon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>');
  var BACK = icon('<path d="m15 18-6-6 6-6"/>');
  var CHEVRON = icon('<path d="m9 6 6 6-6 6"/>');
  var CHECK = icon('<path d="M20 6 9 17l-5-5"/>');
  var FALLBACK_ICON = '<circle cx="12" cy="12" r="8"/>';

  // Which topics the grid shows: 'all', 'work' (needs work) or 'fresh' (not started).
  var filter = 'all';

  function setView(v) { document.body.setAttribute('data-view', v); }

  function injectUI() {
    var hub = el('hub');
    if (!hub) return;

    var body = document.createElement('div');
    body.id = 'cslb-body';
    hub.appendChild(body);

    // The sync pill and its passphrase box sit in the page header.
    var slot = el('cslb-sync-slot');
    if (slot) {
      slot.innerHTML =
        '<button class="sync-pill" id="cslb-sync-pill" type="button" aria-haspopup="true">' +
          '<span class="dot"></span><span id="cslb-sync-text">Sync off</span>' +
        '</button>' +
        '<div class="sync-login" id="cslb-login">' +
          '<p>Turn on sync so your missed questions follow you between your phone and your computer.</p>' +
          '<div class="sync-login-row">' +
            '<input type="password" id="cslb-pass" placeholder="Passphrase" autocomplete="current-password" aria-label="Passphrase">' +
            '<button type="button" class="btn btn-lime" id="cslb-login-go">Turn on</button>' +
          '</div>' +
          '<div class="err" id="cslb-login-err"></div>' +
        '</div>';
      el('cslb-sync-pill').addEventListener('click', onPillClick);
      el('cslb-login-go').addEventListener('click', doLogin);
      el('cslb-pass').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doLogin();
      });
      document.addEventListener('click', function (e) {
        var box = el('cslb-login');
        if (box && box.classList.contains('show') && !slot.contains(e.target)) box.classList.remove('show');
      });
    }

    var review = document.createElement('main');
    review.id = 'cslb-review';
    review.className = 'wrap';
    hub.parentNode.insertBefore(review, hub.nextSibling);

    var navReview = el('nav-review');
    if (navReview) navReview.addEventListener('click', function () { showReview(); });
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
    pill.className = 'sync-pill';
    if (syncState === 'syncing') { pill.classList.add('busy'); text.textContent = 'Syncing'; }
    else if (syncState === 'idle') { pill.classList.add('ok'); text.textContent = 'Synced'; }
    else if (syncState === 'local') { pill.classList.add('warn'); text.textContent = 'Saved here'; }
    else { text.textContent = 'Sync off'; }
    pill.title = lastSyncError || (syncState === 'local' ? 'Saved on this device; it will sync when it can.' : '');
  }

  function paintNavBadge() {
    var b = el('nav-review-count');
    if (!b || !cfg) return;
    var n = outstandingQids(null).length;
    b.textContent = n;
    b.style.display = n ? '' : 'none';
  }

  /* ---------- hub -------------------------------------------------------- */

  // Where to start: the weakest topic once there is enough of a sample to
  // mean anything, else wherever misses are piling up, else the next topic
  // not yet touched.
  function startTopic(stats) {
    var sampled = stats.filter(function (s) { return s.answers >= 5 && s.accuracy !== null; });
    if (sampled.length) {
      sampled.sort(function (a, b) { return a.accuracy - b.accuracy; });
      return sampled[0];
    }
    var missed = stats.filter(function (s) { return s.outstanding > 0; })
      .sort(function (a, b) { return b.outstanding - a.outstanding; });
    if (missed.length) return missed[0];
    var fresh = stats.filter(function (s) { return !s.seen; });
    return fresh[0] || stats[0] || null;
  }

  function headline(o) {
    if (!o.answers) {
      return {
        h: 'Get a baseline',
        p: 'Take any topic and your readiness shows up here. Pass mark is ' + cfg.passMark + '%.'
      };
    }
    var gap = cfg.passMark - o.accuracy;
    var pts = function (n) { return n + (n === 1 ? ' point' : ' points'); };
    return {
      h: gap > 0 ? pts(gap) + ' from passing' : gap === 0 ? 'Right on the passing line' : pts(-gap) + ' over passing',
      p: 'Pass mark is ' + cfg.passMark + '%. Based on ' + o.seen + ' of ' + o.total + ' questions tried.'
    };
  }

  function needsWork(s) {
    return s.answers > 0 && (s.outstanding > 0 || s.accuracy < cfg.passMark);
  }

  function reviewTile(o) {
    var n = o.outstanding;
    if (!n) {
      return '<div class="card tile">' +
        '<div class="tile-head"><span>To review</span></div>' +
        '<span class="tile-num clear">0</span>' +
        '<p class="tile-note">' + (o.answers ? 'Every miss is cleared.' : 'Questions you miss land here.') + '</p>' +
        '</div>';
    }
    return '<div class="card tile">' +
      '<div class="tile-head"><span>To review</span><span class="tile-hint">clears after ' + MASTERY_STREAK + ' right in a row</span></div>' +
      '<span class="tile-num">' + n + '</span>' +
      '<div class="tile-actions">' +
        '<button type="button" class="btn btn-ghost" id="cslb-retest-btn">Retest them</button>' +
        '<button type="button" class="btn btn-ghost see-ans" id="cslb-review-btn">See answers</button>' +
      '</div>' +
      '</div>';
  }

  function scoresTile() {
    // Oldest on the left so the bars read as a trend.
    var hist = recentAttempts(6).reverse();
    var h = '<div class="card tile scores"><div class="tile-head"><span>Recent scores</span>' +
      (hist.length ? '<span class="tile-hint">last ' + hist.length + (hist.length === 1 ? ' quiz' : ' quizzes') + '</span>' : '') +
      '</div>';
    if (!hist.length) return h + '<p class="tile-note">Finish a quiz and your scores show up here.</p></div>';
    var pcts = hist.map(function (a) { return Math.round((a.correct / a.total) * 100); });
    h += '<div class="bars" style="--pass:' + cfg.passMark + '"><i class="bars-line"></i>';
    pcts.forEach(function (p, i) {
      h += '<span class="bar' + (p >= cfg.passMark ? ' pass' : '') + '" style="height:' + Math.max(p, 3) + '%" title="' +
        p + '% (' + hist[i].correct + ' of ' + hist[i].total + ')"></span>';
    });
    h += '</div><div class="bars-lbl">';
    pcts.forEach(function (p) {
      h += '<span' + (p >= cfg.passMark ? ' class="pass"' : '') + '>' + p + '</span>';
    });
    return h + '</div></div>';
  }

  function chip(key, label, n) {
    var on = filter === key;
    return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-filter="' + key + '" aria-pressed="' + on + '">' +
      label + ' <span>' + n + '</span></button>';
  }

  function topicCard(s) {
    var started = s.answers > 0;
    var tone = !started ? 'new' : (s.accuracy >= cfg.passMark ? 'good' : 'low');
    var badgeTone = !started ? 'new' : (s.outstanding ? 'low' : 'good');
    var status = !started ? 'Not started' : (s.outstanding ? s.outstanding + ' to review' : 'All clear');
    var meta = started ? s.seen + ' of ' + s.total + ' tried' : s.total + ' questions';
    return '<button type="button" class="topic ' + tone + '" data-start="' + esc(s.cat) + '" style="--c:' + esc(cfg.colors[s.cat] || '#7DA2FF') + '">' +
      '<span class="t-icon">' + icon(cfg.icons[s.cat] || FALLBACK_ICON) + '</span>' +
      '<span class="t-badge ' + badgeTone + '">' + status + '</span>' +
      '<span class="t-name">' + esc(cfg.labels[s.cat] || s.cat) + '</span>' +
      '<span class="t-meta">' + meta + '<span class="t-status ' + badgeTone + '"> · ' + status.toLowerCase() + '</span></span>' +
      '<span class="t-pct">' + (started ? s.accuracy + '%' : '--') + '</span>' +
      '<span class="t-pass">pass ' + cfg.passMark + '%</span>' +
      '<span class="t-bar"><i style="width:' + (started ? s.accuracy : 0) + '%"></i><b style="left:' + cfg.passMark + '%"></b></span>' +
      '</button>';
  }

  function topicsSection(stats) {
    // Weakest first, untouched topics at the bottom in bank order.
    var ordered = stats.slice().sort(function (a, b) {
      if (a.answers && b.answers) {
        if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
        return b.outstanding - a.outstanding;
      }
      if (a.answers) return -1;
      if (b.answers) return 1;
      return 0;
    });
    var fresh = function (s) { return !s.seen; };
    var shown = ordered.filter(function (s) {
      if (filter === 'work') return needsWork(s);
      if (filter === 'fresh') return fresh(s);
      return true;
    });

    var h = '<section class="topics"><div class="topics-head">' +
      '<div><h2>Topics</h2><p>Weakest first. Tap one to practice it.</p></div>' +
      '<div class="chips">' +
        chip('all', 'All', ordered.length) +
        chip('work', 'Needs work', ordered.filter(needsWork).length) +
        chip('fresh', 'Not started', ordered.filter(fresh).length) +
      '</div></div>';
    if (!shown.length) {
      h += '<div class="card empty-note">' +
        (filter === 'work' ? 'Nothing needs work right now.' : 'You have started every topic.') + '</div>';
    } else {
      h += '<div class="topic-grid">';
      shown.forEach(function (s) { h += topicCard(s); });
      h += '</div>';
    }
    return h + '</section>';
  }

  function render() {
    paintSyncPill();
    paintNavBadge();
    var body = el('cslb-body');
    if (!body || !cfg) return;

    var o = overall();
    var stats = catStats().filter(function (s) { return s.total; });
    var head = headline(o);
    var start = startTopic(stats);

    var html = '<section class="hero">' +
      '<div class="card ready">' +
        '<div class="ring" style="--pct:' + (o.accuracy || 0) + ';--pass:' + cfg.passMark + '">' +
          '<div class="ring-in"><span class="ring-num">' + (o.accuracy === null ? '--' : o.accuracy + '%') + '</span>' +
          '<span class="ring-lbl">readiness</span></div>' +
          '<div class="ring-tick" title="Pass mark ' + cfg.passMark + '%"><i></i></div>' +
        '</div>' +
        '<div class="ready-text">' +
          '<span class="eyebrow">' + esc(cfg.examName) + '</span>' +
          '<h1>' + esc(head.h) + '</h1>' +
          '<p>' + esc(head.p) + '</p>' +
        '</div>' +
        '<div class="ready-actions">' +
          (start ? '<button type="button" class="btn btn-lime btn-lg" data-start="' + esc(start.cat) + '"><span>Start with ' +
            esc(cfg.labels[start.cat] || start.cat) + '</span>' + ARROW + '</button>' : '') +
          '<button type="button" class="btn btn-ghost btn-lg" data-start="all">Full mixed exam · ' + cfg.fullCount + ' questions</button>' +
        '</div>' +
      '</div>' +
      '<div class="side">' + reviewTile(o) + scoresTile() + '</div>' +
      '</section>' +
      topicsSection(stats);

    body.innerHTML = html;

    Array.prototype.forEach.call(body.querySelectorAll('[data-start]'), function (b) {
      b.onclick = function () { cfg.onStart(b.getAttribute('data-start')); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-filter]'), function (b) {
      b.onclick = function () { filter = b.getAttribute('data-filter'); render(); };
    });
    var rt = el('cslb-retest-btn'), rv = el('cslb-review-btn');
    if (rt) rt.onclick = function () { cfg.onRetest(null); };
    if (rv) rv.onclick = function () { showReview(); };
  }

  /* ---------- missed-question review ------------------------------------ */

  function showReview() {
    var hub = el('hub'), quiz = el('quiz'), results = el('results'), review = el('cslb-review');
    if (hub) hub.style.display = 'none';
    if (quiz) quiz.style.display = 'none';
    if (results) results.style.display = 'none';
    if (!review) return;
    setView('review');

    var qids = outstandingQids(null);
    var groups = {};
    qids.forEach(function (qid) {
      var c = byId[qid].cat;
      (groups[c] = groups[c] || []).push(qid);
    });

    var html =
      '<div class="rev-head"><button type="button" class="icon-btn" id="cslb-rev-back" aria-label="Back to topics">' + BACK + '</button>' +
      '<h1>Missed questions</h1></div>' +
      '<p class="rev-sub">' + qids.length + ' question' + (qids.length === 1 ? '' : 's') +
      ' you have gotten wrong and not yet proven you know. Tap one to see the right answer and why. ' +
      'A question clears off this list once you get it right ' + MASTERY_STREAK + ' times in a row.</p>';

    if (!qids.length) {
      html += '<div class="card rev-empty"><span class="rev-empty-ic">' + CHECK + '</span>' +
        '<strong>Nothing to review</strong>' +
        '<span>Every question you have missed is cleared.</span></div>';
    } else {
      html += '<button class="btn btn-lime btn-lg btn-block" id="cslb-rev-retest-all" type="button">Retest all ' + qids.length + ARROW + '</button>';

      Object.keys(cfg.bank).forEach(function (c) {
        var list = groups[c];
        if (!list || !list.length) return;
        html += '<div class="rev-group" style="--c:' + esc(cfg.colors[c] || '#7DA2FF') + '"><div class="rev-group-head">' +
          '<span class="rev-group-name">' + esc(cfg.labels[c] || c) + ' · ' + list.length + '</span>' +
          '<button class="btn btn-ghost btn-sm" data-retest="' + esc(c) + '" type="button">Retest these</button>' +
          '</div>';

        list.forEach(function (qid) {
          var q = byId[qid], r = rec(qid);
          var near = r.streak === MASTERY_STREAK - 1;
          var badge = near ? '1 more to clear' : 'missed ' + r.wrong + (r.wrong === 1 ? ' time' : ' times');
          html += '<div class="rev-item">' +
            '<button class="rev-item-top" type="button" aria-expanded="false">' +
              '<span class="rev-q">' + esc(q.q) + '</span>' +
              '<span class="rev-badge' + (near ? ' near' : '') + '">' + badge + '</span>' +
              '<span class="rev-chev">' + CHEVRON + '</span>' +
            '</button><div class="rev-item-body">';
          ['A', 'B', 'C', 'D'].forEach(function (ltr, i) {
            if (q.opts[i] == null) return;
            var right = i === q.ans;
            html += '<div class="rev-ans' + (right ? ' right' : '') + '">' +
              '<span class="ltr">' + (right ? CHECK : ltr) + '</span><span class="txt">' + esc(q.opts[i]) + '</span></div>';
          });
          html += '<div class="rev-why"><strong>Why</strong>' + esc(q.exp) + '</div>';
          html += '</div></div>';
        });
        html += '</div>';
      });
    }

    review.innerHTML = html;
    review.style.display = 'block';
    window.scrollTo(0, 0);
    paintNavBadge();

    el('cslb-rev-back').onclick = hideReview;
    var all = el('cslb-rev-retest-all');
    if (all) all.onclick = function () { hideReview(); cfg.onRetest(null); };

    Array.prototype.forEach.call(review.querySelectorAll('[data-retest]'), function (b) {
      b.onclick = function () { hideReview(); cfg.onRetest(b.getAttribute('data-retest')); };
    });
    Array.prototype.forEach.call(review.querySelectorAll('.rev-item-top'), function (b) {
      b.onclick = function () {
        var open = b.parentNode.classList.toggle('open');
        b.setAttribute('aria-expanded', open);
      };
    });
  }

  function hideReview() {
    var review = el('cslb-review');
    if (review) { review.style.display = 'none'; review.innerHTML = ''; }
    var hub = el('hub');
    if (hub) hub.style.display = 'block';
    setView('hub');
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
      examName: options.examName || '',
      fullCount: options.fullCount || 100,
      icons: options.icons || {},
      onStart: options.onStart || function () {},
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
