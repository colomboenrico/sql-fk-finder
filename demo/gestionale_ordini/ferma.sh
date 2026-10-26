#!/bin/bash
# Ferma il MySQL della demo. I dati restano in .mysql: "avvia.sh" lo riavvia; per ricominciare da zero cancella .mysql.
CARTELLA="$(cd "$(dirname "$0")" && pwd)"
SOCKET="/tmp/sqlfk-demo-$USER.sock"
for d in /opt/homebrew/opt/mysql/bin /usr/local/opt/mysql/bin /usr/local/mysql/bin /opt/homebrew/opt/mariadb/bin /usr/bin "$(dirname "$(command -v mysqladmin 2>/dev/null || echo /x/x)")"; do
  if [ -x "$d/mysqladmin" ]; then
    "$d/mysqladmin" --socket="$SOCKET" -uroot shutdown 2>/dev/null && echo "MySQL della demo fermato." || echo "Il MySQL della demo non era acceso."
    exit 0
  fi
done
[ -f "$CARTELLA/.mysql/mysqld.pid" ] && kill "$(cat "$CARTELLA/.mysql/mysqld.pid")" && echo "MySQL della demo fermato."
