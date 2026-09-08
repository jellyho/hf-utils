# HF Util launcher (Windows PowerShell)
# Usage:  .\run.ps1                 (default port, opens a browser)
#         .\run.ps1 --port 9000
#         .\run.ps1 --no-browser
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "uv is not installed, and it is what builds the environment now." -ForegroundColor Yellow
    Write-Host "Install it with:" -ForegroundColor Yellow
    Write-Host '    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    Write-Host "then run this script again." -ForegroundColor Yellow
    exit 1
}

# One command replaces the venv + pip dance: uv fetches the interpreter named in
# .python-version, creates .venv, and installs the exact versions in uv.lock -- a no-op once
# the environment matches. --all-extras is the app's install list (server, viewer, Transfer).
# The server picks the port and opens the browser itself, so there is no URL to guess here.
uv run --all-extras python -m backend.main @args
