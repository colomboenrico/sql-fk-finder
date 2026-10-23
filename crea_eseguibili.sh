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
#
# Lo script mostra ogni passo: il passo in corso, l'uscita degli strumenti (rientrata, in grigio),
# un [ OK ] per ogni cosa pronta e alla fine il riquadro con gli eseguibili creati.
set -euo pipefail
shopt -s nullglob                 # un modello senza file (dist/*.dmg) non diventa un nome sbagliato

cd "$(dirname "$0")/app"
SISTEMA="$(uname -s)"

# ---------------------------------------------------------------- colori (solo se il terminale li supporta)
if [ -t 1 ] && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BLU=$'\033[1;34m'; AZZURRO=$'\033[36m'; VERDE=$'\033[1;32m'; ROSSO=$'\033[1;31m'; GIALLO=$'\033[1;33m'
  GRIGIO=$'\033[90m'; GRASSETTO=$'\033[1m'; NORMALE=$'\033[0m'
else
  BLU=""; AZZURRO=""; VERDE=""; ROSSO=""; GIALLO=""; GRIGIO=""; GRASSETTO=""; NORMALE=""
fi

scritta() {
  printf '%s' "$BLU"
  cat <<'SCRITTA'

  ███████╗ ██████╗ ██╗         ███████╗██╗  ██╗
  ██╔════╝██╔═══██╗██║         ██╔════╝██║ ██╔╝
  ███████╗██║   ██║██║         █████╗  █████╔╝
  ╚════██║██║▄▄ ██║██║         ██╔══╝  ██╔═██╗
  ███████║╚██████╔╝███████╗    ██║     ██║  ██╗
  ╚══════╝ ╚══▀▀═╝ ╚══════╝    ╚═╝     ╚═╝  ╚═╝

  ███████╗██╗███╗   ██╗██████╗ ███████╗██████╗
  ██╔════╝██║████╗  ██║██╔══██╗██╔════╝██╔══██╗
  █████╗  ██║██╔██╗ ██║██║  ██║█████╗  ██████╔╝
  ██╔══╝  ██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗
  ██║     ██║██║ ╚████║██████╔╝███████╗██║  ██║
  ╚═╝     ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝
SCRITTA
  printf '%s\n' "$NORMALE"
  printf '  %sCreazione degli eseguibili%s   %s\n\n' "$GRASSETTO" "$NORMALE" "$(date '+%d/%m/%Y %H:%M')"
}

PASSO=0
TOTALE=0
INIZIO_PASSO=$SECONDS
passo() {          # titolo di un passo: [2/6] Python da includere per Windows
  PASSO=$((PASSO + 1))
  INIZIO_PASSO=$SECONDS
  printf '\n%s[%d/%d] %s%s\n' "$AZZURRO$GRASSETTO" "$PASSO" "$TOTALE" "$1" "$NORMALE"
}
ok()     { printf '  %s[ OK ]%s %s\n' "$VERDE" "$NORMALE" "$1"; }
avviso() { printf '  %s[ !! ]%s %s\n' "$GIALLO" "$NORMALE" "$1"; }
errore() { printf '  %s[ERRORE]%s %s\n' "$ROSSO" "$NORMALE" "$1"; }
durata() {         # 75 -> 1 min 15 s
  local s=$1
  if [ "$s" -ge 60 ]; then printf '%d min %d s' $((s / 60)) $((s % 60)); else printf '%d s' "$s"; fi
}
fine_passo() { ok "$1 $GRIGIO($(durata $((SECONDS - INIZIO_PASSO))))$NORMALE"; }
# esegue un comando mostrandone l'uscita rientrata e in grigio; se fallisce, lo script si ferma
esegui() {
  "$@" 2>&1 | awk -v g="$GRIGIO" -v n="$NORMALE" '{ print "    " g "│ " $0 n; fflush() }'
}
dimensione() { du -sh "$1" 2>/dev/null | awk '{print $1}'; }

trap 'echo; errore "il passo $PASSO non è riuscito: guarda le righe in grigio qui sopra per il motivo."; exit 1' ERR

scritta

# ---------------------------------------------------------------- quali eseguibili
if [ $# -gt 0 ]; then
  SCELTI="$*"
elif [ "$SISTEMA" = "Darwin" ]; then
  SCELTI="mac win linux"
else
  SCELTI="linux win"
fi
DA_FARE=""
for s in $SCELTI; do
  case "$s" in
    mac) if [ "$SISTEMA" = "Darwin" ]; then DA_FARE="$DA_FARE mac"; else avviso "l'app per Mac si può creare solo su un Mac: la salto."; fi ;;
    win|windows) DA_FARE="$DA_FARE win" ;;
    linux) DA_FARE="$DA_FARE linux" ;;
    *) errore "sistema sconosciuto: $s (usa mac, win, linux)"; exit 1 ;;
  esac
