/* Premium Contents 뷰어
 *
 * 이 repo 는 public 이고 본문은 한 줄도 들어있지 않다. 화면에 뿌리는 내용은 전부
 * private repo(tryingpig/premium-contents)에서 GitHub API 로 그때그때 읽어온다.
 * 토큰은 브라우저 localStorage 에만 있고 어디로도 나가지 않는다(api.github.com 제외).
 */
'use strict';

const OWNER = 'tryingpig';
const REPO  = 'premium-contents';
const KEY   = 'pc.pat';
const FSKEY = 'pc.fs';
const PAGE  = 30;                   // 목록 한 번에 그리는 개수
const FS_MIN = 15, FS_MAX = 22;     // 본문 글자 크기 범위(px)

// 채널 구분색. 목록에서 어느 채널 글인지 색으로 먼저 읽히게 한다.
const ACCENTS = ['#e0803c', '#7b61c9', '#2f8f6b', '#c05a7d', '#3b7fd4'];

const $  = (s, r = document) => r.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c;
                          if (x != null) n.textContent = x; return n; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ── 테마 ───────────────────────────────────
   3단: 시스템 → 라이트 → 다크. '시스템'을 없애고 둘만 두면, OS 를 밤에 자동으로
   어둡게 바꾸는 사람에게는 뷰어만 계속 밝은 채로 남는다. 초기 적용은 index.html
   head 에서 이미 끝났고(깜빡임 방지), 여기서는 버튼 표시와 전환만 맡는다. */
const THEMES = ['system', 'light', 'dark'];
const THEME_UI = { system: ['🌗', '테마: 시스템'], light: ['☀️', '테마: 밝게'], dark: ['🌙', '테마: 어둡게'] };
const getTheme = () => { try { return localStorage.getItem('pv-theme') || 'system'; } catch (e) { return 'system'; } };

function applyTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { t === 'system' ? localStorage.removeItem('pv-theme') : localStorage.setItem('pv-theme', t); } catch (e) {}
  const b = $('#btn-theme');
  if (b) { b.textContent = THEME_UI[t][0]; b.title = THEME_UI[t][1]; b.setAttribute('aria-label', THEME_UI[t][1]); }
}

/* ── 채널 아이콘 ─────────────────────────────
   각 매체가 실제로 쓰는 로고(브라우저 탭에 뜨는 그 아이콘)를 icons/ 에 받아 두고 쓴다.
   이모지는 매체를 가리키지 못해서(🎓 가 이효석아카데미라는 단서가 되지 않는다)
   목록이 길어지면 다 비슷해 보인다. 파일이 없으면 원래 이모지로 되돌아간다. */
function chIcon(c, cls) {
  const wrap = el('span', 'chi' + (cls ? ' ' + cls : ''));
  const img = document.createElement('img');
  img.src = 'icons/' + c.id + '.png';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    wrap.textContent = c.emoji || '📰';
    wrap.classList.add('emoji');
  }, { once: true });
  wrap.append(img);
  return wrap;
}

// 보관 정리: 발행 30일 뒤 '삭제 예정'(exp = 삭제일), 거기서 14일 뒤 실제 삭제(gone).
// 삭제된 글은 목록에서 빼지만 색인에는 자리표시로 남겨, 텔레그램에 나간 옛 링크가
// '없는 글'로 끝나지 않고 원문으로 이어지게 한다.
const live = a => !a.gone;
function daysLeft(a) {
  if (!a.exp) return null;
  const t = new Date(a.exp + 'T23:59:59') - new Date();
  return Math.max(0, Math.ceil(t / 86400000));
}

let INDEX = null;                   // index.json
let ACOF  = {};                     // 채널id → 색
const BLOBS = new Map();            // repo 경로 → objectURL (세션 캐시)

class AuthError extends Error {}

/* ── 토큰 ───────────────────────────────── */
const getPat = () => localStorage.getItem(KEY) || '';
const setPat = v => v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY);

/* ── 로컬 모드 ─────────────────────────────
 * localhost 로 띄우면 토큰 없이 옆에 있는 파일을 그대로 읽는다.
 * premium-contents 클론 안에 이 뷰어 3개 파일을 복사해 두고
 *   py -m http.server 8000
 * 을 돌리면 네트워크 없이도 아카이브 전체를 볼 수 있다. */
const LOCAL = ['localhost', '127.0.0.1', ''].indexOf(location.hostname) >= 0;

