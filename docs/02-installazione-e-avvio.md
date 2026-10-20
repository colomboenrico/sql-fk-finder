# 2. Installazione e avvio

[Indice](README.md) · Precedente: [Introduzione](01-introduzione.md) · Successivo: [Guida all'uso](03-guida-all-uso.md)

Ci sono quattro modi di usare SQL FK Finder. Per lavorare basta il primo.

| Modo | Per chi | Cosa serve sul computer |
|---|---|---|
| **A. Eseguibile** (consigliato) | chi usa il programma | niente: Python e librerie sono dentro |
| B. App dai sorgenti | chi modifica il codice | Node.js e Python 3 con le librerie |
| C. Nel browser | chi lavora dal terminale | Python 3 con le librerie |
| D. Notebook Jupyter | chi vuole vedere ogni passo | Python 3 con Jupyter |

## A. Eseguibile

Gli eseguibili si trovano nella cartella **SQL FK Finder - eseguibili** sul Desktop di chi li ha creati (vedi più sotto come crearli).

| Sistema | File | Come si avvia |
|---|---|---|
| Windows | `SQL-FK-Finder-<versione>-win-x64.exe` | installazione guidata; crea il collegamento sul Desktop |
| Windows | `SQL-FK-Finder-<versione>-portatile.exe` | doppio clic, senza installare (anche da chiavetta) |
| Mac Apple Silicon (M1, M2...) | `SQL-FK-Finder-<versione>-mac-arm64.dmg` | apri il dmg e trascina l'app in Applicazioni |
| Mac Intel | `SQL-FK-Finder-<versione>-mac-x64.dmg` | come sopra |
| Mac | `SQL FK Finder.app` | doppio clic |
| Linux | `SQL-FK-Finder-<versione>-linux-x86_64.AppImage` | doppio clic, oppure da terminale `./SQL-FK-Finder-...AppImage` |
| Linux | `SQL-FK-Finder-<versione>-linux-x64.tar.gz` | estrai e avvia `sql-fk-finder` |

**La prima volta**:

- **Windows**: se SmartScreen dice "Windows ha protetto il PC", clicca *Ulteriori informazioni* → *Esegui comunque* (l'app non è firmata digitalmente).
- **Mac**: clic destro sull'app → *Apri* → *Apri* (sempre perché non è firmata).
- **Linux**: se l'AppImage non parte, rendila eseguibile con `chmod +x SQL-FK-Finder-*.AppImage`.

Al primo avvio l'app **si controlla da sola** e mostra un messaggio: "tutto a posto, e nessuna connessione di rete" oppure il numero di problemi trovati (dettagli in *Impostazioni → Controllo dell'app*, vedi sotto).

### Creare gli eseguibili

Gli eseguibili si creano dal terminale, nella cartella del progetto:

```bash
./crea_eseguibili.sh
```

- Da un **Mac** crea quelli per Mac (Apple Silicon e Intel), Windows e Linux; da **Linux** quelli per Linux e Windows. Si possono scegliere: `./crea_eseguibili.sh mac`, `./crea_eseguibili.sh win linux`.
- Su **Windows** c'è `crea_eseguibili.bat` (doppio clic): crea quelli per Windows.
- Servono **Node.js** (da nodejs.org), un **Python 3 con pip** e **internet**, ma solo su questo computer e solo per crearli: si scaricano Electron, electron-builder e un Python completo con tutte le librerie per ogni sistema (`app/prepara_python.py`, con versioni fisse). Gli eseguibili creati **non usano mai la rete**.
- Il risultato va nella cartella **SQL FK Finder - eseguibili** sul Desktop, con un file `LEGGIMI.txt`. Le dimensioni sono di circa 170 MB per Windows, 200 MB per Mac e 220 MB per Linux (Python, pandas, scipy e clingo inclusi).

## B. App dai sorgenti (per sviluppare)

```bash
pip install -r requirements.txt
cd app
npm install
npm start
```

Con `npm start` l'app usa un Python del computer che abbia le librerie (Anaconda, Homebrew, python.org...). Per indicarne uno preciso: `SQLFK_PYTHON=/percorso/del/python npm start`. Su Windows e Mac ci sono anche i lanciatori `avvia_app.bat` e `avvia_app.command` (doppio clic).

## C. Nel browser

```bash
pip install -r requirements.txt
python -m sqlfk.server --apri
```

Si apre `http://127.0.0.1:8765` con la stessa interfaccia dell'app. Con `--cartella percorso` carica subito i file. In questo modo c'è un piccolo server su `127.0.0.1` (accetta solo connessioni dal computer stesso): è comodo per lavorare dal terminale, ma l'app vera non lo usa. Nel browser i file sopra 64 MB vanno aperti scrivendo il loro percorso nel campo in alto, e la lettura delle finestre di un programma non è disponibile.

## D. Notebook Jupyter

Apri `collegamenti_tabelle_sql.ipynb` (Jupyter, JupyterLab o VS Code con il kernel Python 3). La prima cella installa le librerie (una volta sola, poi riavvia il kernel). Nella cella *Configurazione* imposta la cartella dei file `.sql`, il dialetto e le altre opzioni, poi esegui le celle in ordine: ogni sezione fa un passo dell'analisi e spiega cosa sta facendo. L'ultima cella apre un'interfaccia grafica semplice dentro il notebook.

## Controllo dell'app

*Impostazioni → Controlla l'app* (e automaticamente al primo avvio) verifica:

| Voce | Cosa controlla |
|---|---|
| Python, Librerie | la versione di Python usata e che ci siano pandas, scipy, sqlglot, pyvis, openpyxl, networkx, clingo (e comtypes su Windows) |
| Analisi delle chiavi | l'analisi degli esempi dà 2 errori, 18 avvisi, 15 info |
| Query sui dati | il database delle query funziona (5 comuni negli esempi) |
| Lettura dei file | la lettura a blocchi dei file `.sql` |
| Lettura delle finestre | su Windows: UI Automation risponde e trova le finestre aperte; altrove: non serve |
| Analisi delle schermate | una schermata simulata dà la relazione `province → regioni` |
| Scelta con clingo | clingo sceglie le chiavi degli esempi e scarta la ridondante `comuni → regioni` |
| Internet | una richiesta a internet viene bloccata |
| Connessioni di rete | l'app (Electron e Python) non ha porte né connessioni aperte |

Il controllo usa una **copia degli esempi**: il lavoro aperto non cambia. Il risultato si vede voce per voce ed è salvato in `autoverifica.txt` nella cartella dei dati dell'app (pulsante *Apri la cartella*). Avviando l'app con la variabile `SQLFK_AUTOVERIFICA=1` fa il controllo, lo scrive anche in `sqlfk_autoverifica.txt` nella cartella temporanea del sistema e si chiude: utile per controllare un computer senza aprire la finestra.

## Requisiti

- **Sistema**: Windows 10 o 11 (64 bit), macOS 11 o più recente (Apple Silicon o Intel), Linux a 64 bit con glibc 2.17 o più recente.
- **Memoria**: 4 GB bastano anche per dump molto grandi (si leggono a blocchi). Per le query su dump grandi serve spazio su disco pari a circa 1,2 volte i file.
- **Lettura delle finestre**: solo Windows. Funziona con quasi tutti i programmi (Win32, WinForms, WPF, Qt, Electron; Java se è attivo Java Access Bridge).
