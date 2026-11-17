@echo off
rem Avvia l'app SQL FK Finder (Windows): doppio clic su questo file.
cd /d "%~dp0app"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js non e' installato: scaricalo da https://nodejs.org e riprova.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Prima installazione: scarico Electron ^(serve internet, solo la prima volta^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Installazione non riuscita.
    pause
    exit /b 1
  )
)

rem Assistente: la libreria del modello di linguaggio e il modello (la prima volta chiede se scaricarlo)
set "PY=python"
where python >nul 2>nul || set "PY=py -3"
call %PY% prepara_assistente.py --libreria --modello "%~dp0modelli"

call npm start