/* ── private repo 읽기 ───────────────────── */
async function ghRaw(path, asBlob) {
  if (LOCAL) {
    // 색인은 브라우저 캐시를 건너뛴다 — 옆 파일이 바뀌어도 낡은 목록을 붙들고 있었다
    const r = await fetch('./' + path, path === 'index.json' ? { cache: 'no-cache' } : undefined);
    if (!r.ok) throw new Error('로컬 읽기 실패 ' + r.status + ': ' + path);
    return asBlob ? r.blob() : r.text();
  }
  const pat = getPat();
  if (!pat) throw new AuthError('토큰이 없습니다');
  const url = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + path + '?ref=main';
  const r = await fetch(url, {
    headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github.raw' } });
  if (r.status === 401 || r.status === 403) throw new AuthError('토큰이 거부되었습니다 (' + r.status + ')');
  // 비공개 repo 는 권한이 없으면 403 이 아니라 404 로 답한다(저장소 존재 자체를 숨긴다).
  // 그래서 색인조차 404 면 '파일이 없다'가 아니라 '토큰이 이 저장소를 못 본다'로 읽어야 한다.
  if (r.status === 404) {
    if (path === 'index.json')
      throw new AuthError('이 토큰으로는 premium-contents 가 보이지 않습니다. '
        + '토큰의 Repository access 가 premium-contents 를 포함하는지 확인해 주세요.');
    throw new Error('저장소에 없는 파일: ' + path);
  }
  if (!r.ok) throw new Error('읽기 실패 ' + r.status);
  return asBlob ? r.blob() : r.text();
}

/* ── 브라우저 캐시 ─────────────────────────
 * 글 하나에 이미지가 40~70장이라 매번 GitHub API 를 60번 때리면 열 때마다 느리다.
 * 받은 것은 Cache Storage 에 남겨 두 번째부터는 네트워크를 아예 안 탄다.
 * 키에 색인의 saved(재보존 시각)를 넣어 두므로, 글을 다시 보존하면 키가 달라져
 * 저절로 새로 받는다 — 낡은 저장본이 캐시에 눌러앉는 일이 없다. */
const CACHE_NAME = 'pc-v1';
let CACHE;                          // Cache | false(못 씀) | undefined(아직 안 열어봄)
let PRUNED = false;

async function store() {
  if (CACHE !== undefined) return CACHE;
  try { CACHE = self.caches ? await caches.open(CACHE_NAME) : false; }
  catch (e) { CACHE = false; }      // 사파리 시크릿창 등
  return CACHE;
}
// 실제로 요청하지 않는 합성 키다. 같은 오리진이어야 Cache 에 넣을 수 있다.
const ckey = (path, ver) => location.origin + '/__pc/' + path + '?v=' + encodeURIComponent(ver || '0');

/** 저장본 파일 하나를 캐시 우선으로 읽는다. asBlob 이면 Blob, 아니면 text. */
async function cachedFetch(path, ver, asBlob) {
  const c = await store();
  const key = ckey(path, ver);
  if (c) {
    try {
      const hit = await c.match(key);
      if (hit) return asBlob ? await hit.blob() : await hit.text();
    } catch (e) { /* 캐시가 깨졌으면 그냥 받는다 */ }
  }
  const data = await ghRaw(path, asBlob);
  // 넣는 것은 기다리지 않는다 — 화면이 캐시 쓰기를 기다릴 이유가 없다
  if (c) { try { c.put(key, new Response(data)).catch(() => {}); } catch (e) {} }
  return data;
}

/** 캐시에만 채워 넣는다(미리받기용). objectURL 을 만들지 않아 메모리를 안 쓴다. */
const warm = (path, ver) => cachedFetch(path, ver, true).then(() => true, () => false);

/* ── 썸네일 받기: 동시 4개까지, 15초 넘으면 포기 ─────────
 * private repo 라 썸네일 한 장이 곧 GitHub API 호출 하나다. 목록을 열면 30장이 한꺼번에
 * 나가는데, 그러면 GitHub 이 동시 요청을 눌러 응답이 늦어지고 img 는 src 없이 빈 칸으로
 * 남는다(실패도 아니라 자리표시조차 안 뜬다 — 폰에서 실제로 그렇게 보였다).
 * 그래서 ① 동시 4개로 줄이고 ② 15초에 끊어 실패로 확정한다. 끊긴 건 다음 스크롤·재방문에
 * 다시 시도한다. 캐시(Cache Storage)에 이미 있는 건 큐를 타지 않고 바로 나간다. */
const GATE_MAX = 4;
let gateRunning = 0;
const gateQ = [];

function gate(fn, still) {
  return new Promise((res, rej) => {
    gateQ.push({ still, run: () => Promise.resolve().then(fn).then(res, rej).finally(() => {
      gateRunning--;
      pump();
    }) });
    pump();
  });
}
function pump() {
  while (gateRunning < GATE_MAX && gateQ.length) {
    const job = gateQ.shift();
    // 탭·칩을 바꿔 목록이 갈아엎어지면 줄 서 있던 옛 목록의 썸네일은 받을 곳이 없다.
    // 그냥 두면 새 목록의 썸네일이 그 뒤에서 기다린다 — 건너뛴다.
    if (job.still && !job.still()) continue;
    gateRunning++;
    job.run();
  }
}
const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('시간 초과')), ms);
  p.then(res, rej).finally(() => clearTimeout(t));
});

async function blobUrl(path, ver) {
  const k = path + '@' + (ver || '');
  if (BLOBS.has(k)) return BLOBS.get(k);
  const u = URL.createObjectURL(await cachedFetch(path, ver, true));
  BLOBS.set(k, u);
  return u;
}

/* ── 미리받기 ─────────────────────────────
 * 목록을 열면 최신 글 하나를 뒤에서 캐시에 채워 둔다. 목록 → 글로 들어갈 때
 * 기다림이 사라진다. 데이터 절약 모드면 하지 않는다. */
let PREFETCHED = '';
function schedulePrefetch(a) {
  if (!a || a.gone || PREFETCHED === a.id) return;
  if ((navigator.connection || {}).saveData) return;
  PREFETCHED = a.id;
  setTimeout(() => prefetch(a).catch(() => {}), 1200);
}
async function prefetch(a) {
  const html = await cachedFetch(a.p + '/index.html', a.saved);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const paths = [].filter.call(doc.querySelectorAll('img'),
                               i => (i.getAttribute('src') || '').indexOf('img/') === 0)
                  .map(i => a.p + '/' + i.getAttribute('src'));
  let i = 0;
  const worker = async () => { while (i < paths.length) await warm(paths[i++], a.saved); };
  await Promise.all([worker(), worker(), worker()]);   // 읽는 중이 아니므로 얌전히
}

