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
const PAGE  = 30;                   // 목록 한 번에 그리는 개수

// 채널 구분색. 목록에서 어느 채널 글인지 색으로 먼저 읽히게 한다.
const ACCENTS = ['#e0803c', '#7b61c9', '#2f8f6b', '#c05a7d', '#3b7fd4'];

const $  = (s, r = document) => r.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c;
                          if (x != null) n.textContent = x; return n; };

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
  if (r.status === 404) throw new Error('없는 파일: ' + path);
  if (!r.ok) throw new Error('읽기 실패 ' + r.status);
  return asBlob ? r.blob() : r.text();
}

async function blobUrl(path) {
  if (BLOBS.has(path)) return BLOBS.get(path);
  const u = URL.createObjectURL(await ghRaw(path, true));
  BLOBS.set(path, u);
  return u;
}

/* ── 색인 ───────────────────────────────── */
async function loadIndex(force) {
  if (INDEX && !force) return INDEX;
  INDEX = JSON.parse(await ghRaw('index.json'));
  (INDEX.channels || []).forEach((c, i) => { ACOF[c.id] = ACCENTS[i % ACCENTS.length]; });
  return INDEX;
}
const chOf = id => (INDEX.channels || []).find(c => c.id === id) || { label: id, emoji: '📰' };

/* ── 조각 ───────────────────────────────── */
function thumb(a) {
  if (!a.th) return el('div', 'th ph', '📄');
  const img = el('img', 'th');
  img.loading = 'lazy';
  img.alt = '';
  blobUrl(a.p + '/thumb.webp').then(u => { img.src = u; })
    .catch(() => { img.replaceWith(el('div', 'th ph', '📄')); });
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
  listInto(box, INDEX.articles || [], true);
  return w;
}

/* ── 화면: 채널 ─────────────────────────── */
function renderChannel(id) {
  const c = chOf(id);
  const all = (INDEX.articles || []).filter(a => a.ch === id);
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
  return w;
}

/* ── 화면: 기사 ─────────────────────────── */
// 뷰어 안에서는 저장본 자체의 상단 바를 숨기고 종이를 화면에 꽉 채운다.
// (그 바는 repo 를 그냥 폴더로 열었을 때를 위한 것이다)
const FRAME_CSS = [
  '.bar{display:none!important}',
  'body{background:transparent}',
  '.paper{margin:0 auto 40px;border-radius:12px}',
  'img[data-pc]{background:rgba(127,127,127,.08);min-height:40px}'
].join('\n');

async function renderArticle(id) {
  const a = (INDEX.articles || []).find(x => x.id === id);
  const wrap = el('div', 'reader');
  if (!a) {
    wrap.append(el('div', 'empty', '색인에 없는 글입니다. 아직 보존되지 않았거나 주소가 잘못됐습니다.'));
    return wrap;
  }
  const c = chOf(a.ch);
  const bar = el('div', 'rbar');
  const back = el('a', 'back', '← 목록');
  back.href = '#/c/' + a.ch;
  bar.append(back, el('span', null, c.emoji + ' ' + c.label));
  if (a.d) bar.append(el('span', 'dot'), el('span', null, a.d));
  const grow = el('div', 'grow');
  const src = el('a', null, '원문 ↗');
  src.href = a.src;
  src.target = '_blank';
  src.rel = 'noopener';
  grow.append(src);
  bar.append(grow);

  const prog = el('div', 'prog');
  const frame = el('iframe');
  frame.id = 'frame';
  wrap.append(bar, prog, frame);

  const html = await ghRaw(a.p + '/index.html');
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
    fit();
    new ResizeObserver(fit).observe(d.body);
    fillImages(d, a.p, prog, fit);
  };
  return wrap;
}

/** 이미지를 동시 6장씩 받아 채운다. GitHub API 는 시간당 5,000회라 한 글에 60장이어도 넉넉하다. */
async function fillImages(d, base, prog, fit) {
  const queue = [].slice.call(d.querySelectorAll('img[data-pc]'));
  const total = queue.length;
  if (!total) { prog.remove(); return; }
  let done = 0;
  async function next() {
    const t = queue.shift();
    if (!t) return;
    try {
      t.src = await blobUrl(base + '/' + t.dataset.pc);
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
  await Promise.all(Array.from({ length: 6 }, next));
  fit();
  setTimeout(() => prog.remove(), 400);
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
    if (kind !== 'a') scrollTo(0, 0);
    const cur = kind === 'a' ? (INDEX.articles || []).find(x => x.id === arg) : null;
    document.title = (cur && cur.t) ? cur.t : 'Premium Contents';
  } catch (e) {
    view.textContent = '';
    if (e instanceof AuthError) { openGate(e.message); return; }
    view.append(el('div', 'empty', '문제가 생겼습니다 — ' + e.message));
  }
}

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
