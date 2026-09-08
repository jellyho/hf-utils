#!/usr/bin/env bash
# HF Util launcher (Linux / macOS)
# Usage:  ./run.sh                 (default port, opens a browser)
#         ./run.sh --port 9000
#         ./run.sh --no-browser    (e.g. when tunnelling in over ssh)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
    cat >&2 <<'MSG'
uv is not installed, and it is what builds the environment now. Install it with:

    curl -LsSf https://astral.sh/uv/install.sh | sh

then run this script again.
MSG
    exit 1
fi

# One command does what the venv + pip dance used to: fetch the interpreter named in
# .python-version (3.12 -- lerobot 0.4.4 does not support 3.13+, and a bare `python3` was
# picking up whatever the system had), create .venv, and install the exact versions in
# uv.lock. All of it is a no-op once the environment matches, so this is also the fast path.
# --all-extras is the app's install list: the GUI needs the server, the viewer needs av, and
# the Transfer tab needs lerobot.
exec uv run --all-extras python -m backend.main "$@"