/** 색인에 없는(삭제됐거나 다시 보존된) 캐시를 지운다. 세션당 한 번, 뒤에서. */
async function pruneStore() {
  const c = await store();
  if (!c) return;
  const ok = new Set();
  (INDEX.articles || []).forEach(a => { if (!a.gone) ok.add(a.p + '@' + (a.saved || '')); });
  const keys = await c.keys();
  for (const req of keys) {
    let dir, ver;
    try {
      const u = new URL(req.url);
      dir = decodeURIComponent(u.pathname.split('/__pc/')[1] || '')
              .replace(/\/(img\/[^/]+|thumb\.webp|index\.html)$/, '');
      ver = u.searchParams.get('v') || '';
    } catch (e) { continue; }
    if (!dir || !ok.has(dir + '@' + ver)) await c.delete(req);
  }
}

/* ── 색인 ───────────────────────────────── */
async function loadIndex(force) {
  if (INDEX && !force) return INDEX;
  INDEX = JSON.parse(await ghRaw('index.json'));
  (INDEX.channels || []).forEach((c, i) => { ACOF[c.id] = ACCENTS[i % ACCENTS.length]; });
  if (!PRUNED) { PRUNED = true; setTimeout(() => pruneStore().catch(() => {}), 4000); }
  return INDEX;
}
const chOf = id => (INDEX.channels || []).find(c => c.id === id) || { label: id, emoji: '📰' };

/* ── 조각 ───────────────────────────────── */
function thumb(a) {
  if (!a.th) return el('div', 'th ph', '📄');
  const img = el('img', 'th');
  // loading=lazy 는 붙이지 않는다 — 아래 IntersectionObserver 가 이미 같은 일을 하고,
  // 브라우저 자체 lazy 는 '방금 끼워 넣은 목록'을 스크롤이 일어나기 전까지 안 받는 경우가
  // 있다(사파리). 탭을 바꾸면 썸네일이 빈 칸으로 남고 새로고침해야 나오던 증상.
  img.decoding = 'async';
  img.alt = '';
  // 화면(±300px)에 들어온 카드만 받는다 — 30장을 미리 다 받을 이유가 없다
  let asked = false, tries = 0;
  const alive = () => img.isConnected;
  const load = () => {
    if (asked || img.src) return;
    asked = true;
    gate(() => withTimeout(blobUrl(a.p + '/thumb.webp', a.saved), 15000), alive)
      .then(u => { img.src = u; img.classList.remove('th-fail'); })
      .catch(() => {
        // 끊긴 것은 한 번은 곧바로, 그 뒤엔 다시 화면에 들어올 때 다시 시도한다
        asked = false;
        img.classList.add('th-fail');
        if (++tries <= 2 && alive()) setTimeout(() => { if (alive()) load(); }, 1500 * tries);
      });
  };
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(e => {
      if (e[0].isIntersecting) { load(); if (img.src) io.disconnect(); }
    }, { rootMargin: '300px' });
    io.observe(img);
  } else {
    load();
  }
  return img;
}

function row(a, showCh) {
  const c = chOf(a.ch);
  const link = el('a', 'item');
  link.href = '#/a/' + a.id;
  link.style.setProperty('--ac', ACOF[a.ch] || 'var(--accent)');
  link.append(thumb(a));
  const bd = el('div', 'bd');
  bd.append(el('div', 'tt', a.t || '(제목 없음)'));
  const mt = el('div', 'mt');
  if (showCh) {
    const pill = el('span', 'pill ch');
    pill.append(chIcon(c, 'xs'), el('span', null, c.label));
    mt.append(pill);
  }
  if (a.c) mt.append(el('span', 'pill', a.c));
  if (a.d) mt.append(el('span', null, a.d));
  if (a.img) mt.append(el('span', 'dot'), el('span', null, '이미지 ' + a.img));
  if (a.miss) mt.append(el('span', 'dot'), el('span', null, '유실 ' + a.miss));
  const dd = daysLeft(a);
  if (dd !== null) mt.append(el('span', 'pill exp', '🗑 D-' + dd));
  bd.append(mt);
  link.append(bd);
  return link;
}

/** 목록 + 스크롤하면 더 그리기. 필터가 바뀌면 통째로 다시 부른다. */
function listInto(box, items, showCh) {
  box.textContent = '';
  if (!items.length) { box.append(el('div', 'empty', '해당하는 글이 없습니다.')); return; }
  let n = 0;
  const sentinel = el('div');
  const io = new IntersectionObserver(e => { if (e[0].isIntersecting) draw(); },
                                      { rootMargin: '600px' });
  function draw() {
    items.slice(n, n + PAGE).forEach(a => box.insertBefore(row(a, showCh), sentinel));
    n += PAGE;
    if (n >= items.length) io.disconnect();
  }
  box.append(sentinel);
  io.observe(sentinel);
  draw();
  // 뒤로 와서 아래쪽 위치로 돌아갈 때, 그 위치가 화면에 들어올 만큼만 더 그린다
  box.reveal = y => { while (n < items.length && box.getBoundingClientRect().bottom + scrollY < y + innerHeight) draw(); };
}

/* ── 목록 위치 기억 ─────────────────────────
 * 칩·검색어는 해시 뒤(#/c/valley?cat=…&q=…)에 싣는다. 글을 보고 뒤로 오면 브라우저가
 * 그 해시를 그대로 돌려주니 필터도 저절로 돌아온다. 스크롤 위치는 해시별로 sessionStorage
 * 에 두고, 목록을 다시 그릴 때 그 자리로 돌린다(탭을 닫으면 같이 사라진다). */
