#!/bin/bash
# Generation-only pod bootstrap: ACE-Step 1.5 + checkpoints, then pod_generate.py with the Kannaka LoRA at /home/jovyan/ace/lora.
set -u
cd /home/jovyan/ace || exit 1
exec > >(tee -a gen.log) 2>&1
echo "=== $(date -u +%FT%TZ) bootstrap"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
# static ffmpeg (the image has none; ACE-Step's mp3 export needs it and has no fallback) -- belt and braces, we render WAV anyway
if ! command -v ffmpeg >/dev/null; then
  mkdir -p "$HOME/.local/bin" && curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ --strip-components=1 -C "$HOME/.local/bin" --wildcards '*/ffmpeg' '*/ffprobe' || echo "ffmpeg static install failed (WAV path still works)"
fi
command -v ffmpeg && ffmpeg -version | head -1
[ -d ACE-Step-1.5 ] || git clone -q --depth 1 https://github.com/ace-step/ACE-Step-1.5.git
( cd ACE-Step-1.5 && uv sync -q ) || { echo "uv sync failed"; exit 2; }
( cd ACE-Step-1.5 && uv run acestep-download ) || { echo "download failed"; exit 3; }
echo "=== $(date -u +%FT%TZ) ready; generating"
cd ACE-Step-1.5 && timeout 1800 uv run python /home/jovyan/ace/pod_generate.py /home/jovyan/ace/lora /home/jovyan/ace/gen
echo "=== $(date -u +%FT%TZ) rc=$? POD_GEN_DONE"
