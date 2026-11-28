/* 異能スレ アーカイブ ビューア - 静的サイト用(GitHub Pages) */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var app = $('#app');
  var ORIGIN_BOARD = 'https://bbs.animanch.com/board/';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) { return Number(n).toLocaleString('ja-JP'); }
  function parseTs(s) {
    var m = /(\d\d)\/(\d\d)\/(\d\d).*?(\d\d):(\d\d):(\d\d)/.exec(s || '');
    if (!m) return 0;
    return Date.parse('20' + m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+09:00');
  }
  function fmtDate(ms) {
    if (!ms) return '-';
    var d = new Date(ms + 9 * 3600 * 1000);
    return d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0');
  }

  /* ---------- テーマ ---------- */
  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var cb = $('#darkmode'); if (cb) cb.checked = dark;
  }
  (function initTheme() {
    var dark = false;
    try {
      var v = localStorage.getItem('isou_theme');
      dark = v ? v === 'dark' : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {}
    applyTheme(dark);
    $('#darkmode').addEventListener('change', function (e) {
      applyTheme(e.target.checked);
      try { localStorage.setItem('isou_theme', e.target.checked ? 'dark' : 'light'); } catch (err) {}
    });
  })();

  /* ---------- データ ---------- */
  var manifest = null;
  var byId = new Map();
  var byNumber = new Map();
  var memCache = new Map();   // id -> データ
  var normCache = new Map();  // id -> 検索用に正規化した文字列

  function norm(s) { return String(s || '').normalize('NFKC').toLowerCase(); }

  // IndexedDB(2回目以降の検索を速くするための保存場所)。使えなくても動く
  var dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      try {
        var req = indexedDB.open('isou-archive', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('threads', { keyPath: 'id' }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  function idbGet(id) {
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var r = db.transaction('threads').objectStore('threads').get(id);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }
  function idbPut(rec) {
    return openDB().then(function (db) {
      if (!db) return;
      try { db.transaction('threads', 'readwrite').objectStore('threads').put(rec); } catch (e) {}
    });
  }
  function sigOf(t) { return t.bytes + ':' + t.savedAt; }

  function getThread(id) {
    if (memCache.has(id)) return Promise.resolve(memCache.get(id));
    var t = byId.get(id);
    if (!t) return Promise.reject(new Error('スレが見つかりません: ' + id));
    return idbGet(id).then(function (rec) {
      if (rec && rec.sig === sigOf(t)) { memCache.set(id, rec.data); return rec.data; }
      return fetch('data/' + t.file).then(function (r) {
        if (!r.ok) throw new Error('読み込み失敗: ' + t.file);
        return r.json();
      }).then(function (data) {
        memCache.set(id, data);
        idbPut({ id: id, sig: sigOf(t), data: data });
        return data;
      });
    });
  }
  function getNorm(id, data) {
    var c = normCache.get(id);
    if (c) return c;
    c = { t: data.posts.map(function (p) { return norm(p.text); }), n: data.posts.map(function (p) { return norm(p.name); }) };
    normCache.set(id, c);
    return c;
  }

  /* ---------- 文字の整形 ---------- */
  function normMap(s) {
    var n = '', map = [];
    for (var i = 0; i < s.length;) {
      var cp = s.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      var nc = ch.normalize('NFKC').toLowerCase();
      for (var k = 0; k < nc.length; k++) map.push(i);
      n += nc;
      i += ch.length;
    }
    map.push(s.length);
    return { n: n, map: map };
  }
  function highlight(raw, terms) {
    if (!terms || !terms.length || !raw) return esc(raw);
    var nm = normMap(raw), ranges = [];
    terms.forEach(function (t) {
      if (!t) return;
      var from = 0, idx;
      while ((idx = nm.n.indexOf(t, from)) >= 0) {
        ranges.push([nm.map[idx], nm.map[Math.min(idx + t.length, nm.map.length - 1)]]);
        from = idx + t.length;
      }
    });
    if (!ranges.length) return esc(raw);
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    ranges.forEach(function (r) {
      if (r[1] <= pos) return;
      var s = Math.max(r[0], pos);
      out += esc(raw.slice(pos, s)) + '<mark>' + esc(raw.slice(s, r[1])) + '</mark>';
      pos = r[1];
    });
    return out + esc(raw.slice(pos));
  }
  // あにまんのスレURLが、このアーカイブに保存済みなら、アーカイブ内の移動先を返す
  function archiveRoute(href) {
    var m = /^https?:\/\/bbs\.animanch\.com\/board\/(\d+)\/?(?:\?[^#]*?\bres=(\d+))?/.exec(href || '');
    if (!m || !byId.has(m[1])) return null;
    return { id: m[1], res: m[2] ? parseInt(m[2], 10) : null };
  }
  function anchorFor(href, innerHTML, cls, curTid) {
    var r = archiveRoute(href);
    if (r) {
      return '<a class="' + cls + ' internal" href="#/t/' + r.id + (r.res ? '/' + r.res : '') + '"' +
        (r.res ? ' data-t="' + r.id + '" data-res="' + r.res + '"' : '') + '>' + innerHTML + '</a>';
    }
    return '<a class="' + cls + '" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + innerHTML + '</a>';
  }
  // 「タイトル｜あにまん掲示板説明文…bbs.animanch.com」のようなリンクカードの文字を、見やすい形にする
  function cardHTML(link, curTid) {
    var t = String(link.text || ''), href = link.href;
    var domain = '';
    var dm = /(bbs\.animanch\.com|w\.atwiki\.jp|[a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(t);
    if (dm && t.length > dm[0].length) { domain = dm[1]; t = t.slice(0, dm.index); }
    var title = t, desc = '';
    var k = t.indexOf('｜あにまん掲示板');
    if (k >= 0) { title = t.slice(0, k + '｜あにまん掲示板'.length); desc = t.slice(k + '｜あにまん掲示板'.length); }
    else if (t.length > 60) { title = t.slice(0, 40); desc = t.slice(40); }
    var inner = '<span class="lc-title">' + esc(title) + '</span>' +
      (desc ? '<span class="lc-desc">' + esc(desc) + '</span>' : '') +
      '<span class="lc-url">' + esc(domain || href) + (archiveRoute(href) ? ' (アーカイブ内で開く)' : '') + '</span>';
    return anchorFor(href, inner, 'linkcard', curTid);
  }
  function inline(raw, tid, terms, links) {
    var re = /(https?:\/\/[^\s<>"\u0001]+)|(>>(\d+))|\u0001(\d+)\u0001/g, out = '', last = 0, m;
    while ((m = re.exec(raw))) {
      out += highlight(raw.slice(last, m.index), terms);
      if (m[1]) {
        out += anchorFor(m[1], esc(m[1]), 'extlink', tid);
      } else if (m[4] !== undefined) {
        var lk = links && links[parseInt(m[4], 10)];
        out += lk ? cardHTML(lk, tid) : '';
      } else {
        out += '<a class="reslink" data-t="' + esc(tid) + '" data-res="' + m[3] + '" href="#/t/' + esc(tid) + '/' + m[3] + '">&gt;&gt;' + m[3] + '</a>';
      }
      last = m.index + m[0].length;
    }
    return out + highlight(raw.slice(last), terms);
  }
  function bodyHTML(p, tid, terms) {
    var cls = p.deleted ? 'disabled' : (p.cls || 'nomal');
    // リンクカードの文字を目印に置き換えてから、行ごとに整形する
    var text = String(p.text || '');
    var links = p.links || [];
    links.forEach(function (lk, i) {
      if (lk.text && lk.text.length > 3 && text.indexOf(lk.text) >= 0) text = text.split(lk.text).join('\u0001' + i + '\u0001');
    });
    var lines = text.split('\n');
    var html = lines.map(function (ln) {
      return ln === '' ? '<p><br></p>' : '<p>' + inline(ln, tid, terms, links) + '</p>';
    }).join('');
    var imgs = '';
    if (p.images && p.images.length) {
      imgs = '<div class="thumbs">' + p.images.map(function (im) {
        return '<a class="thumb" href="' + esc(im.full) + '" target="_blank" rel="noopener noreferrer">' +
          '<img src="' + esc(im.thumb || im.full) + '" loading="lazy" referrerpolicy="no-referrer" alt=""></a>';
      }).join('') + '</div>';
    }
    var rep = '';
    if (p.repliedBy && p.repliedBy.length) {
      rep = '<div class="replies">' + p.repliedBy.map(function (n) {
        return '<a class="reslink" data-t="' + esc(tid) + '" data-res="' + n + '" href="#/t/' + esc(tid) + '/' + n + '">&gt;&gt;' + n + '</a>';
      }).join('') + '</div>';
    }
    return '<div class="resbody ' + esc(cls) + '">' + html + imgs + rep + '</div>';
  }
  function headerHTML(p, extra) {
    return '<div class="resheader">' + (extra || '') +
      '<span class="resnumber">≫' + p.no + '</span>' +
      '<span class="resname">' + esc(p.name) + '</span>' +
      '<span class="resposted">' + esc(p.posted) + '</span>' +
      '<span class="heart' + (p.likes ? '' : ' zero') + '">♡ ' + (p.likes || 0) + '</span></div>';
  }

  /* ---------- ルーティング ---------- */
  var currentRoute = null;
  function navigate(route) {
    if (route === currentRoute) { show(route); return; }
    currentRoute = route;
    try { if (location.hash.slice(1) !== route) location.hash = route; } catch (e) {}
    show(route);
  }
  window.addEventListener('hashchange', function () {
    var r = location.hash.slice(1);
    if (r === currentRoute) return;
    currentRoute = r;
    show(r);
  });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#/"]');
    if (!a) return;
    e.preventDefault();
    hidePopup();
    var rs = a.getAttribute('data-res');
    if (rs && view && a.getAttribute('data-t') === view.id) { scrollToRes(parseInt(rs, 10)); return; }
    navigate(a.getAttribute('href').slice(1));
  });

  var searchToken = 0;
  function show(route) {
    searchToken++;           // 実行中の検索を止める
    hidePopup();
    route = route || '/';
    var qi = route.indexOf('?');
    var path = qi >= 0 ? route.slice(0, qi) : route;
    var params = new URLSearchParams(qi >= 0 ? route.slice(qi + 1) : '');
    var m;
    if ((m = /^\/t\/(\d+)(?:\/(\d+))?$/.exec(path))) renderThread(m[1], m[2] ? parseInt(m[2], 10) : null);
    else if (path === '/s') renderSearch(params);
    else renderHome();
    if (!(m && m[2])) window.scrollTo(0, 0);
  }

  /* ---------- ホーム(スレ一覧) ---------- */
  var listState = { key: 'number', dir: -1, filter: '' };
  var COLS = [
    { key: 'number', label: 'スレ番号', num: true },
    { key: 'title', label: 'タイトル' },
    { key: 'count', label: 'レス', num: true },
    { key: 'images', label: '画像', num: true, sm: true },
    { key: 'firstTs', label: '開始', sm: true, nosort: true },
    { key: 'lastTs', label: '最終レス', sm: true, nosort: true }
  ];
  var SORT_LABELS = { number: 'スレ番号', count: 'レス数', images: '画像数' };

  function renderHome() {
    document.title = '異能スレ アーカイブ';
    var th = manifest.threads;
    var totalImgs = th.reduce(function (a, t) { return a + t.images; }, 0);
    var h = '<h1 class="title">ここだけ異能のある世界 アーカイブ</h1>';
    h += '<div class="panel-box stats">' +
      '<span>保存済みスレ <b>' + fmtNum(th.length) + '</b></span>' +
      '<span>画像 <b>' + fmtNum(totalImgs) + '</b></span></div>';

    h += '<div class="controls">' +
      '<label>並び替え <select id="ls-key">' + Object.keys(SORT_LABELS).map(function (k) {
        return '<option value="' + k + '"' + (listState.key === k ? ' selected' : '') + '>' + SORT_LABELS[k] + '</option>';
      }).join('') + '</select></label>' +
      '<label><select id="ls-dir"><option value="-1"' + (listState.dir < 0 ? ' selected' : '') + '>大きい・新しい順 ▼</option><option value="1"' + (listState.dir > 0 ? ' selected' : '') + '>小さい・古い順 ▲</option></select></label>' +
      '<label>絞り込み <input type="text" id="ls-filter" placeholder="番号やタイトル" value="' + esc(listState.filter) + '"></label>' +
      '<span class="muted" id="ls-count"></span></div>';
    h += '<table class="threads"><thead><tr id="ls-head"></tr></thead><tbody id="ls-body"></tbody></table>';
    app.innerHTML = h;

    $('#ls-key').onchange = function (e) { listState.key = e.target.value; drawList(); };
    $('#ls-dir').onchange = function (e) { listState.dir = parseInt(e.target.value, 10); drawList(); };
    $('#ls-filter').oninput = function (e) { listState.filter = e.target.value; drawList(); };
    drawList();
  }
  function drawList() {
    var f = norm(listState.filter).trim();
    var rows = manifest.threads.filter(function (t) { return !f || norm(t.title + ' ' + t.number).indexOf(f) >= 0; });
    var k = listState.key, d = listState.dir;
    rows = rows.slice().sort(function (a, b) {
      var x = a[k], y = b[k];
      if (typeof x === 'string') return d * x.localeCompare(y, 'ja');
      return d * ((x || 0) - (y || 0)) || (b.number - a.number);
    });
    $('#ls-head').innerHTML = COLS.map(function (c) {
      var cls = (c.num ? 'num ' : '') + (c.sm ? 'hide-sm ' : '') + (c.key === k ? 'sorted' + (d > 0 ? ' asc' : '') : '');
      return '<th data-k="' + c.key + '" class="' + cls + '">' + c.label + '</th>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#ls-head th'), function (th) {
      var key0 = th.getAttribute('data-k');
      if (key0 === 'firstTs' || key0 === 'lastTs') { th.style.cursor = 'default'; return; }
      th.onclick = function () {
        var key = th.getAttribute('data-k');
        if (listState.key === key) listState.dir = -listState.dir; else { listState.key = key; listState.dir = key === 'title' ? 1 : -1; }
        $('#ls-key').value = SORT_LABELS[listState.key] ? listState.key : $('#ls-key').value;
        $('#ls-dir').value = String(listState.dir);
        drawList();
      };
    });
    $('#ls-body').innerHTML = rows.map(function (t) {
      return '<tr><td class="num">' + t.number + '</td>' +
        '<td><a class="t-title" href="#/t/' + t.id + '">' + esc(t.title) + '</a></td>' +
        '<td class="num">' + t.count + '</td>' +
        '<td class="num hide-sm">' + t.images + '</td>' +
        '<td class="hide-sm">' + fmtDate(t.firstTs) + '</td>' +
        '<td class="hide-sm">' + fmtDate(t.lastTs) + '</td></tr>';
    }).join('');
    $('#ls-count').textContent = fmtNum(rows.length) + ' / ' + fmtNum(manifest.threads.length) + ' スレ';
  }

  /* ---------- スレ表示 ---------- */
  var view = null;   // { id, data, lis }

  function crumbs(title, tid) {
    return '<div class="crumbs"><span class="b"><a href="#/">TOP</a></span><span class="sep">»</span>' +
      '<span class="b"><a href="#/">カテゴリ『その他話題』</a></span><span class="sep">»</span>' +
      '<span class="b">' + (tid ? '<a href="#/t/' + tid + '">' + esc(title) + '</a>' : esc(title)) + '</span></div>';
  }

  function renderThread(id, resNo) {
    var t = byId.get(id);
    if (!t) { app.innerHTML = '<p>このスレは保存されていません。<a href="#/">一覧へ</a></p>'; return; }
    view = null;
    document.title = t.title + ' | 異能スレ アーカイブ';
    app.innerHTML = crumbs(t.title, id) + '<p class="muted">読み込み中…</p>';
    getThread(id).then(function (data) {
      if (currentRoute && currentRoute.indexOf('/t/' + id) !== 0) return;
      var prev = byNumber.get(t.number - 1), next = byNumber.get(t.number + 1);
      var h = crumbs(t.title, id) + '<h1 class="title">' + esc(t.title) + '</h1>';
      var origUrl = ORIGIN_BOARD + id + '/';
      h += '<div class="orig-url">元のスレ(あにまん掲示板): <a href="' + esc(origUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(origUrl) + '</a></div>';
      h += '<div class="thread-tools">' +
        (prev ? '<a href="#/t/' + prev.id + '">← 前スレ(' + prev.number + ')</a>' : '<span>← 前スレなし</span>') +
        (next ? '<a href="#/t/' + next.id + '">次スレ(' + next.number + ') →</a>' : '<span>次スレなし →</span>') +
        '<label>レス番号へ <input type="number" id="jump" min="1" max="' + data.posts.length + '"></label>' +
        '<label>このスレ内で絞り込み <input type="text" id="tfilter" placeholder="本文・名前"></label>' +
        '<span id="tcount"></span>' +
        '</div>';
      h += '<ul class="reslist" id="reslist">' + data.posts.map(function (p) {
        return '<li class="res" id="res' + p.no + '" data-no="' + p.no + '">' + headerHTML(p) + bodyHTML(p, id, null) + '</li>';
      }).join('') + '</ul>';
      h += '<div class="thread-tools" style="margin-top:14px">' +
        (prev ? '<a href="#/t/' + prev.id + '">← 前スレ(' + prev.number + ')</a>' : '') +
        (next ? '<a href="#/t/' + next.id + '">次スレ(' + next.number + ') →</a>' : '') +
        '<span>魚拓取得: ' + esc((data.savedAt || '').slice(0, 10)) + '</span></div>';
      app.innerHTML = h;
      var lis = new Map();
      Array.prototype.forEach.call(document.querySelectorAll('#reslist li.res'), function (li) { lis.set(parseInt(li.getAttribute('data-no'), 10), li); });
      view = { id: id, data: data, lis: lis };

      $('#jump').onkeydown = function (e) { if (e.key === 'Enter') { var n = parseInt(e.target.value, 10); if (n) scrollToRes(n); } };
      var nm = getNorm(id, data);
      $('#tfilter').oninput = function (e) {
        var q = norm(e.target.value).trim(), shown = 0;
        data.posts.forEach(function (p, i) {
          var ok = !q || nm.t[i].indexOf(q) >= 0 || nm.n[i].indexOf(q) >= 0;
          lis.get(p.no).classList.toggle('hidden', !ok);
          if (ok) shown++;
        });
        $('#tcount').textContent = q ? shown + ' / ' + data.posts.length + ' 件' : '';
      };
      if (resNo) setTimeout(function () { scrollToRes(resNo); }, 30);
    }).catch(function (e) {
      app.innerHTML = crumbs(t.title, id) + '<p class="warn">読み込みに失敗しました: ' + esc(e.message) + '</p>';
    });
  }
  function scrollToRes(no) {
    if (!view) return;
    var li = view.lis.get(no);
    if (!li) return;
    li.classList.remove('hidden');
    li.scrollIntoView({ block: 'start' });
    li.classList.add('hl');
    setTimeout(function () { li.classList.remove('hl'); }, 2500);
  }

  /* ---------- >>N のポップアップ ---------- */
  var popup = null, popTimer = null;
  function hidePopup() {
    if (popTimer) { clearTimeout(popTimer); popTimer = null; }
    if (popup) { popup.remove(); popup = null; }
  }
  document.addEventListener('mouseover', function (e) {
    var a = e.target.closest && e.target.closest('a.reslink');
    if (!a) return;
    var tid = a.getAttribute('data-t'), no = parseInt(a.getAttribute('data-res'), 10);
    if (popTimer) clearTimeout(popTimer);
    popTimer = setTimeout(function () {
      getThread(tid).then(function (data) {
        var p = data.posts[no - 1];
        if (!p || p.no !== no) p = data.posts.find(function (x) { return x.no === no; });
        if (!p) return;
        hidePopup();
        popup = document.createElement('div');
        popup.className = 'popup';
        popup.innerHTML = headerHTML(p) + bodyHTML(p, tid, null);
        document.body.appendChild(popup);
        var r = a.getBoundingClientRect();
        var w = popup.offsetWidth, hgt = popup.offsetHeight;
        var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
        var top = r.bottom + 4;
        if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 4);
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
        popup.addEventListener('mouseleave', hidePopup);
      }).catch(function () {});
    }, 150);
  });
  document.addEventListener('mouseout', function (e) {
    var a = e.target.closest && e.target.closest('a.reslink');
    if (!a) return;
    if (popTimer) { clearTimeout(popTimer); popTimer = null; }
    var to = e.relatedTarget;
    setTimeout(function () { if (popup && !popup.matches(':hover')) hidePopup(); }, 250);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hidePopup(); });
  document.addEventListener('error', function (e) {
    var im = e.target;
    if (im && im.tagName === 'IMG' && im.closest && im.closest('.thumbs')) {
      var a = im.closest('a.thumb');
      if (a) { a.innerHTML = '<span class="broken">画像を表示できません(リンクを開く)</span>'; }
    }
  }, true);

  /* ---------- 検索 ---------- */
  var SEARCH_SORTS = [['new', '投稿が新しい順'], ['old', '投稿が古い順'], ['likes', 'いいねが多い順'], ['thread', 'スレ番号が新しい順'], ['threadold', 'スレ番号が古い順']];

  function parseQuery(q) {
    var inc = [], exc = [], re = /"([^"]+)"|(\S+)/g, m;
    while ((m = re.exec(q))) {
      var tok = m[1] !== undefined ? m[1] : m[2];
      if (m[1] === undefined && tok.length > 1 && tok[0] === '-') exc.push(norm(tok.slice(1)));
      else inc.push(norm(tok));
    }
    return { inc: inc.filter(Boolean), exc: exc.filter(Boolean) };
  }

  var FIELD_LABELS = [['text', '本文'], ['name', '名前(コテハン)'], ['both', '本文+名前']];

  // URLから条件の一覧を読み取る(c=対象|除外|ワード を何個でも / 古い形式の q= も読める)
  function rowsFromParams(params) {
    var rows = [];
    params.getAll('c').forEach(function (v) {
      var m = /^(text|name|both)\|([01])\|([\s\S]*)$/.exec(v);
      if (m) rows.push({ f: m[1], ex: m[2] === '1', q: m[3] });
    });
    if (!rows.length && (params.get('q') || '')) {
      var txt = params.get('text') !== '0', nm = params.get('name') === '1';
      rows.push({ f: txt && nm ? 'both' : (nm ? 'name' : 'text'), ex: false, q: params.get('q') });
    }
    if (!rows.length) rows.push({ f: 'text', ex: false, q: '' });
    return rows;
  }
  function condRowHTML(r, i) {
    return '<div class="cond-row">' +
      '<span class="cond-no">' + (i === 0 ? '条件' : 'かつ') + '</span>' +
      '<select class="c-f">' + FIELD_LABELS.map(function (x) {
        return '<option value="' + x[0] + '"' + (r.f === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
      }).join('') + '</select>' +
      '<input type="text" class="c-q" placeholder="検索ワード(スペースでAND / -語で除外 / &quot;…&quot;で完全一致)" value="' + esc(r.q) + '">' +
      '<label class="c-ex"><input type="checkbox" class="c-x"' + (r.ex ? ' checked' : '') + '> 含まない</label>' +
      '<button type="button" class="btn sub c-del" title="この条件を消す">✕</button></div>';
  }

  function renderSearch(params) {
    var rows = rowsFromParams(params);
    var o = {
      rows: rows,
      from: params.get('from') || '',
      to: params.get('to') || '',
      sort: params.get('sort') || 'new'
    };
    var first = rows.filter(function (r) { return r.q.trim(); })[0];
    document.title = (first ? '「' + first.q + '」の検索結果' : 'レス検索') + ' | 異能スレ アーカイブ';
    var tq = $('#q-top'); if (tq) tq.value = first ? first.q : '';
    app.innerHTML = '<h1 class="title">レス検索</h1>' +
      '<form id="sform" class="panel-box">' +
      '<div id="conds"></div>' +
      '<div class="controls"><button type="button" class="btn sub" id="add-cond">＋ 条件を追加</button>' +
      '<button class="btn" type="submit">検索</button></div>' +
      '<div class="muted small">すべての条件を満たす「1つのレス」を探します。例: 名前に「刃線」、本文に「ヴィラン」 → 刃線さんがヴィランと書いたレス</div>' +
      '<div class="controls">' +
      '<label>スレ番号 <input type="number" id="s-from" min="1" placeholder="最小" value="' + esc(o.from) + '"> 〜 <input type="number" id="s-to" min="1" placeholder="最大" value="' + esc(o.to) + '"></label>' +
      '<label>並び替え <select id="s-sort">' + SEARCH_SORTS.map(function (s) {
        return '<option value="' + s[0] + '"' + (o.sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select></label></div></form>' +
      '<div id="s-status" class="muted"></div><div class="progress"><div id="s-bar"></div></div><div id="s-results"></div>';

    var conds = $('#conds');
    function redrawConds(list) {
      conds.innerHTML = list.map(condRowHTML).join('');
      Array.prototype.forEach.call(conds.querySelectorAll('.c-del'), function (btn, i) {
        btn.style.visibility = list.length > 1 ? 'visible' : 'hidden';
        btn.onclick = function () { var cur = readConds(); cur.splice(i, 1); redrawConds(cur.length ? cur : [{ f: 'text', ex: false, q: '' }]); };
      });
    }
    function readConds() {
      return Array.prototype.map.call(conds.querySelectorAll('.cond-row'), function (row) {
        return { f: row.querySelector('.c-f').value, ex: row.querySelector('.c-x').checked, q: row.querySelector('.c-q').value };
      });
    }
    redrawConds(rows);
    $('#add-cond').onclick = function () {
      var cur = readConds(); cur.push({ f: 'text', ex: false, q: '' }); redrawConds(cur);
      var qs = conds.querySelectorAll('.c-q'); qs[qs.length - 1].focus();
    };
    $('#sform').onsubmit = function (e) {
      e.preventDefault();
      var p = new URLSearchParams();
      readConds().forEach(function (r) { if (r.q.trim()) p.append('c', r.f + '|' + (r.ex ? 1 : 0) + '|' + r.q); });
      if ($('#s-from').value) p.set('from', $('#s-from').value);
      if ($('#s-to').value) p.set('to', $('#s-to').value);
      p.set('sort', $('#s-sort').value);
      navigate('/s?' + p.toString());
    };
    $('#s-sort').onchange = function () { $('#sform').requestSubmit ? $('#sform').requestSubmit() : $('#sform').onsubmit(new Event('submit')); };

    // 検索用に整える(ワードの空の条件は無視)
    var compiled = [];
    rows.forEach(function (r) {
      var pq = parseQuery(r.q);
      if (pq.inc.length || pq.exc.length) compiled.push({ f: r.f, ex: r.ex, inc: pq.inc, exc: pq.exc });
    });
    if (!compiled.length) {
      $('#s-status').textContent = '検索ワードを入れてください。保存済みの全スレから探します。条件は「＋ 条件を追加」で増やせます。';
      $('#s-bar').parentNode.style.display = 'none';
      return;
    }
    runSearch(o, compiled);
  }

  function runSearch(o, conds) {
    var token = ++searchToken;
    var from = parseInt(o.from, 10) || 0, to = parseInt(o.to, 10) || Infinity;
    var scope = manifest.threads.filter(function (t) { return t.number >= from && t.number <= to; });
    var results = [], done = 0, limit = 100, dirty = true, finished = false;
    var status = $('#s-status'), bar = $('#s-bar'), box = $('#s-results');
    // 色を付ける語(本文の条件 / 名前の条件)
    var textTerms = [], nameTerms = [];
    conds.forEach(function (c) {
      if (c.ex) return;
      if (c.f !== 'name') textTerms = textTerms.concat(c.inc);
      if (c.f !== 'text') nameTerms = nameTerms.concat(c.inc);
    });

    function sortResults() {
      var k = o.sort;
      results.sort(function (a, b) {
        if (k === 'new') return b.ts - a.ts || b.t.number - a.t.number || b.p.no - a.p.no;
        if (k === 'old') return a.ts - b.ts || a.t.number - b.t.number || a.p.no - b.p.no;
        if (k === 'likes') return (b.p.likes || 0) - (a.p.likes || 0) || b.ts - a.ts;
        if (k === 'threadold') return a.t.number - b.t.number || a.p.no - b.p.no;
        return b.t.number - a.t.number || a.p.no - b.p.no;
      });
    }
    function draw() {
      if (token !== searchToken) return;
      dirty = false;
      sortResults();
      status.textContent = fmtNum(results.length) + ' 件ヒット' + (finished ? '' : '(検索中… ' + done + ' / ' + scope.length + ' スレ)') +
        (finished ? ' / ' + scope.length + ' スレを検索' : '');
      bar.style.width = (scope.length ? done / scope.length * 100 : 100) + '%';
      if (finished) bar.parentNode.style.display = 'none';
      var shown = results.slice(0, limit);
      box.innerHTML = shown.map(function (r) {
        return '<div class="hit">' +
          '<div class="where"><a href="#/t/' + r.t.id + '/' + r.p.no + '">' + esc(r.t.title) + ' &gt;&gt;' + r.p.no + '</a></div>' +
          '<div class="resheader"><span class="resname">' + highlight(r.p.name, nameTerms) + '</span>' +
          '<span class="resposted">' + esc(r.p.posted) + '</span>' +
          '<span class="heart' + (r.p.likes ? '' : ' zero') + '">♡ ' + (r.p.likes || 0) + '</span></div>' +
          bodyHTML(r.p, r.t.id, textTerms) + '</div>';
      }).join('') + (results.length > limit ? '<div class="center"><button class="btn sub" id="more">もっと見る(残り ' + fmtNum(results.length - limit) + ' 件)</button></div>' : '') +
        (finished && !results.length ? '<p class="muted">見つかりませんでした。</p>' : '');
      var more = $('#more'); if (more) more.onclick = function () { limit += 100; draw(); };
    }
    var tick = setInterval(function () {
      if (token !== searchToken) { clearInterval(tick); return; }
      if (dirty) draw();
    }, 250);

    function scan(t, data) {
      var nm = getNorm(t.id, data);
      for (var i = 0; i < data.posts.length; i++) {
        var p = data.posts[i];
        if (p.deleted) continue;
        var ok = true;
        for (var c = 0; c < conds.length && ok; c++) {
          var cd = conds[c];
          var hay = cd.f === 'text' ? nm.t[i] : (cd.f === 'name' ? nm.n[i] : nm.t[i] + '\n' + nm.n[i]);
          var hit = true;
          for (var a2 = 0; a2 < cd.inc.length && hit; a2++) if (hay.indexOf(cd.inc[a2]) < 0) hit = false;
          for (var b2 = 0; b2 < cd.exc.length && hit; b2++) if (hay.indexOf(cd.exc[b2]) >= 0) hit = false;
          if (cd.ex ? hit : !hit) ok = false;
        }
        if (ok) results.push({ t: t, p: p, ts: parseTs(p.posted) });
      }
    }

    var idx = 0, active = 0, CONC = 6;
    function pump() {
      if (token !== searchToken) return;
      while (active < CONC && idx < scope.length) {
        (function (t) {
          active++;
          getThread(t.id).then(function (data) {
            if (token !== searchToken) return;
            scan(t, data);
          }).catch(function () {}).then(function () {
            active--; done++; dirty = true;
            if (done >= scope.length) { finished = true; clearInterval(tick); draw(); }
            else pump();
          });
        })(scope[idx++]);
      }
    }
    if (!scope.length) { finished = true; clearInterval(tick); draw(); } else pump();
    draw();
  }

  /* ---------- 画面上部の検索ボックス ---------- */
  $('#top-search').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('#q-top').value.trim();
    navigate('/s' + (q ? '?q=' + encodeURIComponent(q) : ''));
  });

  /* ---------- 起動 ---------- */
  fetch('data/manifest.json').then(function (r) {
    if (!r.ok) throw new Error('data/manifest.json が見つかりません');
    return r.json();
  }).then(function (m) {
    manifest = m;
    m.threads.forEach(function (t) { byId.set(t.id, t); byNumber.set(t.number, t); });
    currentRoute = location.hash.slice(1);
    show(currentRoute);
  }).catch(function (e) {
    app.innerHTML = '<p class="warn">読み込みに失敗しました: ' + esc(e.message) + '</p>';
  });
})();