function parseHash() {
  const raw = (location.hash || '#/').slice(1);
  const qi = raw.indexOf('?');
  const path = qi < 0 ? raw : raw.slice(0, qi);
  const qs = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
  const parts = path.split('/');
  return { path, kind: parts[1], arg: parts[2], qs };
}
/** 필터가 바뀌면 해시만 바꿔 둔다 — 히스토리를 쌓지 않으니 뒤로가기 한 번에 목록을 떠난다. */
function setFilterHash(path, cat, q) {
  const qs = new URLSearchParams();
  if (cat) qs.set('cat', cat);
  if (q) qs.set('q', q);
  const s = qs.toString();
  history.replaceState(null, '', '#' + path + (s ? '?' + s : ''));
}
const SCROLL_KEY = 'pv-scroll:';
const saveScroll = () => { try { sessionStorage.setItem(SCROLL_KEY + parseHash().path, String(scrollY)); } catch (e) {} };
const savedScroll = path => { try { return parseInt(sessionStorage.getItem(SCROLL_KEY + path) || '0', 10) || 0; } catch (e) { return 0; } };

/* ── 화면: 홈 ───────────────────────────── */
function renderHome() {
  const w = el('div', 'wrap');
  w.append(el('h2', 'sec', '채널'));
  const cards = el('div', 'cards');
  (INDEX.channels || []).forEach(c => {
    const a = el('a', 'card');
    a.href = '#/c/' + c.id;
    a.style.setProperty('--ac', ACOF[c.id]);
    a.append(chIcon(c, 'em'), el('div', 'nm', c.label),
             el('div', 'ct', (c.count || 0).toLocaleString() + '편 보관'), el('div', 'bar'));
    cards.append(a);
  });
  w.append(cards);
  w.append(el('h2', 'sec', '최근 글'));
  const box = el('div', 'list');
  w.append(box);
  const recent = (INDEX.articles || []).filter(live);
  listInto(box, recent, true);
  schedulePrefetch(recent[0]);
  return w;
}

/* ── 화면: 채널 ─────────────────────────── */
function renderChannel(id, qs) {
  qs = qs || new URLSearchParams();
  const c = chOf(id);
  const all = (INDEX.articles || []).filter(a => a.ch === id && live(a));
  const w = el('div', 'wrap');
  w.style.setProperty('--ac', ACOF[id] || 'var(--accent)');
  const head = el('h2', 'sec');
  head.append(chIcon(c, 'sm'), el('span', null, c.label + ' · ' + all.length.toLocaleString() + '편'));
  w.append(head);

  const filters = el('div', 'filters');
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = '제목·카테고리 검색';
  search.value = qs.get('q') || '';
  filters.append(search);
  w.append(filters);

  // 카테고리 칩은 실제 저장된 글에 있는 것만 — config 에만 있고 글이 없는 칩은 안 그린다
  const count = {};
  all.forEach(a => { if (a.c) count[a.c] = (count[a.c] || 0) + 1; });
  let cats = Object.keys(count).sort((x, y) => count[y] - count[x]);
  if (c.cats_fixed && c.cats) {
    // 채널이 순서를 정해 준 경우(밸리 등) — 정한 순서 먼저, 목록에 없는 새 카테고리는 뒤에 많은 순
    const rank = {}; c.cats.forEach((k, i) => { rank[k] = i; });
    cats.sort((x, y) => ((x in rank) ? rank[x] : 1e9) - ((y in rank) ? rank[y] : 1e9) || count[y] - count[x]);
  }

  const chips = el('div', 'cats');
  let cur = qs.get('cat') || '';
  if (cur && !count[cur]) cur = '';          // 해시에 남은 칩이 지금은 없는 카테고리면 전체로
  const mk = (label, val) => {
    const b = el('button', val === cur ? 'on' : '', label);
    b.onclick = () => {
      cur = val;
      [].forEach.call(chips.children, x => x.classList.remove('on'));
      b.classList.add('on');
      apply();
      scrollTo(0, 0);
    };
    return b;
  };
  chips.append(mk('전체 ' + all.length, ''));
  cats.forEach(k => chips.append(mk(k + ' ' + count[k], k)));
  w.append(chips);

  const box = el('div', 'list');
  w.append(box);

  function apply() {
    const q = search.value.trim().toLowerCase();
    setFilterHash('/c/' + id, cur, search.value.trim());
    listInto(box, all.filter(a =>
      (!cur || a.c === cur) &&
      (!q || (a.t || '').toLowerCase().indexOf(q) >= 0
          || (a.c || '').toLowerCase().indexOf(q) >= 0)), false);
  }
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(apply, 180); };
  apply();
  schedulePrefetch(all[0]);
  return w;
}

/* ── 다크에서의 본문 ───────────────────────
 * 저장본은 --paper 를 항상 #fff 로 굳혀 놨다(종이처럼 보이라고). 그대로 두면 어두운
 * 화면에서 본문만 백지처럼 빛나 밤에 읽을 수가 없다. 그래서 종이를 어둡게 덮는데,
 * 원문에는 색을 직접 박아 넣은 글자가 많다(표본 10편에 어두운 글자 276개). 배경만
 * 어둡게 하면 그것들이 통째로 사라지므로, 색조(hue)는 두고 밝기만 끌어올린다.
 * 빨강 강조는 빨강으로 남아야 글쓴이의 의도가 지켜진다. */
