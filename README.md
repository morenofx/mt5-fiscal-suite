# MT5 Fiscal Suite

Due strumenti web per preparare i dati fiscali del trading e delle vendite sul Market MQL5,
uniti in un'unica pagina iniziale. Tutto gira nel browser: nessun server, nessun invio di dati.

| App | A cosa serve |
|---|---|
| **MT5 Fiscal Analyzer** (`analyzer.html`) | Legge i report `.xlsx` di MetaTrader 5 e prepara Quadro RT (plusvalenze, imposta 26%) e Quadro RW (giacenze conti esteri, IVAFE) |
| **MQL5 Proventi Calculator** (`calculator.html`) | Interpreta la tabella Payments di MQL5 e prepara il riepilogo dei compensi da lavoro autonomo occasionale |

## Il motore cambi (`fx.js`)

Entrambe le app usano lo stesso modulo, con **una sola convenzione**:

```
rate = EURO per 1 DOLLARO        (es. 0.9243)
EUR  = USD * rate
```

Le versioni precedenti usavano due convenzioni opposte (`rate` e `1/rate`) anche nello stesso
file: era la causa principale degli errori di conversione.

**Fonte dati:** il Data Portal ufficiale della BCE (serie `EXR.D.USD.EUR.SP00.A`, tasso di
riferimento giornaliero), con le API Frankfurter come sola riserva se il portale non risponde.
La serie BCE è espressa in dollari per euro e viene invertita per la convenzione della suite.
I cambi pubblicati da Banca d'Italia (`tassidicambio.bancaditalia.it`) *sono* i tassi di
riferimento BCE, quindi la fonte coincide con quella citata dall'Agenzia delle Entrate. Il "cambio medio mensile" viene
calcolato come media aritmetica delle rilevazioni giornaliere del mese, che è esattamente il
modo in cui viene costruito quello ufficiale.

**Regole non aggirabili del motore:**

- un cambio storico non viene **mai** sostituito dal cambio odierno;
- per i giorni non quotati (weekend, festivi TARGET) si usa l'ultima rilevazione precedente,
  e la data effettivamente usata è sempre esposta a schermo e nei PDF;
- se un cambio non è recuperabile il valore **manca** ed è dichiarato come mancante:
  gli importi in euro restano incompleti e visibilmente segnalati, invece di essere stimati;
- i valori inseriti a mano restano marcati come "manuale" in ogni documento generato.

Una richiesta per anno scarica l'intera serie storica; i cambi restano in cache locale
(non cambiano mai), quindi dopo la prima apertura le app funzionano anche offline.

## Aggiornare il motore cambi

Le tre pagine caricano `fx.js?v=DATA`. Se modifichi `fx.js`, cambia quel parametro in
`index.html`, `analyzer.html` e `calculator.html`: senza, il browser può continuare a usare
la versione vecchia rimasta in cache.

## Uso

Apri `index.html` e scegli l'app. In locale serve un server statico (le app caricano `fx.js`):

```bash
python3 -m http.server 8765 --directory MT5_FISCAL_SUITE
```

## Privacy

Report MT5, vendite, nome e importi restano nel `localStorage` del dispositivo. Il repository
contiene solo codice: nessun dato personale, nessun importo, nessun nome. Intestatario, anno
d'imposta e note del report si inseriscono nell'app.

## Dipendenze esterne

Solo l'analyzer, da CDN: SheetJS (lettura `.xlsx`), html2pdf/jsPDF (PDF), Chart.js (grafici).
Il calculator e il motore cambi non hanno dipendenze.
