#!/usr/bin/env bash
# HF Util launcher (Linux / macOS)
# Usage:  ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    "$PY" -m pip install --upgrade pip
    "$PY" -m pip install -r requirements.txt
fi

echo "Starting HF Util at http://127.0.0.1:8000 ..."
exec "$PY" -m backend.main