const isDark = () => {
  const t = getTheme();
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme:dark)').matches);
};

function parseColor(v) {
  v = (v || '').trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(v);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
const lumOf = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 색조·채도는 두고 밝기만 목표치로 끌어올린 hex 를 돌려준다. */
function lighten([r, g, b], target) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 18) return null;                 // 회색·검정 계열은 색이랄 게 없다 → 기본 글자색에 맡긴다
  const cur = lumOf([r, g, b]) || 1;
  const k = target / cur;
  const f = v => Math.round(Math.min(255, Math.max(0, v * k)));
  const hex = n => n.toString(16).padStart(2, '0');
  return '#' + hex(f(r)) + hex(f(g)) + hex(f(b));
}

/** 저장본 문서를 어두운 종이에 맞게 손본다. srcdoc 에 넣기 전에 부른다. */
function darkenDoc(doc) {
  doc.querySelectorAll('[style]').forEach(e => {
    let st = e.getAttribute('style');
    if (!st) return;
    st = st.replace(/(^|;)\s*background-color:\s*([^;]+)/gi, (all, sep, val) => {
      const c = parseColor(val);
      // 흰 판때기는 걷어낸다. 브랜드색 셀(파란 공지표 등)은 흰 글자를 얹어 쓰므로 그대로 둔다.
      return (c && lumOf(c) > 225) ? sep : all;
    });
    st = st.replace(/(^|;)\s*color:\s*([^;]+)/gi, (all, sep, val) => {
      const c = parseColor(val);
      if (!c || lumOf(c) >= 128) return all;      // 이미 밝은 글자(색 셀 위의 흰 글씨 등)
      const nu = lighten(c, 168);
      return nu ? sep + 'color:' + nu : sep;      // 무채색이면 아예 지워 기본 글자색을 따르게
    });
    e.setAttribute('style', st);
  });
}

const DARK_FRAME_CSS = [
  '.paper{background:#17171a!important;color:#e4e4e7!important;box-shadow:none;' +
    'border:1px solid #28282e}',
  '.paper .meta{color:#8b8b93!important;border-bottom-color:#28282e!important}',
  '.paper h1{color:#f4f4f5!important}',
  'a{color:#7aa2f7!important}',
  '.se-cell{border-color:#3a3a42!important}',
  '.se-horizontalLine hr,hr.se-hr{border-top-color:#28282e!important}',
  '.se-quotation-container{border-left-color:#3f3f46!important}',
  '.se-l-quotation_line .se-quotation-container{border-top-color:#52525b!important;' +
    'border-bottom-color:#52525b!important}',
  '.se-caption,.se-module-caption{color:#8b8b93!important}',
  '.snapshot-missing,.snapshot-video{border-color:#3a3a42!important;color:#71717a!important}',
  // 차트 이미지는 흰 배경이 많다. 어둡게 깔면 글자가 뭉개지므로 밝기만 살짝 낮춰
  // 눈부심을 줄인다. 탭해서 크게 볼 때는 원래 밝기로 되돌린다.
  '.paper img{filter:brightness(.92)}',
].join('');

/* ── 저장본에 덧입히는 CSS ─────────────────
 * 뷰어 안에서는 저장본 자체의 상단 바를 숨기고 종이를 화면에 꽉 채운다.
 * (그 바는 repo 를 그냥 폴더로 열었을 때를 위한 것이다)
 * 폭 제한과 글자 크기도 여기서 한 번 더 걸어야 이미 저장된 글에 소급 적용된다. */
const FRAME_CSS = [
  '.bar{display:none!important}',
  'body{background:transparent}',
  '.paper{margin:0 auto 40px;border-radius:12px}',
  'img[data-pc]{background:rgba(127,127,127,.08);min-height:40px}',
  // 가로 밀림 방지 — 링크카드 썸네일이 폭 제한에서 빠져 문서가 통째로 밀렸었다
  'img,video,iframe,embed,object{max-width:100%;height:auto}',
  '.se-component,.se-section,.se-module,.se-component-content{max-width:100%}',
  '.se-oglink-thumbnail,.se-oglink-thumbnail-resource{max-width:100%;height:auto}',
  '.se-table{overflow-x:auto;-webkit-overflow-scrolling:touch}',
  'a{overflow-wrap:anywhere}',
  // 프리즘플레이어 잔재는 x=30,014px 에 눌러앉아 문서를 3만 픽셀로 늘린다(폰 가로 밀림의 원인)
  '.prismplayer-area,[class*=\"pzp\"]{display:none!important}',
  '.snapshot-video{padding:26px 16px;border:1px dashed #d4d4d8;border-radius:6px;' +
    'text-align:center;color:#71717a;font-size:14px}',
  // 글자 크기는 변수 하나로 몰아 원문의 크기 위계(fs16/19/24/28)를 비율로 유지한다
  ':root{--fs:16px}',
  '.se-text-paragraph,.se-text-list-item{font-size:var(--fs);line-height:1.8}',
  '.se-fs-fs16{font-size:var(--fs)}',
  '.se-fs-fs19{font-size:calc(var(--fs)*1.19)}',
  '.se-fs-fs24{font-size:calc(var(--fs)*1.5)}',
  '.se-fs-fs28{font-size:calc(var(--fs)*1.75)}',
  '.se-cell .se-text-paragraph{font-size:calc(var(--fs)*.88);line-height:1.5}',
  '.se-text-paragraph,.se-text-list-item{overflow-wrap:break-word}',
  '.se-quote .se-text-paragraph{font-size:calc(var(--fs)*1.12)}',
  // 눌러서 키우는 것이라는 걸 커서로 알린다
  '.se-image img,.se-imageGroup img,.se-imageStrip img{cursor:zoom-in}',
  // 폰: 좌우 여백을 줄여 본문 폭을 넘긴다. 종이 여백보다 한 줄에 들어가는 글자 수가 중요하다
  '@media(max-width:640px){:root{--fs:17px}.paper{padding:24px 14px 40px;border-radius:0}' +
    '.paper h1{font-size:21px}.se-component{margin-bottom:22px}}'
].join('\n');

