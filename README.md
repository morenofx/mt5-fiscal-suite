# MT5 Fiscal Suite

Due strumenti web per preparare i dati fiscali del trading e delle vendite sul Market MQL5,
uniti in un'unica pagina iniziale. Tutto gira nel browser: nessun server, nessun invio di dati.

| App | A cosa serve |
|---|---|
| **MT5 Fiscal Analyzer** (`analyzer.html`) | Legge i report `.xlsx` di MetaTrader 5 e prepara Quadro RT (plusvalenze, imposta 26%) e Quadro RW (giacenze conti esteri, IVAFE) per il commercialista |
| **MQL5 Proventi Calculator** (`calculator.html`) | Interpreta la tabella Payments di MQL5 e calcola l'imponibile in euro da registrare nei corrispettivi (partita IVA), vendita per vendita |

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

## Valute

Il motore lavora su **qualsiasi valuta pubblicata dalla BCE**, non solo il dollaro: la valuta di
ogni conto viene letta dal report (qualsiasi codice a tre lettere) e la serie storica corrispondente
viene scaricata da sola. L'euro non viene convertito. Se per una valuta non esistono rilevazioni,
gli importi in euro di quei conti restano **non calcolati** e due controlli lo segnalano come
errore: meglio un buco dichiarato che un numero convertito col cambio della valuta sbagliata.

## Un solo report per conto

Il report MT5 contiene **tutta la storia del conto**, quindi ne basta uno per conto: caricarne
due dello stesso conto conterebbe due volte le stesse operazioni. L'analyzer non lo permette.

- stesso conto, stesso periodo, stesse operazioni → il secondo file viene **scartato**;
- stesso conto, report diversi → ne entra **uno solo**, quello che copre di più (più operazioni;
  a parità, quello che arriva più avanti nel tempo; a parità ancora, quello generato più di recente).
  L'altro viene scartato;
- ogni scarto è **elencato per nome di file**, con il motivo: è l'unico modo per accorgersi di
  avere in cartella due export dello stesso conto.

Ogni conto mostra la data in cui il suo report è stato generato (riga `Date:` dell'export), sia a
schermo sia nella tabella dei conti in copertina. Un controllo segnala i report generati **prima
della fine di un anno chiuso**: non possono contenerlo tutto, e vanno riesportati. È il caso vero
di export fatti ad aprile e usati per l'anno intero.

## Un anno per volta

Si dichiara un anno alla volta, ma il report caricato contiene tutti gli anni. Per questo ogni
anno ha il suo pulsante **📥 Fascicolo &lt;anno&gt;**, che produce copertina + Quadro RT + Quadro RW
del **solo** anno scelto (`Quadri_RT_RW_<anno>.pdf`): gli anni già dichiarati restano fuori dal
documento senza dover ricaricare niente. `📅 PDF Per Anno (separati)` fa la stessa cosa per tutti
gli anni in una finestra sola, `📄 PDF Unico` li mette tutti in un documento.

## Verifica dati

Entrambe le app eseguono controlli automatici sui dati caricati e mostrano l'esito, che finisce
anche sui documenti generati.

Nell'analyzer il controllo portante è la **quadratura contabile**: per ogni conto

```
saldo finale del report = movimenti di cassa + risultato dei trade
```

Se non torna, il report non è stato letto per intero o qualcosa è stato classificato male. È il
controllo che ha rivelato l'assenza di commissioni e swap dal calcolo: con il solo `Profit`
l'identità falliva su 7 conti su 9, includendo `Commission` e `Swap` chiude a zero su tutti.
Gli altri controlli: continuità dei saldi fra anni, conti con giacenza ma senza report negli anni
successivi, report che non partono da saldo zero, qualità dei cambi applicati, movimenti
classificati solo dal segno, broker non riconosciuto, quadratura RT21 − RT22 = RT23, bonus esclusi,
anni non ancora chiusi, report generati prima della fine dell'anno che dichiarano.

Nel calculator: righe duplicate (tabella incollata due volte), righe senza data o fuori anno,
cambi mancanti, lordo non coerente col netto accreditato, righe inserite a mano, propri acquisti
finiti fra le vendite, date future.

## Paesi a fiscalità privilegiata e IVAFE

L'aliquota IVAFE è il 2 per mille, elevato al **4 per mille dal 2024** (Legge di Bilancio 2024)
per i prodotti finanziari detenuti negli Stati dell'elenco del **DM 4 maggio 1999**. Lo stesso
elenco determina, sul quadro RW, il raddoppio delle sanzioni in caso di omissione e termini di
accertamento più lunghi.

L'elenco usato è quello del testo in vigore pubblicato dall'Agenzia delle Entrate: vi figurano
`Isole Cayman (The Cayman Islands)` e `Seicelle (Republic of Seychelles)`, entrambe senza la nota
di eliminazione che accompagna i paesi rimossi (Cipro e Malta col DM 27/7/2010, la Svizzera dal
2024). L'aliquota applicata a ciascun conto è scritta sotto il relativo importo nei quadri RW.

Attenzione: il paese dipende dalla **società** con cui è aperto il conto, non dal marchio del
broker, e i broker migrano i conti fra le proprie entità. Va riletto dal report di ogni anno.

## Criterio di conversione, per app

- **Analyzer:** ogni trade al cambio BCE del giorno di chiusura; saldi iniziali e finali al cambio
  della rispettiva data di riferimento. Per l'anno ancora in corso il riferimento di fine periodo
  è la data odierna (il 31 dicembre futuro non ha cambio) e i valori sono dichiarati provvisori.
- **Calculator:** ogni vendita al cambio BCE del giorno dell'operazione, criterio che coincide con
  l'art. 13, c. 4, DPR 633/72 per i corrispettivi in valuta estera (cambio del giorno di
  effettuazione o, in mancanza, del giorno antecedente più prossimo). L'importo da registrare è il
  **lordo** pagato dal cliente; la commissione MQL5 del 20% è un costo separato.

## Versione e data dell'ultimo aggiornamento

Versione e data stanno in **un solo posto**, in fondo a `fx.js` (`SUITE.version`, `SUITE.updated`):
le tre pagine e tutti i PDF leggono da lì, così la data stampata su un documento non può divergere
dal codice che l'ha prodotto. **Vanno aggiornate a ogni modifica di una qualsiasi pagina**, insieme
al parametro `?v=` descritto qui sotto.

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
