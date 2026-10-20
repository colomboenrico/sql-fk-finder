#!/usr/bin/env bash
# Crea gli eseguibili dell'app SQL FK Finder e li mette in una cartella sul Desktop.
#
#   ./crea_eseguibili.sh              tutti quelli possibili da questo computer
#   ./crea_eseguibili.sh mac          solo per Mac      (si può fare solo da un Mac)
#   ./crea_eseguibili.sh win linux    solo per Windows e Linux
#
# Da un Mac si creano tutti e tre; da Linux quelli per Linux e Windows.
# Serve Node.js (https://nodejs.org) e internet la prima volta (scarica Electron e electron-builder).
# Sul computer dove si usa l'app serve Python 3: le librerie le installa l'app al primo avvio.
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
      npx electron-builder --mac --arm64 --x64
      ;;
    win|windows)
      echo "== Windows"
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

Su ogni computer serve Python 3 (3.9 o più recente, da https://www.python.org).
Al primo avvio l'app installa da sola le librerie Python che le servono (serve internet).
TESTO

echo
echo "Fatto. Eseguibili in: $DEST"
ls -1 "$DEST"