const getFs = () => {
  const v = parseInt(localStorage.getItem(FSKEY) || '', 10);
  return isNaN(v) ? 0 : clamp(v, FS_MIN, FS_MAX);
};

/** 저장한 글자 크기를 저장본 문서에 적용. 0이면 CSS 기본값(화면 폭에 따라 16/17px). */
function applyFs(doc) {
  if (!doc) return;
  const v = getFs();
  if (v) doc.documentElement.style.setProperty('--fs', v + 'px');
  else doc.documentElement.style.removeProperty('--fs');
}

/* ── 화면: 기사 ─────────────────────────── */
async function renderArticle(id) {
  const a = (INDEX.articles || []).find(x => x.id === id);
  const wrap = el('div', 'reader');
  if (!a) {
    wrap.append(el('div', 'empty', '색인에 없는 글입니다. 아직 보존되지 않았거나 주소가 잘못됐습니다.'));
    return wrap;
  }
  const c = chOf(a.ch);
  if (a.gone) {
    const box = el('div', 'wrap');
    const g = el('div', 'tomb');
    g.append(el('div', 'tomb-em', '🗑'),
             el('h2', null, a.t || '(제목 없음)'),
             (() => { const q = el('p'); q.append(chIcon(c, 'xs'),
                 el('span', null, c.label + (a.d ? ' · ' + a.d : ''))); return q; })(),
             el('p', 'dimmed', (a.del || '') + ' 에 보관 기간이 끝나 저장본을 삭제했습니다.'));
    if (a.src) {
      const go = el('a', 'tomb-go', '네이버 원문으로 ↗');
      go.href = a.src; go.target = '_blank'; go.rel = 'noopener';
      g.append(go);
    }
    const home = el('a', 'tomb-back', '← 목록으로');
    home.href = '#/c/' + a.ch;
    g.append(home);
    box.append(g);
    return box;
  }
  const bar = el('div', 'rbar');
  const back = el('a', 'back', '← 목록');
  back.href = '#/c/' + a.ch;
  const who = el('span', 'who');
  who.append(chIcon(c, 'xs'), el('span', null, c.label));
  bar.append(back, who);
  if (a.d) bar.append(el('span', 'dot'), el('span', null, a.d));

  const frame = el('iframe');
  frame.id = 'frame';
  // srcdoc iframe 은 부모와 같은 오리진이라, 저장본에 script 가 남아 있으면 뷰어 권한으로 돈다.
  // allow-scripts 를 주지 않아 실행을 막고, allow-same-origin 은 남겨 본문 높이를 읽는다.
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');

  // 글자 크기 — 저장본 문서의 --fs 만 바꾼다. 원문의 크기 위계는 비율로 따라온다.
  const bump = d => () => {
    const doc = frame.contentDocument;
    const cur = getFs()
      || parseInt(getComputedStyle(doc.documentElement).getPropertyValue('--fs'), 10)
      || 16;
    localStorage.setItem(FSKEY, String(clamp(cur + d, FS_MIN, FS_MAX)));
    applyFs(doc);
  };
  const smaller = el('button', 'fs', 'A−');
  const bigger  = el('button', 'fs', 'A＋');
  smaller.title = '글자 작게';
  bigger.title  = '글자 크게';
  smaller.onclick = bump(-1);
  bigger.onclick  = bump(+1);

  const src = el('a', null, '원문 ↗');
  src.href = a.src;
  src.target = '_blank';
  src.rel = 'noopener';

  const grow = el('div', 'grow');
  grow.append(smaller, bigger, src);
  bar.append(grow);

  const prog = el('div', 'prog');
  wrap.append(bar, prog);
  const dd = daysLeft(a);
  if (dd !== null) {
    wrap.append(el('div', 'expbar',
      '🗑 이 저장본은 ' + a.exp + ' 에 삭제됩니다 (D-' + dd + '). '
      + '남기려면 premium-contents 의 keep.json 에 ' + a.id + ' 를 넣으세요.'));
  }
  wrap.append(frame);

  const html = await cachedFetch(a.p + '/index.html', a.saved);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 이미지는 나중에 채운다 — 58장짜리 글도 글자는 즉시 보이게 한다
  const imgs = [].filter.call(doc.querySelectorAll('img'),
                              i => (i.getAttribute('src') || '').indexOf('img/') === 0);
  imgs.forEach(i => { i.dataset.pc = i.getAttribute('src'); i.removeAttribute('src'); });
  const st = doc.createElement('style');
  st.textContent = FRAME_CSS + (isDark() ? DARK_FRAME_CSS : '');
  doc.head.append(st);
  if (isDark()) darkenDoc(doc);
  doc.querySelectorAll('a[href^="http"]').forEach(x => { x.target = '_blank'; x.rel = 'noopener'; });

  frame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
  frame.onload = () => {
    const d = frame.contentDocument;
    const fit = () => { frame.style.height = d.documentElement.scrollHeight + 'px'; };
    applyFs(d);
    fit();
    new ResizeObserver(fit).observe(d.body);
    // 본문 이미지를 탭하면 전체화면으로 — 1600px 차트가 폰 폭 345px 로 눌리면 축 라벨을 못 읽는다
    d.addEventListener('click', e => {
      const t = e.target;
      if (t && t.tagName === 'IMG' && (t.src || '').indexOf('blob:') === 0) {
        e.preventDefault();
        openZoom(t.src);
      }
    });
    fillImages(d, a.p, a.saved, prog, fit);
  };
  return wrap;
}

