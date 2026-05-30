#!/usr/bin/env python
"""
extract_prompts.py — OpenAI-powered "watch the video and find the prompts" pipeline.

For one YouTube video already downloaded under docs/blueprint/raw/<id>/ (video.mp4,
frames/*.jpg, *.vtt subtitles), this:

  1. Perceptually de-dupes the keyframes (a prompt/code screen persists across many
     frames; we keep one representative per distinct screen).
  2. OCRs each unique frame with OpenAI gpt-4o-mini vision — transcribing ALL on-screen
     text verbatim, prioritising agent system/user prompts, code, terminal commands,
     tool/function names, model names, and trading rules.
  3. Loads the auto-caption transcript.
  4. Synthesises everything with OpenAI gpt-4.1 into a replication blueprint:
     verbatim prompts + full agent architecture + how-to-rebuild.

Outputs (under docs/blueprint/<id>/):
  ocr_all.md        — per-frame OCR with approx timestamps
  transcript.txt    — cleaned narration
  PROMPTS.md        — synthesised: exact prompts + architecture + replication steps
  extracted.json    — structured machine-readable summary

Keys are loaded "off the land" from GTMEngineering/.env (OPENAI_API_KEY).
Usage: python extract_prompts.py <video_id> [--ocr-model gpt-4o-mini] [--max-frames 220]
"""
from __future__ import annotations
import argparse, base64, json, os, re, sys, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image
import imagehash
from openai import OpenAI

HFT = Path("/Users/isaiahdupree/Documents/Software/HFT")
RAW = HFT / "docs/blueprint/raw"
OUT = HFT / "docs/blueprint"


def load_openai_key() -> str:
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    env = Path("/Users/isaiahdupree/Documents/Software/GTMEngineering/.env")
    for line in env.read_text().splitlines():
        if line.startswith("OPENAI_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("No OPENAI_API_KEY found")


def dedupe_frames(frames_dir: Path, max_frames: int, hash_cut: int) -> list[Path]:
    """Keep frames whose perceptual hash differs from the last kept frame.
    Collapses long runs of an identical screen into one representative."""
    files = sorted(frames_dir.glob("*.jpg"))
    kept: list[Path] = []
    last_hash = None
    for f in files:
        try:
            h = imagehash.dhash(Image.open(f), hash_size=12)
        except Exception:
            continue
        if last_hash is None or (h - last_hash) >= hash_cut:
            kept.append(f)
            last_hash = h
    # If still too many, thin uniformly (keep order/coverage).
    if len(kept) > max_frames:
        step = len(kept) / max_frames
        kept = [kept[int(i * step)] for i in range(max_frames)]
    return kept


OCR_PROMPT = (
    "You are transcribing a single frame from a screen-recording where a developer is "
    "building and testing an AI trading agent. Transcribe ALL text visible on screen, "
    "VERBATIM and complete. Prioritise and never paraphrase: (1) any prompt given to an AI "
    "model — system prompts, user/instruction prompts, agent role text; (2) source code; "
    "(3) terminal commands and their output; (4) tool/function names, API names, model names "
    "(e.g. claude-opus, gpt, hyperliquid, polymarket, alpaca); (5) trading rules, risk limits, "
    "position sizing, parameters; (6) config / JSON / env keys (mask secret VALUES as <redacted> "
    "but keep the KEY names). Preserve code formatting and line breaks. "
    "If the frame is a talking-head, logo, plain slide, or has no code/prompt/terminal/config, "
    "reply with exactly: NO_CONTENT"
)


def ocr_frame(client: OpenAI, model: str, path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode()
    resp = client.chat.completions.create(
        model=model,
        temperature=0,
        max_tokens=1500,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": OCR_PROMPT},
                {"type": "image_url", "image_url": {
                    "url": f"data:image/jpeg;base64,{b64}", "detail": "high"}},
            ],
        }],
    )
    return (resp.choices[0].message.content or "").strip()


def clean_vtt(vtt_path: Path) -> str:
    if not vtt_path.exists():
        return ""
    lines, seen = [], set()
    for ln in vtt_path.read_text(errors="ignore").splitlines():
        ln = ln.strip()
        if not ln or ln == "WEBVTT" or "-->" in ln or ln.startswith(("Kind:", "Language:")):
            continue
        ln = re.sub(r"<[^>]+>", "", ln)  # strip inline timing tags
        if ln and ln not in seen:
            seen.add(ln)
            lines.append(ln)
    return " ".join(lines)