done
DA_FARE="${DA_FARE# }"
if [ -z "$DA_FARE" ]; then errore "nessun eseguibile da creare."; exit 1; fi
set -- $DA_FARE
TOTALE=$(( $# + 3 ))      # controllo, strumenti, un passo per sistema, copia sul Desktop

# cartella di destinazione sul Desktop
if command -v xdg-user-dir >/dev/null 2>&1; then DESKTOP="$(xdg-user-dir DESKTOP)"; else DESKTOP="$HOME/Desktop"; fi
[ -d "$DESKTOP" ] || DESKTOP="$HOME"
DEST="$DESKTOP/SQL FK Finder - eseguibili"

# ---------------------------------------------------------------- 1. controllo di quello che serve
passo "Controllo di quello che serve su questo computer"
ok "sistema: $SISTEMA $(uname -m)"
ok "eseguibili da creare: $(echo "$DA_FARE" | sed 's/mac/Mac/; s/win/Windows/; s/linux/Linux/; s/ /, /g')"
if ! command -v npm >/dev/null 2>&1; then
  errore "Node.js non è installato: scaricalo da https://nodejs.org e riprova."
  exit 1
fi
ok "Node.js $(node --version) e npm $(npm --version)"
PY=""
for c in "${PYTHON:-}" python3 python /opt/anaconda3/bin/python; do
  if [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && "$c" -m pip --version >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  errore "serve un Python 3 con pip per preparare il Python da includere negli eseguibili."
  exit 1
fi
ok "$("$PY" --version 2>&1) con pip ($(command -v "$PY"))"
WINE=0
if [[ " $DA_FARE " == *" win "* ]]; then
  if command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then WINE=1; ok "Wine trovato: il .exe avrà l'icona dell'app"
  else avviso "Wine non c'è: il .exe funziona lo stesso, con l'icona predefinita"; fi
fi
ok "destinazione: $DEST"
fine_passo "controllo finito"

# ---------------------------------------------------------------- 2. strumenti
passo "Strumenti di costruzione (Electron ed electron-builder; la prima volta qualche minuto)"
esegui npm install --no-audit --no-fund
ok "Electron $(node -p "require('electron/package.json').version") pronto"
ok "electron-builder $(node -p "require('electron-builder/package.json').version") pronto"
rm -rf dist
ok "cartella dist svuotata"
fine_passo "strumenti pronti"

# ---------------------------------------------------------------- 3... un passo per sistema
for s in $DA_FARE; do
  case "$s" in
    mac)
      passo "App per Mac (Apple Silicon e Intel)"
      echo "  Python da includere, con tutte le librerie:"
      esegui "$PY" prepara_python.py mac-arm64 mac-x64
      for a in mac-arm64 mac-x64; do ok "Python per $a pronto ($(dimensione "python/$a"))"; done
      echo "  Costruzione dell'app e dei dmg:"
      esegui npx electron-builder --mac --arm64 --x64
      for f in dist/*.dmg; do ok "creato $(basename "$f") ($(dimensione "$f"))"; done
      fine_passo "app per Mac pronta"
      ;;
    win)
      passo "App per Windows"
      echo "  Python da includere, con tutte le librerie:"
      esegui "$PY" prepara_python.py win-x64
      ok "Python per win-x64 pronto ($(dimensione python/win-x64))"
      echo "  Costruzione dell'installazione e della versione portatile:"
      if [ "$WINE" = 1 ]; then
        esegui npx electron-builder --win --x64
      else
        # senza Wine non si può scrivere l'icona dentro il .exe: l'app funziona lo stesso
        esegui npx electron-builder --win --x64 -c.win.signAndEditExecutable=false
      fi
      for f in dist/*.exe; do ok "creato $(basename "$f") ($(dimensione "$f"))"; done
      fine_passo "app per Windows pronta"
      ;;
    linux)
      passo "App per Linux"
      echo "  Python da includere, con tutte le librerie:"
      esegui "$PY" prepara_python.py linux-x64
      ok "Python per linux-x64 pronto ($(dimensione python/linux-x64))"
      echo "  Costruzione di AppImage e tar.gz:"
      esegui npx electron-builder --linux --x64
      for f in dist/*.AppImage dist/*.tar.gz; do ok "creato $(basename "$f") ($(dimensione "$f"))"; done
      fine_passo "app per Linux pronta"
      ;;
  esac
done

# ---------------------------------------------------------------- ultimo passo: copia sul Desktop
passo "Copia sul Desktop"
rm -rf "$DEST"
mkdir -p "$DEST"
for f in dist/*.dmg dist/*.exe dist/*.AppImage dist/*.tar.gz; do
  cp "$f" "$DEST/"
  ok "copiato $(basename "$f")"
done
chmod +x "$DEST"/*.AppImage 2>/dev/null || true
# l'app per Mac pronta da aprire con doppio clic (quella per il processore di questo computer)
if [ "$SISTEMA" = "Darwin" ] && [[ " $DA_FARE " == *" mac "* ]]; then
  ARCH="$(uname -m)"
  APP="dist/mac-$ARCH/SQL FK Finder.app"
  [ -d "$APP" ] || APP="dist/mac/SQL FK Finder.app"
  if [ -d "$APP" ]; then ditto "$APP" "$DEST/SQL FK Finder.app"; ok "copiato SQL FK Finder.app (per $ARCH, si apre con doppio clic)"; fi
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
ok "scritto LEGGIMI.txt"
fine_passo "eseguibili sul Desktop"

# ---------------------------------------------------------------- fine
trap - ERR
RIGA="  ════════════════════════════════════════════════════════════════"
printf '\n%s%s\n' "$VERDE" "$RIGA"
printf "   L'APPLICAZIONE È PRONTA   (tempo totale: %s)\n" "$(durata $SECONDS)"
printf '%s%s\n\n' "$RIGA" "$NORMALE"
printf '  %sCartella:%s %s\n\n' "$GRASSETTO" "$NORMALE" "$DEST"
( cd "$DEST" && for f in *; do printf '    %-48s %s\n' "$f" "$(dimensione "$f")"; done )
printf '\n'
if [ -d "$DEST/SQL FK Finder.app" ]; then
  printf '  Per aprirla su questo Mac: doppio clic su %sSQL FK Finder.app%s (la prima volta: clic destro > Apri).\n' "$GRASSETTO" "$NORMALE"
fi
printf "  Al primo avvio l'app si controlla da sola e dice se è tutto a posto.\n\n"