/** 이미지를 동시 12장씩 받아 채운다. GitHub API 는 시간당 5,000회라 한 글에 70장이어도 넉넉하다.
 *  캐시에 있으면 네트워크를 안 타므로 두 번째부터는 이 루프가 거의 즉시 끝난다. */
async function fillImages(d, base, ver, prog, fit) {
  const queue = [].slice.call(d.querySelectorAll('img[data-pc]'));
  const total = queue.length;
  if (!total) { prog.remove(); return; }
  let done = 0;
  async function next() {
    const t = queue.shift();
    if (!t) return;
    try {
      t.src = await blobUrl(base + '/' + t.dataset.pc, ver);
      t.removeAttribute('data-pc');
    } catch (e) {
      const ph = d.createElement('div');
      ph.className = 'snapshot-missing';
      ph.textContent = '(이미지를 불러오지 못했습니다)';
      t.replaceWith(ph);
    }
    done++;
    prog.style.width = Math.round(done / total * 100) + '%';
    if (done % 4 === 0) fit();
    return next();
  }
  await Promise.all(Array.from({ length: 12 }, next));
  fit();
  setTimeout(() => prog.remove(), 400);
}

/* ── 이미지 확대 ─────────────────────────
 * 차트·표가 이미지로 들어있는 글이라 확대가 본문 글자 크기보다 중요하다.
 * 열 때 '화면에 맞춤'으로 놓으면 본문에서 보던 크기 그대로라 탭 한 번이 헛돈다
 * (폰에서 752px 차트는 화면폭 362px 기준 0.48배 = 본문과 동일).
 * 그래서 열자마자 원본 픽셀(1:1)로 놓는다. 원본 자체가 590~750px 라 그 위로
 * 키워봐야 글씨가 뭉개질 뿐이므로, 기본은 여기까지다.
 * 두 손가락 확대 / 두 번 탭(전체↔원본) / 끌어서 이동. */
function openZoom(src) {
  const lb = el('div', 'lb');
  const img = el('img');
  const closeBtn = el('button', 'lb-x', '✕');
  closeBtn.setAttribute('aria-label', '닫기');
  const hint = el('div', 'lb-hint', '두 번 탭하면 전체 보기 · 두 손가락으로 더 확대 · 바깥을 탭하면 닫힘');
  lb.append(img, closeBtn, hint);
  document.body.append(lb);
  document.body.style.overflow = 'hidden';

  let scale = 1, tx = 0, ty = 0, base = 1;
  const apply = () => {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  };

  // 배율 하나를 정해 놓는다. 화면보다 크면 왼쪽 위부터 — 차트는 y축 라벨이 왼쪽에 있다.
  const place = s => {
    const vw = innerWidth, vh = innerHeight;
    const iw = img.naturalWidth || vw, ih = img.naturalHeight || vh;
    scale = s;
    tx = iw * s > vw ? 0 : (vw - iw * s) / 2;
    ty = ih * s > vh ? 0 : (vh - ih * s) / 2;
    apply();
  };

  const reset = () => {
    const vw = innerWidth, vh = innerHeight;
    const iw = img.naturalWidth || vw, ih = img.naturalHeight || vh;
    base = Math.min(vw / iw, vh / ih, 1);   // 전체가 들어오는 배율 = 축소의 하한
    place(1);                               // 원본 1:1 로 시작
  };

  // 화면 좌표 (px,py) 를 고정한 채 k 배 확대
  const zoomAt = (k, px, py) => {
    const ns = clamp(scale * k, base * 0.9, Math.max(base * 8, 8));
    k = ns / scale;
    tx = px - k * (px - tx);
    ty = py - k * (py - ty);
    scale = ns;
    apply();
  };

  img.onload = reset;
  img.src = src;
  addEventListener('resize', reset);

  const pts = new Map();
  let startPinch = null, lastPan = null, lastTap = 0;
  const mid = () => {
    const v = [];
    pts.forEach(p => v.push(p));
    return { x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2,
             d: Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y) };
  };

  lb.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { startPinch = { d: mid().d, s: scale }; lastPan = null; }
    else { lastPan = { x: e.clientX, y: e.clientY, moved: false }; }
  });

  lb.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2 && startPinch) {
      const m = mid();
      if (m.d > 0) zoomAt((startPinch.s * (m.d / startPinch.d)) / scale, m.x, m.y);
    } else if (pts.size === 1 && lastPan) {
      const dx = e.clientX - lastPan.x, dy = e.clientY - lastPan.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) lastPan.moved = true;
      tx += dx; ty += dy;
      lastPan.x = e.clientX; lastPan.y = e.clientY;
      apply();
    }
  });

  const up = e => {
    const wasTap = lastPan && !lastPan.moved;
    const onBackdrop = e.target === lb;
    pts.delete(e.pointerId);
    if (pts.size < 2) startPinch = null;
    if (pts.size === 0 && wasTap) {
      const now = Date.now();
      if (now - lastTap < 300) {              // 두 번 탭 → 원본 크기 ↔ 화면 맞춤
        lastTap = 0;
        if (scale > base * 1.05) place(base);   // 전체 보기
        else place(1);                          // 원본 1:1
      } else {
        lastTap = now;
        // 한 번 탭이 확정될 때까지 기다렸다가, 이미지 바깥이었으면 닫는다
        setTimeout(() => {
          if (lastTap && Date.now() - lastTap >= 280 && onBackdrop) close();
        }, 300);
      }
    }
    lastPan = null;
  };
  lb.addEventListener('pointerup', up);
  lb.addEventListener('pointercancel', up);
  lb.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
  }, { passive: false });

  function close() {
    removeEventListener('resize', reset);
    removeEventListener('keydown', onKey);
    lb.remove();
    document.body.style.overflow = '';
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  addEventListener('keydown', onKey);
  closeBtn.onclick = close;
  setTimeout(() => hint.classList.add('gone'), 2600);
}

