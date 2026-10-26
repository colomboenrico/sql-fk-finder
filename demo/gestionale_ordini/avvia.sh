#!/bin/bash
# Gestionale ordini di prova per provare "Ascolta il database" di SQL FK Finder.
# Avvia un MySQL privato (solo socket, nessuna porta di rete) con il general log acceso, crea il database "negozio"
# con qualche dato, scrive il dump e apre il gestionale. Il tuo MySQL, se ne hai uno, non viene toccato.
set -e
CARTELLA="$(cd "$(dirname "$0")" && pwd)"
DATI="$CARTELLA/.mysql/dati"
SOCKET="/tmp/sqlfk-demo-$USER.sock"            # percorso corto: i socket hanno un limite di lunghezza
LOG="$CARTELLA/query.log"

trova() {
  # prima le installazioni normali (Homebrew, pacchetto di mysql.com, Linux), poi quella nel PATH (per esempio di Anaconda)
  for d in /opt/homebrew/opt/mysql/bin /usr/local/opt/mysql/bin /usr/local/mysql/bin /opt/homebrew/opt/mariadb/bin \
           /usr/local/opt/mariadb/bin /usr/sbin /usr/bin "$(dirname "$(command -v mysqld 2>/dev/null || echo /x/x)")"; do
    [ -x "$d/mysqld" ] && [ -x "$d/mysql" ] && { echo "$d"; return; }
  done
}
BIN="$(trova)"
if [ -z "$BIN" ]; then
  echo "MySQL non trovato. Sul Mac: brew install mysql (oppure MariaDB). Su Linux: il pacchetto mysql-server."
  exit 1
fi
PY=""
for p in python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/3.*/bin/python3 /opt/anaconda3/bin/python3 /usr/bin/python3; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c "import tkinter" 2>/dev/null; then PY="$p"; break; fi
done
if [ -z "$PY" ]; then
  echo "Serve un Python 3 con tkinter (per esempio quello di python.org)."
  exit 1
fi

if ! "$BIN/mysqladmin" --socket="$SOCKET" -uroot ping >/dev/null 2>&1; then
  if [ ! -d "$DATI/mysql" ]; then
    echo "Preparo il MySQL della demo in $DATI ..."
    mkdir -p "$DATI"
    if "$BIN/mysqld" --version | grep -qi mariadb; then
      "$BIN/mariadb-install-db" --datadir="$DATI" --auth-root-authentication-method=normal >/dev/null
    else
      "$BIN/mysqld" --initialize-insecure --datadir="$DATI" --log-error="$CARTELLA/.mysql/errori.log"
    fi
  fi
  echo "Avvio il MySQL della demo (socket $SOCKET, nessuna porta di rete) ..."
  EXTRA=""
  "$BIN/mysqld" --verbose --help 2>/dev/null | grep -q "^mysqlx " && EXTRA="--mysqlx=OFF"   # MySQL 8+: niente porta X
  "$BIN/mysqld" --datadir="$DATI" --socket="$SOCKET" --skip-networking $EXTRA \
    --pid-file="$CARTELLA/.mysql/mysqld.pid" --log-error="$CARTELLA/.mysql/errori.log" \
    --general-log=1 --general-log-file="$LOG" >/dev/null 2>&1 &
  for i in $(seq 1 60); do
    "$BIN/mysqladmin" --socket="$SOCKET" -uroot ping >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

export DEMO_MYSQL="$BIN/mysql" DEMO_SOCKET="$SOCKET"
"$PY" "$CARTELLA/gestionale.py" --prepara "$CARTELLA/database" "$BIN/mysqldump"
echo
echo "Pronto. Nella pagina 'Ascolta il database' di SQL FK Finder usa questo file del log:"
echo "  $LOG"
echo "e carica la cartella del database (un file .sql per tabella) per il confronto con lo schema:"
echo "  $CARTELLA/database"
echo
"$PY" "$CARTELLA/gestionale.py"
