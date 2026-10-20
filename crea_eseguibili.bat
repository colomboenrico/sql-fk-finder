@echo off
rem Crea l'eseguibile per Windows di SQL FK Finder e lo mette in una cartella sul Desktop.
rem Da avviare con doppio clic o dal Prompt dei comandi:  crea_eseguibili.bat
rem Serve Node.js (https://nodejs.org) e internet la prima volta.
rem Per Mac e Linux usa crea_eseguibili.sh (l'app per Mac si crea solo da un Mac).
setlocal
cd /d "%~dp0app"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js non e' installato: scaricalo da https://nodejs.org e riprova.
  pause
  exit /b 1
)

echo == Preparazione ^(la prima volta scarica gli strumenti, qualche minuto^)
call npm install --no-audit --no-fund
if errorlevel 1 goto errore
if exist dist rmdir /s /q dist

echo == Windows
call npx electron-builder --win --x64
if errorlevel 1 goto errore

for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%d"
set "DEST=%DESKTOP%\SQL FK Finder - eseguibili"
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%"
copy /y "dist\*.exe" "%DEST%\" >nul

(
  echo SQL FK Finder - eseguibili per Windows
  echo.
  echo   ...-win-x64.exe      installazione ^(crea anche il collegamento sul Desktop^)
  echo   ...-portatile.exe    si avvia con doppio clic, senza installare
  echo   Se Windows SmartScreen lo blocca: "Ulteriori informazioni" ^> "Esegui comunque".
  echo.
  echo Serve Python 3 ^(3.9 o piu' recente, da https://www.python.org, spuntando "Add python.exe to PATH"^).
  echo Al primo avvio l'app installa da sola le librerie Python che le servono ^(serve internet^).
) > "%DEST%\LEGGIMI.txt"

echo.
echo Fatto. Eseguibili in: %DEST%
dir /b "%DEST%"
pause
exit /b 0

:errore
echo Creazione non riuscita: guarda i messaggi qui sopra.
pause
exit /b 1
