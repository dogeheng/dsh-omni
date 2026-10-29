#!/usr/bin/env python3
"""Small JSON bridge around qqmusic-api-python for the cover pipeline.

stdin:  {"action":"search|resolve|lyric", ...}
stdout: {"ok":true,...} or {"ok":false,"error":"...","stage":"..."}
No decryption, no encrypted file types, no credential/cookie is handled here.
"""
import asyncio
import json
import re
import sys

from qqmusic_api import lyric, search, song
from qqmusic_api.search import SearchType
from qqmusic_api.song import SongFileType

FILE_TYPES = {"M500": SongFileType.MP3_128, "M800": SongFileType.MP3_320,
              "F000": SongFileType.FLAC}


def version_of(title: str) -> str:
    # "雨爱 (司凤版)" -> "司凤版"; leave ordinary titles empty.
    m = re.search(r"[（(]([^）)]+)[）)]", title or "")
    return m.group(1).strip() if m else ""


def tags_of(title: str) -> list:
    raw = version_of(title)
    return [raw] if raw else []


def normalize(item: dict) -> dict:
    title = str(item.get("title") or item.get("name") or "").strip()
    singers = item.get("singer") or []
    artist = "、".join(str(s.get("name", "")) for s in singers if isinstance(s, dict) and s.get("name"))
    file = item.get("file") or {}
    pay = item.get("pay") or {}
    vs = item.get("vs") or []
    vs0 = next((v for v in vs if v), "")
    return {
        "source": "qqmusic",
        "id": str(item.get("mid") or ""),
        "mid": str(item.get("mid") or ""),
        "songId": item.get("id"),
        "title": title,
        "artist": artist,
        "version": version_of(title),
        "tags": tags_of(title),
        "duration": int(item.get("interval") or 0),
        "album": str((item.get("album") or {}).get("name") or ""),
        "pay": {
            "payDown": int(pay.get("pay_down") or 0),
            "payPlay": int(pay.get("pay_play") or 0),
            "payMonth": int(pay.get("pay_month") or 0),
            "priceTrack": int(pay.get("price_track") or 0),
            "timeFree": int(pay.get("time_free") or 0),
        },
        "preview": bool(file.get("size_try")),
        "vs": vs0,
        "license": "QQMusic platform URL (operator-authorised use only)",
    }


async def run(req: dict) -> dict:
    action = req.get("action")
    if action == "search":
        keyword = str(req.get("keyword") or "").strip()
        if not keyword:
            raise ValueError("keyword is empty")
        rows = await search.search_by_type(keyword=keyword, search_type=SearchType.SONG, num=min(20, int(req.get("num") or 10)))
        return {"ok": True, "results": [normalize(x) for x in rows]}
    if action == "resolve":
        mid = str(req.get("mid") or "").strip()
        if not mid:
            raise ValueError("mid is empty")
        kind = str(req.get("fileType") or "M500").upper()
        if kind not in FILE_TYPES:
            raise ValueError("unsupported/encrypted file type")
        pay = req.get("pay") or {}
        paid = any(int(pay.get(k) or 0) for k in ("payDown", "payPlay", "payMonth", "priceTrack"))
        if paid and not req.get("allowPaidMedia"):
            return {"ok": False, "stage": "no_authorized_url", "error": "QQ 音乐标记为付费/会员，未开启 allowPaidMedia"}
        urls = await song.get_song_urls([mid], file_type=FILE_TYPES[kind])
        url = urls.get(mid) or ""
        is_preview = False
        if not url and req.get("previewFallback"):
            vs = str(req.get("vs") or "")
            if vs:
                url = await song.get_try_url(mid, vs)
                is_preview = bool(url)
        if not url:
            return {"ok": False, "stage": "no_authorized_url", "error": "QQ 音乐没有返回可播放地址（可能是版权/会员/地区限制）"}
        if re.search(r"\.(mflac|mgg|ncm)(\?|$)", url, re.I):
            return {"ok": False, "stage": "drm_protected", "error": "返回的是加密格式，拒绝处理"}
        return {"ok": True, "url": url, "isPreview": is_preview, "ext": "mp3" if kind != "F000" else "flac"}
    if action == "lyric":
        mid = str(req.get("mid") or "").strip()
        if not mid:
            raise ValueError("mid is empty")
        data = await lyric.get_lyric(mid=mid)
        return {"ok": True, "lyric": data.get("lyric") or ""}
    raise ValueError("unknown action")


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
        out = asyncio.run(asyncio.wait_for(run(req), timeout=float(req.get("timeoutMs") or 15000) / 1000))
    except Exception as exc:
        out = {"ok": False, "stage": "online_error", "error": f"{type(exc).__name__}: {str(exc)[:240]}"}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
