/* =============================================================================
   FX.js — Motore cambi EUR/USD condiviso (MT5 Fiscal Suite)
   -----------------------------------------------------------------------------
   CONVENZIONE UNICA IN TUTTA LA SUITE:

       rate = EURO per 1 DOLLARO      (es. 0.9243)
       EUR  = USD * rate
       USD  = EUR / rate

   Non esistono altre convenzioni. Ogni valore che entra o esce da questo modulo
   e' EUR-per-USD. Le vecchie versioni usavano due convenzioni opposte nello
   stesso file (rate e 1/rate): era la causa principale degli errori di cambio.

   FONTE DATI: tassi di riferimento BCE, presi in primo luogo dal Data Portal
   ufficiale della BCE (serie EXR.D.USD.EUR.SP00.A) e, solo se non risponde,
   dalle API Frankfurter che ridistribuiscono gli stessi dati.
   I cambi pubblicati dalla Banca d'Italia (tassidicambio.bancaditalia.it) SONO
   i tassi di riferimento BCE: la fonte quindi coincide con quella ufficiale
   citata dall'Agenzia delle Entrate. Il "cambio medio mensile" ufficiale e' la
   media aritmetica delle rilevazioni giornaliere BCE del mese: qui viene
   calcolato esattamente cosi', non da tabelle precompilate.

   REGOLE DI ONESTA' DEL DATO (non aggirabili):
   - un cambio storico non viene MAI sostituito dal cambio odierno;
   - se la BCE non ha una rilevazione per quella data (weekend/festivo) si usa
     l'ultima rilevazione precedente, e la data effettiva viene sempre esposta;
   - se il cambio non e' recuperabile il risultato e' null: chi chiama deve
     mostrare l'errore, non inventare un numero;
   - i valori inseriti a mano restano marcati come "manuale".
   ============================================================================= */
