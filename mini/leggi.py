#!/usr/bin/env python3
"""Legge le vendite Etsy e le stampe Printify e le scrive nella cartella PARTITA IVA.

Gira ogni notte sul Mac mini (launchd com.stoicinkco.fiscale). La pagina
etsy.html della MT5 Fiscal Suite trova il file nella cartella collegata.

Regole:
- le due fonti sono indipendenti: se una fallisce l'altra si scrive lo stesso,
  e l'errore finisce NEL file, cosi' la pagina lo mostra invece di tacere;
- nessun importo viene stimato o convertito: si scrive quello che dice la fonte,
  con la sua valuta;
- la risposta grezza resta in raw/ su questo Mac, per poter controllare.
"""
import datetime, json, os, sys, time, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(BASE, "fiscale.env")
TOKEN = os.path.join(BASE, "etsy_token.json")
RAW = os.path.join(BASE, "raw")
USCITA_DIR = os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/PARTITA IVA/ETSY PRINTIFY AUTOMATICO")
USCITA = os.path.join(USCITA_DIR, "vendite_e_stampe.json")
UA = "stoicinkco-fiscale/1.0"

try:
    from zoneinfo import ZoneInfo
    ROMA = ZoneInfo("Europe/Rome")
except Exception:                      # pragma: no cover
    ROMA = None


def leggi_env():
    env = {}
    if os.path.exists(ENV):
        for riga in open(ENV, encoding="utf-8"):
            if "=" in riga and not riga.strip().startswith("#"):
                k, v = riga.strip().split("=", 1)
                env[k.strip()] = v.strip()
    return env


def http(url, headers=None, dati=None):
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, data=dati, headers=h, method="POST" if dati else "GET")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=90).read())
    except urllib.error.HTTPError as e:
        corpo = e.read().decode("utf-8", "ignore")[:300]
        raise RuntimeError("HTTP %s da %s: %s" % (e.code, urllib.parse.urlparse(url).netloc, corpo))


def giorno(ts):
    d = datetime.datetime.fromtimestamp(int(ts), ROMA) if ROMA else datetime.datetime.fromtimestamp(int(ts))
    return d.strftime("%Y-%m-%d")


def soldi(m):
    """Etsy scrive gli importi come {amount, divisor, currency_code}."""
    if not isinstance(m, dict) or m.get("amount") is None:
        return None, None
    return round(m["amount"] / float(m.get("divisor") or 100), 2), m.get("currency_code")


def salva_raw(nome, dati):
    os.makedirs(RAW, exist_ok=True)
    with open(os.path.join(RAW, nome), "w", encoding="utf-8") as f:
        json.dump(dati, f, ensure_ascii=False)
    os.chmod(os.path.join(RAW, nome), 0o600)


# ---------------------------------------------------------------- Etsy
def etsy(env, dal):
    if not os.path.exists(TOKEN):
        raise RuntimeError("Etsy non collegato: lanciare collega.py")
    chiave = env["ETSY_API_KEY"]
    keystring = chiave.split(":")[0]
    vecchio = json.load(open(TOKEN))
    dati = urllib.parse.urlencode({"grant_type": "refresh_token", "client_id": keystring,
                                   "refresh_token": vecchio["refresh_token"]}).encode()
    tok = http("https://api.etsy.com/v3/public/oauth/token",
               {"Content-Type": "application/x-www-form-urlencoded"}, dati)
    # Il refresh token ruota a ogni uso: va salvato SUBITO, o il prossimo giro resta fuori.
    with open(TOKEN, "w") as f:
        json.dump({"refresh_token": tok["refresh_token"]}, f)
    os.chmod(TOKEN, 0o600)
    h = {"x-api-key": chiave, "Authorization": "Bearer " + tok["access_token"]}

    grezzi, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"limit": 100, "offset": offset, "min_created": dal})
        r = http("https://openapi.etsy.com/v3/application/shops/%s/receipts?%s" % (env["ETSY_SHOP_ID"], q), h)
        pezzi = r.get("results") or []
        grezzi.extend(pezzi)
        offset += len(pezzi)
        if not pezzi or offset >= int(r.get("count") or 0):
            break
        time.sleep(0.3)
    salva_raw("etsy_receipts.json", grezzi)

    vendite = []
    for x in grezzi:
        pagato, valuta = soldi(x.get("grandtotal"))
        tasse = round((soldi(x.get("total_tax_cost"))[0] or 0) + (soldi(x.get("total_vat_cost"))[0] or 0), 2)
        righe = x.get("transactions") or []
        rimborsi = x.get("refunds") or []
        vendite.append({
            "ordine": str(x.get("receipt_id")),
            "data": giorno(x.get("created_timestamp") or x.get("create_timestamp")),
            "pagato": pagato, "valuta": valuta, "tasse": tasse,
            "articoli": soldi(x.get("subtotal"))[0], "spedizione": soldi(x.get("total_shipping_cost"))[0],
            "sconto": soldi(x.get("discount_amt"))[0],
            "paese": x.get("country_iso") or "",
            "titoli": [str(t.get("title") or "") for t in righe],
            "pezzi": sum(int(t.get("quantity") or 1) for t in righe) or 1,
            "pagata": bool(x.get("is_paid")), "stato": x.get("status") or "",
            "rimborsato": round(sum((soldi(r.get("amount"))[0] or 0) for r in rimborsi), 2),
        })
    vendite.sort(key=lambda v: (v["data"], v["ordine"]))
    return vendite


