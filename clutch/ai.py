"""Optional AI pass: rank candidate clips and write titles. Runs only when ANTHROPIC_API_KEY is set."""
from __future__ import annotations

import json
import os

from . import config

SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "score": {"type": "integer", "description": "0-100: how well this works as a standalone short"},
                    "title": {"type": "string", "description": "Short punchy title, under 60 characters"},
                    "mood": {"type": "string", "enum": ["clutch", "funny", "rage", "fail", "hype", "skill", "other"]},
                    "reason": {"type": "string", "description": "One sentence on why it works or doesn't"},
                },
                "required": ["id", "score", "title", "mood", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clips"],
    "additionalProperties": False,
}

SYSTEM = """You help a gaming creator pick moments from a stream or gameplay video to post as vertical shorts \
(TikTok, YouTube Shorts, Reels).

For each candidate you get what the detectors measured (how far audio loudness, chat activity and on-screen \
action rose above the video's baseline, plus kill-feed events) and the streamer's transcript for that span. \
Transcripts come from automatic speech recognition over game audio, so expect misheard words and gaps.

Score each candidate 0-100 on how well it would hold a viewer as a standalone short: a clear payoff \
(clutch, multi-kill, fail, funny reaction, rage), understandable without the rest of the stream, and a \
strong first few seconds. A loud moment with no payoff scores low. Write titles the way gaming shorts are \
actually titled: specific to what happens, casual, no hashtags, and never claim something the evidence \
doesn't show."""


def available() -> bool:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    try:
        import anthropic  # noqa: F401
        return True
    except ImportError:
        return False


def rank(clips: list[dict], *, video_title: str, game: str) -> dict[str, dict]:
    """Return {clip_id: {score, title, mood, reason}}. Raises RuntimeError with a readable message on failure."""
    import anthropic

    payload = [{
        "id": c["id"],
        "length_seconds": round(c["end"] - c["start"]),
        "detector_tags": c["tags"],
        "kill_feed_events": c["kills"],
        "signal_peaks_in_std_devs": {k: round(v, 1) for k, v in c.get("contrib", {}).items()},
        "chat_mood": c.get("mood") or "unknown",
        "transcript": c.get("transcript") or "(no speech detected)",
    } for c in clips]
    user = (f"Video title: {video_title}\nGame: {game}\n\nCandidates:\n{json.dumps(payload, indent=1)}\n\n"
            "Return one entry per candidate id.")

    client = anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=config.AI_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
            system=SYSTEM,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.AuthenticationError as e:
        raise RuntimeError("AI ranking skipped: the Anthropic API key was rejected.") from e
    except anthropic.RateLimitError as e:
        raise RuntimeError("AI ranking skipped: rate limited by the Anthropic API.") from e
    except anthropic.APIStatusError as e:
        raise RuntimeError(f"AI ranking skipped: the API returned {e.status_code}.") from e
    except anthropic.APIConnectionError as e:
        raise RuntimeError("AI ranking skipped: could not reach the Anthropic API.") from e

    if response.stop_reason == "refusal":
        raise RuntimeError("AI ranking skipped: the model declined this request.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("AI ranking skipped: the response was cut off.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError("AI ranking skipped: the response was not valid JSON.") from e
    return {item["id"]: item for item in data.get("clips", [])}
