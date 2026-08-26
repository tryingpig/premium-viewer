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

/* ── 이미지 확대 ─────────────────────────
 * 차트·표가 이미지로 들어있는 글이라 확대가 본문 글자 크기보다 중요하다.
 * 두 손가락 확대 / 두 번 탭 / 끌어서 이동. 열릴 때는 화면에 맞춰 놓는다. */
function openZoom(src) {
  const lb = el('div', 'lb');
  const img = el('img');
  const closeBtn = el('button', 'lb-x', '✕');
  closeBtn.setAttribute('aria-label', '닫기');
  const hint = el('div', 'lb-hint', '두 손가락으로 확대 · 두 번 탭하면 원본 크기 · 바깥을 탭하면 닫힘');
  lb.append(img, closeBtn, hint);
  document.body.append(lb);
  document.body.style.overflow = 'hidden';

  let scale = 1, tx = 0, ty = 0, base = 1;
  const apply = () => {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  };

  const reset = () => {
    const vw = innerWidth, vh = innerHeight;
    const iw = img.naturalWidth || vw, ih = img.naturalHeight || vh;
    base = Math.min(vw / iw, vh / ih, 1);
    scale = base;
    tx = (vw - iw * base) / 2;
    ty = (vh - ih * base) / 2;
    apply();
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
        if (scale > base * 1.05) reset();
        else zoomAt(1 / base, e.clientX, e.clientY);
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
