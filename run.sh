#!/usr/bin/env bash
# HF Util launcher (Linux / macOS)
# Usage:  ./run.sh                 (default port, opens a browser)
#         ./run.sh --port 9000
#         ./run.sh --no-browser    (e.g. when tunnelling in over ssh)
set -euo pipefail
cd "$(dirname "$0")"

PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    "$PY" -m pip install --upgrade pip
    "$PY" -m pip install -r requirements.txt
fi

# The server picks the port (moving past one that's taken) and prints the URL.
exec "$PY" -m backend.main "$@"