(function (global) {
  'use strict';

  var CACHE_KEY = 'mt5fs_fx_ecb_v2';

  // Tutto e' indicizzato per VALUTA, perche' un conto di trading puo' essere
  // aperto in qualsiasi divisa: trattarne una per un'altra darebbe importi
  // sbagliati senza che nulla lo segnali.
  // rates:  'USD' -> { 'YYYY-MM-DD': number }   (EURO per 1 unita' di valuta)
  // manual: 'USD' -> { 'YYYY-MM-DD': number }   forzature dell'utente
  // years:  'USD' -> { '2025': {at, src} }      cosa e' gia' stato scaricato
  var store = { rates: {}, manual: {}, years: {} };

  // Valuta di riferimento: l'euro non si converte.
  var BASE = 'EUR';

  function norm(cur) { return String(cur || 'USD').toUpperCase().trim(); }
  function ratesOf(cur) { return (store.rates[cur] = store.rates[cur] || {}); }
  function manualOf(cur) { return (store.manual[cur] = store.manual[cur] || {}); }
  function yearsOf(cur) { return (store.years[cur] = store.years[cur] || {}); }

  function loadCache() {
    try {
      var s = localStorage.getItem(CACHE_KEY);
      if (!s) return;
      var o = JSON.parse(s);
      if (o && o.rates) store.rates = o.rates;
      if (o && o.manual) store.manual = o.manual;
      if (o && o.years) store.years = o.years;
    } catch (e) { /* cache corrotta: si riparte a vuoto */ }
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        rates: store.rates, manual: store.manual, years: store.years,
        savedAt: new Date().toISOString()
      }));
    } catch (e) { /* quota piena: la sessione funziona comunque */ }
  }

  /* ---------------------------------------------------------------------------
     DATE — sempre in ora LOCALE.
     toISOString() convertirebbe in UTC: in Italia (CET/CEST) una data a
     mezzanotte diventa il giorno PRIMA. Era il bug che faceva sballare il
     cambio del 1 gennaio in tutti i calcoli sui saldi.
     ------------------------------------------------------------------------- */
  function toISO(d) {
    if (typeof d === 'string') return d.slice(0, 10);
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function addDays(iso, n) {
    var p = iso.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  function todayISO() { return toISO(new Date()); }

  /* ---------------------------------------------------------------------------
     DOWNLOAD
     ------------------------------------------------------------------------- */
  function fetchText(url, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 20000);
    return fetch(url, { signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.text() : null; })
      .catch(function () { clearTimeout(timer); return null; });
  }

  function store_(cur, day, value) {
    if (typeof value === 'number' && isFinite(value) && value > 0) { ratesOf(cur)[day] = value; return 1; }
    return 0;
  }

  // FONTE 1 — Data Portal della BCE: la fonte primaria e ufficiale.
  // Serie EXR.D.USD.EUR.SP00.A = tasso di riferimento giornaliero, espresso in
  // DOLLARI per 1 EURO: va invertito per ottenere la convenzione della suite.
  function fetchEcb(cur, fromISO, toISOStr) {
    var url = 'https://data-api.ecb.europa.eu/service/data/EXR/D.' + cur + '.EUR.SP00.A' +
              '?startPeriod=' + fromISO + '&endPeriod=' + toISOStr + '&format=csvdata&detail=dataonly';
    return fetchText(url).then(function (txt) {
      if (!txt) return 0;
      var lines = txt.trim().split(/\r?\n/);
      if (lines.length < 2) return 0;
      var head = lines[0].split(',');
      var iDay = head.indexOf('TIME_PERIOD');
      var iVal = head.indexOf('OBS_VALUE');
      if (iDay < 0 || iVal < 0) return 0;
      var n = 0;
      for (var k = 1; k < lines.length; k++) {
        var c = lines[k].split(',');
        var day = c[iDay];
        var perEuro = parseFloat(c[iVal]);   // unita' di valuta per 1 EUR
        if (day && isFinite(perEuro) && perEuro > 0) n += store_(cur, day, 1 / perEuro);
      }
      return n;
    });
  }

  // FONTE 2 — Frankfurter, che ridistribuisce gli stessi dati BCE.
  // Serve solo se il Data Portal non risponde. Restituisce gia' EUR per 1 USD.
  function fetchFrankfurter(cur, fromISO, toISOStr) {
    var range = fromISO + '..' + toISOStr;
    var urls = [
      'https://api.frankfurter.dev/v1/' + range + '?base=' + cur + '&symbols=EUR',
      'https://api.frankfurter.app/' + range + '?from=' + cur + '&to=EUR'
    ];
    var i = 0;
    function attempt() {
      if (i >= urls.length) return Promise.resolve(0);
      return fetchText(urls[i++]).then(function (txt) {
        if (!txt) return attempt();
        var d;
        try { d = JSON.parse(txt); } catch (e) { return attempt(); }
        if (!d || !d.rates) return attempt();
        var n = 0;
        Object.keys(d.rates).forEach(function (day) {
          n += store_(cur, day, d.rates[day] && d.rates[day].EUR);
        });
        return n > 0 ? n : attempt();
      });
    }
    return attempt();
  }

  var SOURCES = [
    { name: 'ECB', run: fetchEcb },
    { name: 'FRANKFURTER', run: fetchFrankfurter }
  ];

  // Scarica un intervallo intero in UNA sola chiamata. Prova le fonti in ordine:
  // basta che una risponda. Ritorna { n, src }.
  function fetchRange(cur, fromISO, toISOStr) {
    var i = 0;
    function attempt() {
      if (i >= SOURCES.length) return Promise.resolve({ n: 0, src: null });
      var s = SOURCES[i++];
      return s.run(cur, fromISO, toISOStr).then(function (n) {
        return n > 0 ? { n: n, src: s.name } : attempt();
      });
    }
    return attempt();
  }

  // Garantisce che gli anni indicati siano in cache. I cambi storici BCE non
  // cambiano mai: una volta scaricati restano validi per sempre.
  // L'anno corrente viene invece rinfrescato se la cache e' vecchia di un giorno.
  function ensureYears(years, cur, onProgress) {
    if (typeof cur === 'function') { onProgress = cur; cur = null; }
    cur = norm(cur);
    if (cur === BASE) return Promise.resolve({ downloaded: 0, years: [], falliti: [], valuta: cur });

    var wanted = [];
    var nowYear = new Date().getFullYear();
    var today = todayISO();
    var yrs = yearsOf(cur);
    years.forEach(function (y) {
      y = parseInt(y, 10);
      if (!y || y < 1999 || y > nowYear) return;
      var stamp = yrs[y];
      var at = stamp ? (typeof stamp === 'string' ? stamp : stamp.at) : null;
      var stale = !at || (y === nowYear && at.slice(0, 10) !== today);
      if (stale && wanted.indexOf(y) === -1) wanted.push(y);
    });
    if (wanted.length === 0) return Promise.resolve({ downloaded: 0, years: [], falliti: [], valuta: cur });

    wanted.sort(function (a, b) { return a - b; });
    var done = 0, total = 0, falliti = [], sorgenti = {};
    var chain = Promise.resolve();
    wanted.forEach(function (y) {
      chain = chain.then(function () {
        if (onProgress) onProgress(done, wanted.length, y, cur);
        var from = y + '-01-01';
        var to = (y === nowYear) ? today : (y + '-12-31');
        return fetchRange(cur, from, to).then(function (res) {
          done++;
          if (res.n > 0) {
            yrs[y] = { at: new Date().toISOString(), src: res.src };
            sorgenti[res.src] = (sorgenti[res.src] || 0) + 1;
            total += res.n;
          } else {
            falliti.push(y);
          }
        });
      });
    });
    return chain.then(function () {
      saveCache();
      return { downloaded: total, years: wanted, falliti: falliti, sorgenti: sorgenti, valuta: cur };
    });
  }

  // Scarica in un colpo solo tutte le valute richieste.
  function ensureCurrencies(years, valute, onProgress) {
    var lista = (valute || []).map(norm).filter(function (c, i, a) {
      return c && c !== BASE && a.indexOf(c) === i;
    });
    var esiti = {};
    var chain = Promise.resolve();
    lista.forEach(function (c) {
      chain = chain.then(function () {
        return ensureYears(years, c, onProgress).then(function (r) { esiti[c] = r; });
      });
    });
    return chain.then(function () {
      var falliti = [];
      Object.keys(esiti).forEach(function (c) {
        (esiti[c].falliti || []).forEach(function (y) { falliti.push(c + ' ' + y); });
      });
      return { valute: esiti, falliti: falliti };
    });
  }

  /* ---------------------------------------------------------------------------
     LETTURA CAMBIO
     Ritorna sempre un oggetto descrittivo, mai un numero nudo:
       { rate, refDate, source, exact }
       source: 'MANUALE' | 'BCE' | 'BCE_PREC' | null
     ------------------------------------------------------------------------- */
  var MISSING = { rate: null, refDate: null, source: null, exact: false };

  function rate(dateLike, cur) {
    cur = norm(cur);
    // L'euro non si converte: vale sempre uno.
    if (cur === BASE) return { rate: 1, refDate: toISO(dateLike), source: 'BASE', exact: true, valuta: BASE };

    var iso = toISO(dateLike);
    if (!iso) return MISSING;
    var R = ratesOf(cur), M = manualOf(cur);

    if (M[iso] != null) return { rate: M[iso], refDate: iso, source: 'MANUALE', exact: true, valuta: cur };
    if (R[iso] != null) return { rate: R[iso], refDate: iso, source: 'BCE', exact: true, valuta: cur };

    // Weekend / festivo BCE: si usa l'ultima rilevazione precedente disponibile,
    // dichiarando la data effettivamente utilizzata.
    var probe = iso;
    for (var k = 0; k < 10; k++) {
      probe = addDays(probe, -1);
      if (M[probe] != null) return { rate: M[probe], refDate: probe, source: 'MANUALE', exact: false, valuta: cur };
      if (R[probe] != null) return { rate: R[probe], refDate: probe, source: 'BCE_PREC', exact: false, valuta: cur };
    }
    return MISSING;
  }

  // Elenco delle valute per cui esistono rilevazioni in memoria.
  function valuteDisponibili() {
    return Object.keys(store.rates).filter(function (c) {
      return Object.keys(store.rates[c] || {}).length > 0;
    }).sort();
  }

  // Media aritmetica delle rilevazioni BCE di un mese = "cambio medio mensile"
  // nell'accezione usata da Banca d'Italia / Agenzia delle Entrate.
  function monthlyAverage(year, month, cur) {
    cur = norm(cur);
    if (cur === BASE) return { rate: 1, refDate: String(year), source: 'BASE', exact: true, valuta: BASE };
    var pre = String(year) + '-' + String(month).padStart(2, '0') + '-';
    var R = ratesOf(cur), vals = [];
    Object.keys(R).forEach(function (d) { if (d.indexOf(pre) === 0) vals.push(R[d]); });
    if (vals.length === 0) return MISSING;
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return { rate: sum / vals.length, refDate: pre.slice(0, 7), source: 'BCE_MEDIA_MESE', exact: true, n: vals.length, valuta: cur };
  }

  function yearAverage(year, cur) {
    cur = norm(cur);
    if (cur === BASE) return { rate: 1, refDate: String(year), source: 'BASE', exact: true, valuta: BASE };
    var pre = String(year) + '-';
    var R = ratesOf(cur), vals = [];
    Object.keys(R).forEach(function (d) { if (d.indexOf(pre) === 0) vals.push(R[d]); });
    if (vals.length === 0) return MISSING;
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return { rate: sum / vals.length, refDate: String(year), source: 'BCE_MEDIA_ANNO', exact: true, n: vals.length, valuta: cur };
  }

  // Cambio di fine anno: 31/12, o ultima rilevazione utile precedente.
  // Per l'anno in corso restituisce l'ultima rilevazione disponibile.
  function yearEnd(year, cur) {
    cur = norm(cur);
    if (cur === BASE) return { rate: 1, refDate: String(year), source: 'BASE', exact: true, valuta: BASE };
    var nowYear = new Date().getFullYear();
    if (parseInt(year, 10) > nowYear) return MISSING;
    if (parseInt(year, 10) === nowYear) {
      var r = rate(todayISO(), cur);
      if (r.rate != null) return { rate: r.rate, refDate: r.refDate, source: 'BCE_ULTIMA', exact: false, valuta: cur };
      return MISSING;
    }
    return rate(year + '-12-31', cur);
  }

  /* ---------------------------------------------------------------------------
     CONVERSIONE
     ------------------------------------------------------------------------- */
  // USD -> EUR al cambio della data. Ritorna { eur, rate, refDate, source }.
  // Se il cambio manca, eur e' null: il chiamante DEVE segnalarlo, non stimarlo.
  function usdToEur(amount, dateLike, cur) {
    var r = rate(dateLike, cur);
    if (r.rate == null) return { eur: null, rate: null, refDate: null, source: null, exact: false };
    return { eur: (amount || 0) * r.rate, rate: r.rate, refDate: r.refDate, source: r.source, exact: r.exact };
  }

  function eurToUsd(amountEur, dateLike, cur) {
    var r = rate(dateLike, cur);
    if (r.rate == null) return { usd: null, rate: null, refDate: null, source: null };
    return { usd: (amountEur || 0) / r.rate, rate: r.rate, refDate: r.refDate, source: r.source };
  }

  /* ---------------------------------------------------------------------------
     OVERRIDE MANUALI
     ------------------------------------------------------------------------- */
  function setManual(dateLike, value, cur) {
    cur = norm(cur);
    var iso = toISO(dateLike);
    var v = parseFloat(value);
    if (!iso) return false;
    if (!isFinite(v) || v <= 0) { delete manualOf(cur)[iso]; saveCache(); return true; }
    // Guardia anti-convenzione-invertita: un cambio EUR/USD plausibile sta fra
    // 0.5 e 1.5 EUR per dollaro. Un 1.08 inserito pensando a "dollari per euro"
    // e' un errore classico: viene accettato ma il chiamante puo' avvisare.
    manualOf(cur)[iso] = v;
    saveCache();
    return true;
  }

  function isPlausible(v) { return isFinite(v) && v > 0.4 && v < 2.0; }

  function clearManual(cur) {
    if (cur) store.manual[norm(cur)] = {}; else store.manual = {};
    saveCache();
  }

  function manualEntries(cur) {
    var M = manualOf(norm(cur));
    return Object.keys(M).sort().map(function (d) { return { date: d, rate: M[d], valuta: norm(cur) }; });
  }

  /* ---------------------------------------------------------------------------
     DIAGNOSTICA — serve alle app per dichiarare la qualita' dei cambi usati
     ------------------------------------------------------------------------- */
  function coverage(cur) {
    cur = norm(cur);
    var yrs = yearsOf(cur), srcs = {};
    var years = Object.keys(yrs).sort();
    years.forEach(function (y) {
      var st = yrs[y];
      var name = (st && typeof st === 'object' && st.src) ? st.src : 'ECB';
      srcs[name] = (srcs[name] || 0) + 1;
    });
    return {
      valuta: cur,
      years: years,
      observations: Object.keys(ratesOf(cur)).length,
      manual: Object.keys(manualOf(cur)).length,
      sources: srcs,
      valuteDisponibili: valuteDisponibili()
    };
  }

  function sourceLabel(source, refDate) {
    switch (source) {
      case 'BCE': return 'BCE ' + refDate;
      case 'BCE_PREC': return 'BCE ' + refDate + ' (giorno prec.)';
      case 'BCE_MEDIA_MESE': return 'media BCE ' + refDate;
      case 'BCE_MEDIA_ANNO': return 'media BCE ' + refDate;
      case 'BCE_ULTIMA': return 'BCE ' + refDate + ' (ultima disp.)';
      case 'MANUALE': return 'manuale ' + refDate;
      default: return 'non disponibile';
    }
  }

  function reset() {
    store = { rates: {}, manual: {}, years: {} };
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
  }

  loadCache();

  global.FX = {
    BASE: BASE,
    toISO: toISO,
    addDays: addDays,
    todayISO: todayISO,
    ensureYears: ensureYears,
    ensureCurrencies: ensureCurrencies,
    valuteDisponibili: valuteDisponibili,
    rate: rate,
    monthlyAverage: monthlyAverage,
    yearAverage: yearAverage,
    yearEnd: yearEnd,
    usdToEur: usdToEur,
    eurToUsd: eurToUsd,
    setManual: setManual,
    clearManual: clearManual,
    manualEntries: manualEntries,
    isPlausible: isPlausible,
    coverage: coverage,
    sourceLabel: sourceLabel,
    reset: reset,
    _store: store
  };
})(window);

/* -----------------------------------------------------------------------------
   Versione e data dell'ultimo aggiornamento della suite.
   UNICO punto da cambiare: le tre pagine e tutti i PDF leggono da qui, cosi'
   la data stampata sui documenti non puo' divergere dal codice che li ha
   prodotti. Da aggiornare a ogni modifica di una qualsiasi pagina.
   -------------------------------------------------------------------------- */
(function (root) {
  'use strict';
  var VERSIONE = '3.4';
  var AGGIORNATA = '2026-11-03';           // ISO, giorno dell'ultima modifica
  var MESI = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio',
              'agosto','settembre','ottobre','novembre','dicembre'];

  function dataLunga() {
    var p = AGGIORNATA.split('-');
    return parseInt(p[2], 10) + ' ' + MESI[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }

  root.SUITE = {
    version: VERSIONE,
    updated: AGGIORNATA,
    updatedLong: dataLunga(),
    // Riga unica da mettere in fondo a schermo e nei PDF.
    label: 'MT5 Fiscal Suite v' + VERSIONE + ' — ultimo aggiornamento ' + dataLunga()
  };
})(window);
