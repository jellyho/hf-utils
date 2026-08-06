# HF Util launcher (Windows PowerShell)
# Usage:  .\run.ps1                 (default port, opens a browser)
#         .\run.ps1 --port 9000
#         .\run.ps1 --no-browser
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    python -m venv .venv
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r requirements.txt
}

# The server picks the port (moving past one that's taken) and opens the browser itself,
# so there is no URL to guess here.
& $venvPy -m backend.main @args
