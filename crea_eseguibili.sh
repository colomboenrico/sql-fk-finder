#!/usr/bin/env bash
# Crea gli eseguibili dell'app SQL FK Finder e li mette in una cartella sul Desktop.
#
#   ./crea_eseguibili.sh              tutti quelli possibili da questo computer
#   ./crea_eseguibili.sh mac          solo per Mac      (si può fare solo da un Mac)
#   ./crea_eseguibili.sh win linux    solo per Windows e Linux
#
# Da un Mac si creano tutti e tre; da Linux quelli per Linux e Windows.
# Serve Node.js (https://nodejs.org), un Python 3 con pip e internet, solo qui e solo per creare gli eseguibili:
# si scaricano Electron, electron-builder e il Python da includere con le sue librerie.
# Gli eseguibili creati contengono già tutto e non usano mai la rete.
set -euo pipefail

cd "$(dirname "$0")/app"
SISTEMA="$(uname -s)"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js non è installato: scaricalo da https://nodejs.org e riprova."
  exit 1
fi

if [ $# -gt 0 ]; then
  SCELTI="$*"
elif [ "$SISTEMA" = "Darwin" ]; then
  SCELTI="mac win linux"
else
  SCELTI="linux win"
fi

# cartella di destinazione sul Desktop
if command -v xdg-user-dir >/dev/null 2>&1; then DESKTOP="$(xdg-user-dir DESKTOP)"; else DESKTOP="$HOME/Desktop"; fi
[ -d "$DESKTOP" ] || DESKTOP="$HOME"
DEST="$DESKTOP/SQL FK Finder - eseguibili"

# un Python con pip per preparare quello da includere
PY=""
for c in "${PYTHON:-}" python3 python /opt/anaconda3/bin/python; do
  if [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && "$c" -m pip --version >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Serve un Python 3 con pip per preparare il Python da includere negli eseguibili."
  exit 1
fi

echo "== Preparazione (la prima volta scarica gli strumenti, qualche minuto)"
npm install --no-audit --no-fund
rm -rf dist

for s in $SCELTI; do
  case "$s" in
    mac)
      if [ "$SISTEMA" != "Darwin" ]; then
        echo "== Mac: l'app per Mac si può creare solo su un Mac, la salto."
        continue
      fi
      echo "== Mac (Apple Silicon e Intel)"
      "$PY" prepara_python.py mac-arm64 mac-x64
      npx electron-builder --mac --arm64 --x64
      ;;
    win|windows)
      echo "== Windows"
      "$PY" prepara_python.py win-x64
      if command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
        npx electron-builder --win --x64
      else
        # senza Wine non si può scrivere l'icona dentro il .exe: l'app funziona lo stesso
        echo "   (Wine non c'è: il .exe avrà l'icona predefinita)"
        npx electron-builder --win --x64 -c.win.signAndEditExecutable=false
      fi
      ;;
    linux)
      echo "== Linux"
      "$PY" prepara_python.py linux-x64
      npx electron-builder --linux --x64
      ;;
    *)
      echo "Sistema sconosciuto: $s (usa mac, win, linux)"
      exit 1
      ;;
  esac
done

echo "== Copia sul Desktop: $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
shopt -s nullglob
for f in dist/*.dmg dist/*.exe dist/*.AppImage dist/*.tar.gz; do
  cp "$f" "$DEST/"
done
chmod +x "$DEST"/*.AppImage 2>/dev/null || true
# l'app per Mac pronta da aprire con doppio clic (quella per il processore di questo computer)
if [ "$SISTEMA" = "Darwin" ]; then
  ARCH="$(uname -m)"
  APP="dist/mac-$ARCH/SQL FK Finder.app"
  [ -d "$APP" ] || APP="dist/mac/SQL FK Finder.app"
  [ -d "$APP" ] && ditto "$APP" "$DEST/SQL FK Finder.app"
fi

cat > "$DEST/LEGGIMI.txt" <<'TESTO'
SQL FK Finder - eseguibili

Mac
  SQL FK Finder.app            doppio clic (la prima volta: clic destro > Apri, perché l'app non è firmata)
  ...-mac-arm64.dmg            installazione per Mac con Apple Silicon (M1, M2, ...)
  ...-mac-x64.dmg              installazione per Mac con processore Intel
Windows
  ...-win-x64.exe              installazione (crea anche il collegamento sul Desktop)
  ...-portatile.exe            si avvia con doppio clic, senza installare
  (se Windows SmartScreen lo blocca: "Ulteriori informazioni" > "Esegui comunque")
Linux
  ...-linux-x86_64.AppImage    si avvia con doppio clic (o da terminale: ./SQL-FK-Finder-...AppImage)
  ...-linux-x64.tar.gz         versione da estrarre

L'app contiene già Python e tutte le librerie: sul computer dove la usi non serve installare niente.
Non usa mai la rete: niente internet e nessuna porta aperta (Electron e Python si parlano con le pipe del processo).
Per controllarla: avviala con la variabile SQLFK_AUTOVERIFICA=1, scrive il risultato in sqlfk_autoverifica.txt
nella cartella temporanea del sistema.
TESTO

echo
echo "Fatto. Eseguibili in: $DEST"
ls -1 "$DEST"
