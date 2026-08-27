#!/usr/bin/env python3
"""Keep MeloTTS loaded; speak on unix socket (fast repeated phrases)."""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOCK = os.path.join(ROOT, "sessions", ".melo-tts.sock")
PID = os.path.join(ROOT, "sessions", ".melo-tts.pid")


def _patch_transformers():
    import transformers.utils.versions as v

    orig = v.require_version

    def relaxed(req, hint=None):
        if "tokenizers" in req:
            return
        return orig(req, hint)

    v.require_version = relaxed


def load_model():
    _patch_transformers()
    from melo.api import TTS

    device = os.environ.get("GOTCHIBOT_MELO_DEVICE", "cpu")
    model = TTS(language="EN", device=device)
    return model, model.hps.data.spk2id


def speaker_id(spk2id, speaker):
    if speaker not in spk2id:
        known = list(spk2id.keys()) if hasattr(spk2id, "keys") else []
        raise KeyError(f"unknown speaker: {speaker} (have {known})")
    return spk2id[speaker]


def cleanup(*_):
    try:
        os.unlink(SOCK)
    except OSError:
        pass
    try:
        os.unlink(PID)
    except OSError:
        pass
    sys.exit(0)


def main():
    os.makedirs(os.path.dirname(SOCK), exist_ok=True)
    if os.path.exists(SOCK):
        os.unlink(SOCK)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    model, speaker_ids = load_model()

    with open(PID, "w") as f:
        f.write(str(os.getpid()))

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK)
    server.listen(4)
    sys.stderr.write(f"melo-daemon ready ({SOCK})\n")

    while True:
        conn, _ = server.accept()
        try:
            raw = conn.recv(65536).decode().strip()
            req = json.loads(raw)
            text = str(req.get("text", "")).strip()
            speaker = req.get("speaker", "EN-AU")
            speed = float(req.get("speed", 1.05))
            if not text:
                conn.sendall(json.dumps({"ok": False, "error": "empty"}).encode())
                continue
            sid = speaker_id(speaker_ids, speaker)
            out = tempfile.mktemp(suffix=".wav", prefix="gotchi-melo-")
            model.tts_to_file(text, sid, out, speed=speed)
            conn.sendall(json.dumps({"ok": True, "path": out}).encode())
        except Exception as e:
            conn.sendall(json.dumps({"ok": False, "error": str(e)}).encode())
        finally:
            conn.close()


if __name__ == "__main__":
    main()