SYNTH_PROMPT = """You are reverse-engineering how an AI trading agent was built, from a YouTube tutorial.
Below is (A) verbatim OCR of every distinct on-screen frame (code editors, terminals, prompt windows, configs) in time order, and (B) the narrator transcript.

Produce a COMPLETE replication blueprint in Markdown with these exact sections:

## 1. Exact prompts (verbatim)
Reproduce every AI prompt shown on screen WORD-FOR-WORD inside ``` fences — system prompts, agent role prompts, instruction prompts, tool descriptions. Label each (e.g. "System prompt", "Trade-decision prompt"). If a prompt is only partially visible, reproduce what's shown and mark [partially visible].

## 2. Agent architecture
- Model(s) used (exact names/versions)
- Agent framework / SDK / harness (e.g. Claude Agent SDK, OpenAI SDK, custom loop)
- Tools / functions the agent can call (names + what they do)
- The decision loop (step by step: observe -> reason -> act -> record)
- Memory / state / logging

## 3. Market & data
- Venue(s) (Hyperliquid, Polymarket, Alpaca, etc.) and why
- Data sources / feeds / indicators consumed
- Order types, position sizing, leverage

## 4. Risk & capital controls
Stop-losses, max position, daily loss limits, kill switches, sim-vs-real handling.

## 5. Results shown
Any P&L, win rate, trades, or outcomes visible.

## 6. How to replicate (concrete steps)
Numbered build steps to recreate THIS agent in our own workspace.

Be faithful to what is actually shown — do not invent prompts. If something isn't visible, write "not shown".
Quote OCR'd code/prompts exactly rather than summarising them.

=== (A) ON-SCREEN OCR (time-ordered) ===
{ocr}

=== (B) NARRATOR TRANSCRIPT ===
{transcript}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video_id")
    ap.add_argument("--ocr-model", default="gpt-4o-mini")
    ap.add_argument("--synth-model", default="gpt-4.1")
    ap.add_argument("--max-frames", type=int, default=220)
    ap.add_argument("--hash-cut", type=int, default=14)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    vid = args.video_id
    raw_dir = RAW / vid
    frames_dir = raw_dir / "frames"
    out_dir = OUT / vid
    out_dir.mkdir(parents=True, exist_ok=True)

    client = OpenAI(api_key=load_openai_key())

    kept = dedupe_frames(frames_dir, args.max_frames, args.hash_cut)
    print(f"[{vid}] {len(list(frames_dir.glob('*.jpg')))} frames -> {len(kept)} unique screens", flush=True)

    # frame number -> approx seconds. Frames were sampled scene+every-5s; we only have
    # ordinal positions, so estimate time by fractional position over total duration unknown.
    # Use the frame index label for traceability instead.
    results: dict[str, str] = {}
    lock = threading.Lock()
    done = 0

    def work(p: Path):
        nonlocal done
        try:
            txt = ocr_frame(client, args.ocr_model, p)
        except Exception as e:
            txt = f"ERROR: {e}"
        with lock:
            results[p.name] = txt
            done += 1
            if done % 20 == 0:
                print(f"[{vid}] OCR {done}/{len(kept)}", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, kept))

    # Assemble OCR, dropping NO_CONTENT frames.
    ocr_md_lines, ocr_blob = [], []
    for p in kept:
        txt = results.get(p.name, "")
        if not txt or txt.strip().upper().startswith("NO_CONTENT"):
            continue
        ocr_md_lines.append(f"### {p.name}\n\n{txt}\n")
        ocr_blob.append(f"[{p.name}]\n{txt}")
    (out_dir / "ocr_all.md").write_text(
        f"# On-screen OCR — {vid}\n\n{len(ocr_md_lines)} content-bearing frames "
        f"(of {len(kept)} unique screens).\n\n" + "\n".join(ocr_md_lines))

    transcript = clean_vtt(next(iter(raw_dir.glob("*.vtt")), Path("/nonexistent")))
    (out_dir / "transcript.txt").write_text(transcript)

    # Synthesis. Truncate to keep within context (gpt-4.1 = 1M ctx, generous).
    ocr_text = "\n\n".join(ocr_blob)[:500_000]
    synth = client.chat.completions.create(
        model=args.synth_model,
        temperature=0.1,
        max_tokens=6000,
        messages=[{"role": "user", "content": SYNTH_PROMPT.format(
            ocr=ocr_text, transcript=transcript[:120_000])}],
    )
    blueprint = synth.choices[0].message.content or ""
    (out_dir / "PROMPTS.md").write_text(f"# Replication blueprint — {vid}\n\n{blueprint}\n")
    (out_dir / "extracted.json").write_text(json.dumps({
        "video_id": vid,
        "unique_screens": len(kept),
        "content_frames": len(ocr_md_lines),
        "ocr_model": args.ocr_model,
        "synth_model": args.synth_model,
        "has_transcript": bool(transcript),
    }, indent=2))
    print(f"[{vid}] DONE -> {out_dir}/PROMPTS.md ({len(blueprint)} chars)", flush=True)


if __name__ == "__main__":
    main()
