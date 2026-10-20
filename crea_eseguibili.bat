@echo off
rem Crea l'eseguibile per Windows di SQL FK Finder e lo mette in una cartella sul Desktop.
rem Da avviare con doppio clic o dal Prompt dei comandi:  crea_eseguibili.bat
rem Serve Node.js (https://nodejs.org), Python 3 con pip e internet, solo qui e solo per creare l'eseguibile:
rem l'eseguibile contiene gia' Python con le librerie e non usa mai la rete.
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

set "PY=python"
where python >nul 2>nul || set "PY=py -3"
echo == Python da includere
call %PY% prepara_python.py win-x64
if errorlevel 1 goto errore

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
  echo L'app contiene gia' Python e le librerie: sul computer dove la usi non serve installare niente.
  echo Non usa mai la rete: niente internet e nessuna porta aperta.
  echo Per controllarla avviala con SQLFK_AUTOVERIFICA=1: scrive sqlfk_autoverifica.txt nella cartella temporanea.
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
