"""Fast checks that need no video: python -m pytest tests"""
import numpy as np

from clutch import captions, highlights
from clutch.signals import chat, visual


def test_find_clips_picks_the_planted_peaks():
    n = 300
    audio, kills = np.zeros(n), np.zeros(n)
    audio[100:105] = 5
    kills[[100, 102, 103]] = 4
    audio[220:223] = 4
    events = [{"t": t, "kind": "kill", "strength": 2} for t in (100, 102, 103)]
    clips = highlights.find_clips({"audio": audio, "kills": kills}, {"audio": 1, "kills": 1.5}, events,
                                  min_len=15, max_len=45, max_clips=5, pre_roll=6, post_roll=3)
    assert len(clips) == 2
    assert clips[0]["start"] <= 100 <= clips[0]["end"] and "Triple kill" in clips[0]["tags"]
    assert all(15 <= c["end"] - c["start"] <= 45 for c in clips)


def test_kill_feed_rows_count_separately():
    d = np.full(120, 0.01)
    d[40:52] += 0.03      # first row
    d[43:55] += 0.03      # second row 1.5 s later
    assert [t for t, _ in visual.find_steps(d)] == [20.0, 21.5]


def test_chat_parsing_and_spike():
    log = "\n".join([f"[0:{s:02d}] bob: hello" for s in range(0, 60, 5)] + ["[0:40] a: KEKW KEKW"] * 20)
    msgs = chat.parse_file(log.encode())
    assert len(msgs) == 32
    scored = chat.score(msgs, 60, delay=6)
    assert 30 <= int(np.argmax(scored["chat"])) <= 38
    assert scored["moods"]["funny"].sum() > 0


def test_captions_highlight_one_word_at_a_time():
    words = [[10.0, 10.3, "no"], [10.4, 10.7, "way,"], [10.8, 11.2, "bro"]]
    ass = captions.build_ass(words, 9.0, 20.0, y=1382, title="Clutch")
    lines = [l for l in ass.splitlines() if l.startswith("Dialogue: 0")]
    assert len(lines) == 3 and "NO WAY" in ass.replace("{\\c&H3DC5FF&}", "").replace("{\\c&HFFFFFF&}", "")
    assert "Dialogue: 1" in ass


def test_phone_pairing_gate(tmp_path, monkeypatch):
    from clutch import config, phone
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path / "projects")
    key = phone.key()
    assert phone.key() == key                      # stable across calls
    assert phone.allowed("127.0.0.1", "")          # this PC always gets in
    assert not phone.allowed("192.168.1.50", "")   # other devices need the key
    assert not phone.allowed("192.168.1.50", "wrong")
    assert phone.allowed("192.168.1.50", key)
    assert "<svg" in phone.qr_svg("http://192.168.1.2:8765/?key=" + key)
