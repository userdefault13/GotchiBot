#!/usr/bin/env bash
# One-time MeloTTS venv for GotchiBot (EN-AU gotchi voice).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv/melo"
MELO_SRC="${GOTCHIBOT_MELO_SRC:-/tmp/MeloTTS}"

echo "Creating MeloTTS venv at $VENV …"
python3 -m venv "$VENV"
# shellcheck source=/dev/null
source "$VENV/bin/activate"

pip install -U pip wheel
if [ ! -d "$MELO_SRC" ]; then
  git clone --depth 1 https://github.com/myshell-ai/MeloTTS.git "$MELO_SRC"
fi

brew list mecab >/dev/null 2>&1 || brew install mecab mecab-ipadic

pip install torch torchaudio
pip install -r "$MELO_SRC/requirements.txt" || true
pip install transformers huggingface-hub 'tokenizers>=0.20'
pip install -e "$MELO_SRC" --no-deps

python -c "import nltk; nltk.download('averaged_perceptron_tagger_eng')"

echo ""
echo "Done. Test:"
echo "  GOTCHIBOT_MELO_PYTHON=$VENV/bin/python ./scripts/gotchibot tts test"
echo "  ./scripts/gotchibot tts warm   # keep model loaded for fast replies"
