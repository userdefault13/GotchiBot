#!/usr/bin/env python3
"""Speak via MeloTTS (EN-AU gotchi voice). Uses daemon if running."""
import json
import os
import socket
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOCK = os.path.join(ROOT, "sessions", ".melo-tts.sock")


def _patch_transformers():
    import transformers.utils.versions as v

    orig = v.require_version

    def relaxed(req, hint=None):
        if "tokenizers" in req:
            return
        return orig(req, hint)

    v.require_version = relaxed


def speaker_id(spk2id, speaker):
    if speaker not in spk2id:
        known = list(spk2id.keys()) if hasattr(spk2id, "keys") else []
        raise KeyError(f"unknown speaker: {speaker} (have {known})")
    return spk2id[speaker]


def synthesize(text, speaker="EN-AU", speed=1.05, out_path=None):
    _patch_transformers()
    from melo.api import TTS

    out_path = out_path or tempfile.mktemp(suffix=".wav", prefix="gotchi-melo-")
    model = TTS(language="EN", device=os.environ.get("GOTCHIBOT_MELO_DEVICE", "cpu"))
    sid = speaker_id(model.hps.data.spk2id, speaker)
    model.tts_to_file(text, sid, out_path, speed=float(speed))
    return out_path


def via_daemon(text, speaker, speed):
    if not os.path.exists(SOCK):
        return None
    payload = json.dumps({"text": text, "speaker": speaker, "speed": speed}) + "\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(120)
        s.connect(SOCK)
        s.sendall(payload.encode())
        resp = s.recv(4096).decode().strip()
    data = json.loads(resp)
    if not data.get("ok"):
        return None
    return data.get("path")


def main():
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("text")
    p.add_argument("--speaker", default=os.environ.get("GOTCHIBOT_MELO_SPEAKER", "EN-AU"))
    p.add_argument("--speed", type=float, default=float(os.environ.get("GOTCHIBOT_MELO_SPEED", "1.05")))
    p.add_argument("--play", action="store_true", default=True)
    p.add_argument("--no-play", dest="play", action="store_false")
    args = p.parse_args()

    text = args.text.strip()
    if not text:
        return

    wav = via_daemon(text, args.speaker, args.speed)
    if not wav:
        wav = synthesize(text, args.speaker, args.speed)

    if args.play and sys.platform == "darwin":
        subprocess.run(["afplay", wav], check=False)


if __name__ == "__main__":
    main()