/* ── 라우터 ─────────────────────────────── */
function navbar(active) {
  const nav = $('#nav');
  nav.textContent = '';
  (INDEX.channels || []).forEach(c => {
    const a = el('a', c.id === active ? 'on' : '');
    a.append(chIcon(c, 'xs'), el('span', null, c.label));
    a.href = '#/c/' + c.id;
    nav.append(a);
  });
  $('.top').hidden = false;
}

async function route() {
  const view = $('#view');
  const { path, kind, arg, qs } = parseHash();
  try {
    await loadIndex();
    navbar(kind === 'c' ? arg : null);
    view.textContent = '';
    view.append(el('div', 'boot', '불러오는 중…'));
    let node;
    if (kind === 'a' && arg)      node = await renderArticle(arg);
    else if (kind === 'c' && arg) node = renderChannel(arg, qs);
    else                          node = renderHome();
    view.textContent = '';
    view.append(node);
    $('.top').classList.remove('hide');
    if (kind !== 'a') {
      // 글에서 뒤로 온 경우 읽던 자리로. 처음 들어온 목록은 저장값이 0 이라 맨 위다.
      const y = savedScroll(path);
      const box = node.querySelector('.list');
      if (y && box && box.reveal) box.reveal(y);
      scrollTo(0, y);
    }
    const cur = kind === 'a' ? (INDEX.articles || []).find(x => x.id === arg) : null;
    document.title = (cur && cur.t) ? cur.t : 'Premium Contents';
  } catch (e) {
    view.textContent = '';
    if (e instanceof AuthError) { openGate(e.message); return; }
    view.append(el('div', 'empty', '문제가 생겼습니다 — ' + e.message));
  }
}

/* 스크롤을 내리면 상단바를 접는다 — 폰에서 세로 52px 는 시황글 두 줄 값이다 */
let lastY = 0;
addEventListener('scroll', () => {
  const y = scrollY, top = $('.top');
  if (!top || top.hidden) return;
  if (y > 140 && y > lastY + 6) top.classList.add('hide');
  else if (y < lastY - 6 || y < 90) top.classList.remove('hide');
  lastY = y;
}, { passive: true });

/* ── 토큰 창 ─────────────────────────────── */
function openGate(msg) {
  const dlg = $('#gate'), err = $('#gate-err');
  $('#gate-input').value = getPat();
  err.hidden = !msg;
  err.textContent = msg || '';
  if (!dlg.open) dlg.showModal();
}

$('#gate-ok').addEventListener('click', async e => {
  e.preventDefault();
  const v = $('#gate-input').value.trim();
  const err = $('#gate-err');
  err.hidden = false;
  err.textContent = '확인 중…';
  const prev = getPat();
  setPat(v);
  try {
    await loadIndex(true);
    $('#gate').close();
    route();
  } catch (x) {
    setPat(prev);
    err.textContent = (x instanceof AuthError)
      ? '토큰이 거부되었습니다. premium-contents 에 Contents:Read 권한이 있는지 확인해 주세요.'
      : '확인 실패 — ' + x.message;
  }
});
$('#gate-cancel').addEventListener('click', () => $('#gate').close());
$('#btn-settings').addEventListener('click', () => openGate(''));

applyTheme(getTheme());
$('#btn-theme').addEventListener('click', () => {
  const was = isDark();
  applyTheme(THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length]);
  // 본문은 iframe 안에 이미 구워진 상태라 CSS 변수로는 안 바뀐다. 밝기가 실제로
  // 뒤집혔을 때만 다시 그린다(캐시에서 읽으므로 네트워크는 타지 않는다).
  if (isDark() !== was) route();
});
// 시스템 설정을 따르는 중이면, OS 가 밤에 어두워질 때 읽던 글도 같이 따라가야 한다
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => {
  if (getTheme() === 'system') route();
});

// 목록을 떠나기 직전 위치를 남긴다 — hashchange 는 이미 새 해시라 여기서는 늦다
addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href^="#/"]');
  if (!a) return;
  if (parseHash().kind !== 'a') saveScroll();
  // 메뉴·카드로 목록에 '새로' 들어갈 땐 맨 위부터 — 지난번 읽던 자리는 뒤로가기 전용이다
  const to = a.getAttribute('href').slice(1);
  if (to.split('/')[1] !== 'a') { try { sessionStorage.removeItem(SCROLL_KEY + to.split('?')[0]); } catch (x) {} }
}, true);
addEventListener('hashchange', route);
route();
