# -*- coding: utf-8 -*-
"""채널별 대표 아이콘을 내려받아 icons/<id>.png (128x128) 로 만든다.

채널을 새로 붙이면 SRC 에 한 줄 넣고 이 스크립트를 돌린다. 아이콘 파일이 없으면
뷰어가 index.json 의 이모지로 되돌아가므로, 안 돌려도 화면이 깨지지는 않는다.

원본은 사이트마다 크기·비율이 제각각이라 정사각으로 맞춘다. 비율이 크게 다른
배너형(og:image)은 가운데를 잘라 쓴다 — 채널 프로필은 대개 가운데에 로고가 있다.
"""
import io, json, os, sys
import requests
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"}
OUT = r"C:\ClaudeCode\premium-viewer\icons"
os.makedirs(OUT, exist_ok=True)

cfg = json.load(io.open(r"C:\ClaudeCode\naver-contents-monitor\config.json", encoding="utf-8"))
CK = cfg["naver_cookies"]

SRC = {
    # 네이버 3채널 — og:image 가 각 채널 프로필
    "nasdaq":       ("naver", "og"),
    "hsacademy1":   ("naver", "og"),
    "stockideas":   ("naver", "og"),
    "heisenberg":   ("url", "https://heisenberg.kr/wp-content/uploads/2026/07/cropped-Frame-232-192x192.png"),
    "seekingalpha": ("url", "https://seekingalpha.com/samw/static/images/favicon-192x192.png"),
    "valley":       ("url", "https://valley.town/apple-icon.png?apple-icon.0qthcefrl4818.png"),
    # Substack 발행물은 apple-touch-icon 이 가장 큰 정사각 로고다(og:image 는 구독 카드 배너라 안 맞다)
    "semianalysis": ("url", "https://substackcdn.com/image/fetch/$s_!Dypw!,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F0f02aaaa-9a11-47db-8aee-d57188ddabf9%2Fapple-touch-icon-1024x1024.png"),
}

idx = json.load(io.open(r"C:\ClaudeCode\premium-contents\index.json", encoding="utf-8"))
chans = {c["id"]: c for c in idx["channels"]}


def og_of(url):
    from bs4 import BeautifulSoup
    html = requests.get(url, headers=H, cookies=CK, timeout=20).text
    m = BeautifulSoup(html, "html.parser").select_one("meta[property='og:image']")
    return m["content"] if m and m.get("content") else None


for cid, (kind, val) in SRC.items():
    ch = chans[cid]
    src = og_of(ch["url"]) if kind == "naver" else val
    if not src:
        print("%-13s og:image 없음 — 건너뜀" % cid)
        continue
    ck = CK if "naver" in src or "pstatic" in src else {}
    r = requests.get(src, headers=H, cookies=ck, timeout=25)
    im = Image.open(io.BytesIO(r.content))
    w, h = im.size
    im = im.convert("RGBA")
    # 정사각 중앙 크롭
    if w != h:
        s = min(w, h)
        im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    im = im.resize((128, 128), Image.LANCZOS)
    p = os.path.join(OUT, cid + ".png")
    im.save(p, "PNG", optimize=True)
    print("%-13s %-5s 원본 %dx%d -> 128x128  %5dB  %s"
          % (cid, kind, w, h, os.path.getsize(p), os.path.basename(p)))
