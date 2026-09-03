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
    const r = await fetch('./' + path);
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

function gate(fn) {
  return new Promise((res, rej) => {
    gateQ.push(() => fn().then(res, rej).finally(() => {
      gateRunning--;
      pump();
    }));
    pump();
  });
}
function pump() {
  while (gateRunning < GATE_MAX && gateQ.length) {
    gateRunning++;
    gateQ.shift()();
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
  img.loading = 'lazy';
  img.alt = '';
  // 화면(±300px)에 들어온 카드만 받는다 — 30장을 미리 다 받을 이유가 없다
  let asked = false;
  const load = () => {
    if (asked) return;
    asked = true;
    gate(() => withTimeout(blobUrl(a.p + '/thumb.webp', a.saved), 15000))
      .then(u => { img.src = u; })
      .catch(() => {
        // 끊긴 것은 다음에 다시 볼 때 한 번 더 시도한다(자리표시로 굳히지 않는다)
        asked = false;
        img.classList.add('th-fail');
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
  if (showCh) mt.append(el('span', 'pill ch', c.emoji + ' ' + c.label));
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
}

/* ── 화면: 홈 ───────────────────────────── */
function renderHome() {
  const w = el('div', 'wrap');
  w.append(el('h2', 'sec', '채널'));
  const cards = el('div', 'cards');
  (INDEX.channels || []).forEach(c => {
    const a = el('a', 'card');
    a.href = '#/c/' + c.id;
    a.style.setProperty('--ac', ACOF[c.id]);
    a.append(el('div', 'em', c.emoji), el('div', 'nm', c.label),
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
function renderChannel(id) {
  const c = chOf(id);
  const all = (INDEX.articles || []).filter(a => a.ch === id && live(a));
  const w = el('div', 'wrap');
  w.style.setProperty('--ac', ACOF[id] || 'var(--accent)');
  w.append(el('h2', 'sec', c.emoji + ' ' + c.label + ' · ' + all.length.toLocaleString() + '편'));

  const filters = el('div', 'filters');
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = '제목·카테고리 검색';
  filters.append(search);
  w.append(filters);

  // 카테고리 칩은 실제 저장된 글에 있는 것만 — config 에만 있고 글이 없는 칩은 안 그린다
  const count = {};
  all.forEach(a => { if (a.c) count[a.c] = (count[a.c] || 0) + 1; });
  const cats = Object.keys(count).sort((x, y) => count[y] - count[x]);

  const chips = el('div', 'cats');
  let cur = '';
  const mk = (label, val) => {
    const b = el('button', val === cur ? 'on' : '', label);
    b.onclick = () => {
      cur = val;
      [].forEach.call(chips.children, x => x.classList.remove('on'));
      b.classList.add('on');
      apply();
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
             el('p', null, c.emoji + ' ' + c.label + (a.d ? ' · ' + a.d : '')),
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
  bar.append(back, el('span', null, c.emoji + ' ' + c.label));
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
  st.textContent = FRAME_CSS;
  doc.head.append(st);
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
    const a = el('a', c.id === active ? 'on' : '', c.emoji + ' ' + c.label);
    a.href = '#/c/' + c.id;
    nav.append(a);
  });
  $('.top').hidden = false;
}

async function route() {
  const view = $('#view');
  const parts = (location.hash || '#/').slice(1).split('/');
  const kind = parts[1], arg = parts[2];
  try {
    await loadIndex();
    navbar(kind === 'c' ? arg : null);
    view.textContent = '';
    view.append(el('div', 'boot', '불러오는 중…'));
    let node;
    if (kind === 'a' && arg)      node = await renderArticle(arg);
    else if (kind === 'c' && arg) node = renderChannel(arg);
    else                          node = renderHome();
    view.textContent = '';
    view.append(node);
    $('.top').classList.remove('hide');
    if (kind !== 'a') scrollTo(0, 0);
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

addEventListener('hashchange', route);
route();