# ---------------------------------------------------------------- Printify
def printify(env):
    if not env.get("PRINTIFY_TOKEN"):
        raise RuntimeError("Printify non collegato: lanciare collega.py")
    h = {"Authorization": "Bearer " + env["PRINTIFY_TOKEN"]}
    grezzi, pagina = [], 1
    while True:
        r = http("https://api.printify.com/v1/shops/%s/orders.json?limit=50&page=%d" % (env["PRINTIFY_SHOP_ID"], pagina), h)
        grezzi.extend(r.get("data") or [])
        if pagina >= int(r.get("last_page") or 1):
            break
        pagina += 1
        time.sleep(0.3)
    salva_raw("printify_orders.json", grezzi)

    stampe = []
    for x in grezzi:
        righe = x.get("line_items") or []
        meta = x.get("metadata") or {}
        quando = x.get("sent_to_production_at") or x.get("created_at") or ""
        stampe.append({
            "id": str(x.get("id")),
            "ordine_etsy": str(meta.get("shop_order_id") or "") or None,
            "ordine_etsy_etichetta": str(meta.get("shop_order_label") or ""),
            "data": quando[:10],
            "in_produzione": bool(x.get("sent_to_production_at")),
            "stato": x.get("status") or "",
            "paese": (x.get("address_to") or {}).get("country") or "",
            "titoli": [str((r.get("metadata") or {}).get("title") or "") for r in righe],
            "pezzi": sum(int(r.get("quantity") or 1) for r in righe) or 1,
            # Costi come li da' l'API, in centesimi della valuta dell'API (di solito USD):
            # NON sono l'importo della fattura, che e' in euro e sta solo nel PDF.
            "costo_cent": sum(int(r.get("cost") or 0) for r in righe),
            "spedizione_cent": sum(int(r.get("shipping_cost") or 0) for r in righe),
        })
    stampe.sort(key=lambda s: (s["data"], s["id"]))
    return stampe


def main():
    env = leggi_env()
    anno = datetime.date.today().year
    # Dall'inizio dell'anno scorso: copre l'anno da dichiarare e quello in corso.
    dal = int(datetime.datetime(anno - 1, 1, 1).timestamp())
    fuori = {"tipo": "etsy_printify_auto", "versione": 1,
             "generato": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
             "etsy": {"ok": False, "errore": None, "vendite": []},
             "printify": {"ok": False, "errore": None, "stampe": []}}
    try:
        fuori["etsy"]["vendite"] = etsy(env, dal)
        fuori["etsy"]["ok"] = True
    except Exception as e:
        fuori["etsy"]["errore"] = str(e)
    try:
        fuori["printify"]["stampe"] = printify(env)
        fuori["printify"]["ok"] = True
    except Exception as e:
        fuori["printify"]["errore"] = str(e)

    # Una fonte fallita non cancella quello che la notte prima era riuscito.
    if os.path.exists(USCITA):
        try:
            prima = json.load(open(USCITA, encoding="utf-8"))
            for fonte, chiave in (("etsy", "vendite"), ("printify", "stampe")):
                if not fuori[fonte]["ok"] and prima.get(fonte, {}).get(chiave):
                    fuori[fonte][chiave] = prima[fonte][chiave]
                    fuori[fonte]["dati_del"] = prima[fonte].get("dati_del") or prima.get("generato")
        except Exception:
            pass

    os.makedirs(USCITA_DIR, exist_ok=True)
    tmp = USCITA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(fuori, f, ensure_ascii=False, indent=1)
    os.replace(tmp, USCITA)
    print("%s  Etsy: %s (%d vendite)  Printify: %s (%d stampe)" % (
        fuori["generato"],
        "ok" if fuori["etsy"]["ok"] else "ERRORE " + str(fuori["etsy"]["errore"]), len(fuori["etsy"]["vendite"]),
        "ok" if fuori["printify"]["ok"] else "ERRORE " + str(fuori["printify"]["errore"]), len(fuori["printify"]["stampe"])))
    return 0 if fuori["etsy"]["ok"] and fuori["printify"]["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
