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

   FONTE DATI: tassi di riferimento BCE, serviti dalle API Frankfurter.
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

  var CACHE_KEY = 'mt5fs_fx_ecb_usdeur_v1';
  var ENDPOINTS = [
    function (range) { return 'https://api.frankfurter.dev/v1/' + range + '?base=USD&symbols=EUR'; },
    function (range) { return 'https://api.frankfurter.app/' + range + '?from=USD&to=EUR'; }
  ];

  // rates:  'YYYY-MM-DD' -> number (EUR per 1 USD), solo rilevazioni BCE reali
  // manual: 'YYYY-MM-DD' -> number, forzature dell'utente
  // years:  '2025' -> ISO timestamp del download, per sapere cosa e' gia' coperto
  var store = { rates: {}, manual: {}, years: {} };

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
  function fetchJson(url, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 12000);
    return fetch(url, { signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; })
      .catch(function () { clearTimeout(timer); return null; });
  }

  // Scarica un intervallo intero in UNA sola chiamata (serie storica BCE).
  // Molto piu' affidabile e veloce di una richiesta per data.
  function fetchRange(fromISO, toISOStr) {
    var range = fromISO + '..' + toISOStr;
    var i = 0;
    function attempt() {
      if (i >= ENDPOINTS.length) return Promise.resolve(0);
      var url = ENDPOINTS[i++](range);
      return fetchJson(url).then(function (d) {
        if (!d || !d.rates) return attempt();
        var n = 0;
        Object.keys(d.rates).forEach(function (day) {
          var v = d.rates[day] && d.rates[day].EUR;
          if (typeof v === 'number' && isFinite(v) && v > 0) { store.rates[day] = v; n++; }
        });
        return n > 0 ? n : attempt();
      });
    }
    return attempt();
  }

  // Garantisce che gli anni indicati siano in cache. I cambi storici BCE non
  // cambiano mai: una volta scaricati restano validi per sempre.
  // L'anno corrente viene invece rinfrescato se la cache e' vecchia di un giorno.
  function ensureYears(years, onProgress) {
    var wanted = [];
    var nowYear = new Date().getFullYear();
    var today = todayISO();
    years.forEach(function (y) {
      y = parseInt(y, 10);
      if (!y || y < 1999 || y > nowYear) return;
      var stamp = store.years[y];
      var stale = !stamp || (y === nowYear && stamp.slice(0, 10) !== today);
      if (stale && wanted.indexOf(y) === -1) wanted.push(y);
    });
    if (wanted.length === 0) return Promise.resolve({ downloaded: 0, years: [] });

    wanted.sort();
    var done = 0, total = 0;
    var chain = Promise.resolve();
    wanted.forEach(function (y) {
      chain = chain.then(function () {
        if (onProgress) onProgress(done, wanted.length, y);
        var from = y + '-01-01';
        var to = (y === nowYear) ? today : (y + '-12-31');
        return fetchRange(from, to).then(function (n) {
          done++;
          if (n > 0) { store.years[y] = new Date().toISOString(); total += n; }
        });
      });
    });
    return chain.then(function () {
      saveCache();
      return { downloaded: total, years: wanted };
    });
  }

  /* ---------------------------------------------------------------------------
     LETTURA CAMBIO
     Ritorna sempre un oggetto descrittivo, mai un numero nudo:
       { rate, refDate, source, exact }
       source: 'MANUALE' | 'BCE' | 'BCE_PREC' | null
     ------------------------------------------------------------------------- */
  var MISSING = { rate: null, refDate: null, source: null, exact: false };

  function rate(dateLike) {
    var iso = toISO(dateLike);
    if (!iso) return MISSING;

    if (store.manual[iso] != null) {
      return { rate: store.manual[iso], refDate: iso, source: 'MANUALE', exact: true };
    }
    if (store.rates[iso] != null) {
      return { rate: store.rates[iso], refDate: iso, source: 'BCE', exact: true };
    }
    // Weekend / festivo BCE: si usa l'ultima rilevazione precedente disponibile,
    // dichiarando la data effettivamente utilizzata.
    var probe = iso;
    for (var k = 0; k < 10; k++) {
      probe = addDays(probe, -1);
      if (store.manual[probe] != null) {
        return { rate: store.manual[probe], refDate: probe, source: 'MANUALE', exact: false };
      }
      if (store.rates[probe] != null) {
        return { rate: store.rates[probe], refDate: probe, source: 'BCE_PREC', exact: false };
      }
    }
    return MISSING;
  }

  // Media aritmetica delle rilevazioni BCE di un mese = "cambio medio mensile"
  // nell'accezione usata da Banca d'Italia / Agenzia delle Entrate.
  function monthlyAverage(year, month) {
    var pre = String(year) + '-' + String(month).padStart(2, '0') + '-';
    var vals = [];
    Object.keys(store.rates).forEach(function (d) {
      if (d.indexOf(pre) === 0) vals.push(store.rates[d]);
    });
    if (vals.length === 0) return MISSING;
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return { rate: sum / vals.length, refDate: pre.slice(0, 7), source: 'BCE_MEDIA_MESE', exact: true, n: vals.length };
  }

  function yearAverage(year) {
    var pre = String(year) + '-';
    var vals = [];
    Object.keys(store.rates).forEach(function (d) {
      if (d.indexOf(pre) === 0) vals.push(store.rates[d]);
    });
    if (vals.length === 0) return MISSING;
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return { rate: sum / vals.length, refDate: String(year), source: 'BCE_MEDIA_ANNO', exact: true, n: vals.length };
  }

  // Cambio di fine anno: 31/12, o ultima rilevazione utile precedente.
  // Per l'anno in corso restituisce l'ultima rilevazione disponibile.
  function yearEnd(year) {
    var nowYear = new Date().getFullYear();
    if (parseInt(year, 10) > nowYear) return MISSING;
    if (parseInt(year, 10) === nowYear) {
      var r = rate(todayISO());
      if (r.rate != null) return { rate: r.rate, refDate: r.refDate, source: 'BCE_ULTIMA', exact: false };
      return MISSING;
    }
    return rate(year + '-12-31');
  }

  /* ---------------------------------------------------------------------------
     CONVERSIONE
     ------------------------------------------------------------------------- */
  // USD -> EUR al cambio della data. Ritorna { eur, rate, refDate, source }.
  // Se il cambio manca, eur e' null: il chiamante DEVE segnalarlo, non stimarlo.
  function usdToEur(amountUsd, dateLike) {
    var r = rate(dateLike);
    if (r.rate == null) return { eur: null, rate: null, refDate: null, source: null, exact: false };
    return { eur: (amountUsd || 0) * r.rate, rate: r.rate, refDate: r.refDate, source: r.source, exact: r.exact };
  }

  function eurToUsd(amountEur, dateLike) {
    var r = rate(dateLike);
    if (r.rate == null) return { usd: null, rate: null, refDate: null, source: null };
    return { usd: (amountEur || 0) / r.rate, rate: r.rate, refDate: r.refDate, source: r.source };
  }

  /* ---------------------------------------------------------------------------
     OVERRIDE MANUALI
     ------------------------------------------------------------------------- */
  function setManual(dateLike, value) {
    var iso = toISO(dateLike);
    var v = parseFloat(value);
    if (!iso) return false;
    if (!isFinite(v) || v <= 0) { delete store.manual[iso]; saveCache(); return true; }
    // Guardia anti-convenzione-invertita: un cambio EUR/USD plausibile sta fra
    // 0.5 e 1.5 EUR per dollaro. Un 1.08 inserito pensando a "dollari per euro"
    // e' un errore classico: viene accettato ma il chiamante puo' avvisare.
    store.manual[iso] = v;
    saveCache();
    return true;
  }

  function isPlausible(v) { return isFinite(v) && v > 0.4 && v < 2.0; }

  function clearManual() { store.manual = {}; saveCache(); }

  function manualEntries() {
    return Object.keys(store.manual).sort().map(function (d) {
      return { date: d, rate: store.manual[d] };
    });
  }

  /* ---------------------------------------------------------------------------
     DIAGNOSTICA — serve alle app per dichiarare la qualita' dei cambi usati
     ------------------------------------------------------------------------- */
  function coverage() {
    var years = Object.keys(store.years).sort();
    return {
      years: years,
      observations: Object.keys(store.rates).length,
      manual: Object.keys(store.manual).length
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
    toISO: toISO,
    addDays: addDays,
    todayISO: todayISO,
    ensureYears: ensureYears,
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
