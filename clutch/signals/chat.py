"""Chat replay: message velocity and emote spam as a crowd-reaction signal."""
from __future__ import annotations

import csv
import io
import json
import re
import urllib.request
from typing import Callable

import numpy as np

from . import robust_z

# Twitch's own web client id, used the same way the site's VOD chat panel uses it.
TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
TWITCH_GQL = "https://gql.twitch.tv/gql"
TWITCH_QUERY_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a"

MOODS = {
    "hype": {"pog", "pogchamp", "poggers", "pogu", "pogg", "w", "ww", "www", "letsgo", "lets", "ez", "clip",
             "clipit", "clipped", "insane", "clutch", "goat", "goated", "cracked", "holy", "omg", "wtf", "gg",
             "kreygasm", "hypers", "ezclap", "clap", "catjam", "fire", "🔥", "sheesh", "banger", "no way"},
    "funny": {"lul", "lulw", "kekw", "omegalul", "lmao", "lmfao", "lol", "xd", "icant", "kekl", "pepelaugh",
              "😂", "🤣", "💀", "dead", "haha", "hahaha", "4head"},
    "fail": {"l", "ll", "f", "sadge", "rip", "nooo", "noooo", "pepehands", "biblethump", "notlikethis",
             "throw", "throwing", "choke", "choked", "oof", "monkas", "yikes", "unlucky"},
}
_WORD = re.compile(r"[\w']+|[^\w\s]", re.UNICODE)


def _post(payload) -> list:
    req = urllib.request.Request(
        TWITCH_GQL, data=json.dumps(payload).encode(),
        headers={"Client-ID": TWITCH_CLIENT_ID, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def fetch_twitch(video_id: str, start: float, end: float,
                 progress: Callable[[float], None] = lambda f: None) -> list[tuple[float, str]]:
    """Fetch VOD chat between start and end seconds by paging forward through offsets."""
    video_id = video_id.lstrip("v")
    out, seen, offset = [], set(), int(start)
    while offset < end:
        data = _post([{
            "operationName": "VideoCommentsByOffsetOrCursor",
            "variables": {"videoID": video_id, "contentOffsetSeconds": offset},
            "extensions": {"persistedQuery": {"version": 1, "sha256Hash": TWITCH_QUERY_HASH}},
        }])
        comments = (((data[0].get("data") or {}).get("video") or {}).get("comments") or {})
        edges = comments.get("edges") or []
        last = offset
        for e in edges:
            node = e.get("node") or {}
            if node.get("id") in seen:
                continue
            seen.add(node.get("id"))
            t = float(node.get("contentOffsetSeconds") or 0)
            text = "".join(f.get("text") or "" for f in ((node.get("message") or {}).get("fragments") or []))
            out.append((t, text))
            last = max(last, int(t))
        if not edges or not (comments.get("pageInfo") or {}).get("hasNextPage"):
            break
        offset = last + 1 if last <= offset else last
        progress(min((offset - start) / max(end - start, 1), 1.0))
    return [(t, m) for t, m in out if start <= t <= end]


def parse_youtube_live_chat(text: str) -> list[tuple[float, str]]:
    """Parse the live_chat.json that yt-dlp writes for YouTube stream replays."""
    out = []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        replay = item.get("replayChatItemAction") or {}
        try:
            t = float(replay.get("videoOffsetTimeMsec", 0)) / 1000
        except (TypeError, ValueError):
            continue
        for action in replay.get("actions") or []:
            r = ((action.get("addChatItemAction") or {}).get("item") or {}).get("liveChatTextMessageRenderer")
            if r:
                runs = (r.get("message") or {}).get("runs") or []
                text = "".join(x.get("text") or ((x.get("emoji") or {}).get("emojiId") or "") for x in runs)
                out.append((t, text))
    return out


def _clock(s: str) -> float:
    total = 0.0
    for part in s.split(":"):
        total = total * 60 + float(part)
    return total


def parse_file(data: bytes) -> list[tuple[float, str]]:
    """Read an exported chat log: TwitchDownloader JSON, yt-dlp live_chat, CSV (time,user,message) or '[h:mm:ss] user: msg' lines."""
    text = data.decode("utf-8", errors="ignore").lstrip("﻿")
    stripped = text.lstrip()
    if stripped.startswith("{") and '"comments"' in stripped[:5000]:
        doc = json.loads(stripped)
        return [(float(c.get("content_offset_seconds") or 0), (c.get("message") or {}).get("body") or "")
                for c in doc.get("comments") or []]
    if "replayChatItemAction" in stripped[:5000]:
        return parse_youtube_live_chat(text)
    out = []
    line_re = re.compile(r"^\[?(\d+(?::\d{1,2}){1,2}(?:\.\d+)?)\]?\s*(?:[^:]{1,40}:)?\s*(.*)$")
    for row in csv.reader(io.StringIO(text)):
        if len(row) >= 2:
            try:
                t = _clock(row[0].strip("[] "))
            except ValueError:
                continue
            out.append((t, row[-1]))
        elif row:
            m = line_re.match(row[0])
            if m:
                out.append((_clock(m.group(1)), m.group(2)))
    return out


def score(messages: list[tuple[float, str]], n: int, delay: float = 6.0) -> dict:
    """Turn messages into a 1 Hz hype signal, shifted earlier because chat reacts late."""
    rate, moods = np.zeros(n), {k: np.zeros(n) for k in MOODS}
    for t, text in messages:
        i = int(t - delay)
        if not 0 <= i < n:
            continue
        tokens = {tok.lower() for tok in _WORD.findall(text)}
        weight = 1.0
        for mood, vocab in MOODS.items():
            if tokens & vocab:
                moods[mood][i] += 1
                weight = 2.0          # emote spam counts double
        if len(text) >= 4 and text.isupper():
            weight += 0.5
        rate[i] += weight
    kernel = np.ones(5) / 5
    smooth = np.convolve(rate, kernel, mode="same")
    return {
        "chat": robust_z(smooth, window=181),
        "moods": {k: np.convolve(v, kernel, mode="same") for k, v in moods.items()},
        "count": len(messages),
    }
