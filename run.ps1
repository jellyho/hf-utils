# HF Util launcher (Windows PowerShell)
# Usage:  .\run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    python -m venv .venv
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r requirements.txt
}

Write-Host "Starting HF Util at http://127.0.0.1:8000 ..." -ForegroundColor Green
Start-Process "http://127.0.0.1:8000"
& $venvPy -m backend.main
