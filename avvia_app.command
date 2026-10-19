#!/bin/bash
# Avvia l'app SQL FK Finder (macOS): doppio clic su questo file.
cd "$(dirname "$0")/app" || exit 1

# Con il doppio clic il PATH è ridotto: aggiungo i posti dove di solito stanno Node e Python
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/anaconda3/bin:$HOME/anaconda3/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js non è installato: scaricalo da https://nodejs.org e riprova."
  read -r -p "Premi Invio per chiudere..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Prima installazione: scarico Electron (serve internet, solo la prima volta)..."
  npm install --no-audit --no-fund || { read -r -p "Installazione non riuscita. Premi Invio per chiudere..."; exit 1; }
fi

npm start
