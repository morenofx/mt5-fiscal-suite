#!/usr/bin/env python3
"""Collega UNA volta la lettura automatica a Etsy e a Printify.

Si lancia nel Terminale (non in chat):
    ssh -t mac-mini-di-moreno.local python3 stoicinkco/fiscale/collega.py

Chiede due cose, e niente di quello che scrivi esce da questo computer:
1. il token personale di Printify (incollato a schermo spento);
2. il permesso di Etsy di LEGGERE gli ordini: apri il link, premi "Grant access",
   Etsy ti manda su una pagina n8n che da' errore (e' normale) e tu incolli qui
   l'indirizzo intero di quella pagina.

Salva tutto in fiscale.env e etsy_token.json, leggibili solo da te (chmod 600).
Si puo' rilanciare: salta quello che e' gia' a posto.
"""
import base64, getpass, glob, hashlib, json, os, re, secrets, sys, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(BASE, "fiscale.env")
TOKEN = os.path.join(BASE, "etsy_token.json")
REDIRECT = "https://n8n.stoicinkco.com/rest/oauth2-credential/callback"
UA = "stoicinkco-fiscale/1.0"


def leggi_env():
    env = {}
    if os.path.exists(ENV):
        for riga in open(ENV, encoding="utf-8"):
            if "=" in riga and not riga.strip().startswith("#"):
                k, v = riga.strip().split("=", 1)
                env[k.strip()] = v.strip()
    return env


def scrivi_env(env):
    with open(ENV, "w", encoding="utf-8") as f:
        for k in sorted(env):
            f.write(k + "=" + env[k] + "\n")
    os.chmod(ENV, 0o600)


def chiama(url, headers):
    req = urllib.request.Request(url, headers=dict(headers, **{"User-Agent": UA}))
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def chiave_etsy_da_n8n():
    """La chiave dell'app Etsy e' gia' su questo Mac, nei workflow di n8n salvati."""
    for p in sorted(glob.glob(os.path.expanduser("~/stoicinkco/*.json")), reverse=True):
        t = open(p, encoding="utf-8", errors="ignore").read()
        for m in re.findall(r'x-api-key\W{1,40}?value\W{1,8}([A-Za-z0-9]+:[A-Za-z0-9]+)', t):
            return m
    return None


def main():
    env = leggi_env()

    # ---------- Etsy: chiave dell'app ----------
    if not env.get("ETSY_API_KEY"):
        k = chiave_etsy_da_n8n()
        if not k:
            k = getpass.getpass("Chiave dell'app Etsy (keystring:secret), non si vede mentre incolli: ").strip()
        env["ETSY_API_KEY"] = k
    env.setdefault("ETSY_SHOP_ID", "59720304")
    scrivi_env(env)
    print("Etsy: chiave dell'app a posto.")

    # ---------- Printify ----------
    if env.get("PRINTIFY_TOKEN") and env.get("PRINTIFY_SHOP_ID"):
        print("Printify: gia' collegato.")
    else:
        print("\nPRINTIFY - crea il token: printify.com -> Account (in basso a sinistra) -> Connections")
        print("-> Personal Access Tokens -> Generate. Bastano i permessi di lettura (shops, orders).")
        # Il token Printify e' lungo piu' di 1024 caratteri: incollato in una riga del
        # Terminale si blocca (limite del terminale) e Invio non parte. Per questo
        # arriva dagli appunti, in ingresso al programma:
        #     pbpaste | ssh mac-mini-di-moreno.local python3 stoicinkco/fiscale/collega.py --printify-stdin
        if "--printify-stdin" in sys.argv:
            tok = "".join(sys.stdin.read().split())
            if len(tok) < 100:
                sys.exit("Negli appunti non c'e' un token Printify (troppo corto): ricopialo da Printify e rilancia.")
        elif not sys.stdin.isatty():
            tok = ""
        else:
            print("Il token e' troppo lungo per essere incollato qui: copialo e lancia invece")
            print("    pbpaste | ssh mac-mini-di-moreno.local python3 stoicinkco/fiscale/collega.py --printify-stdin")
            tok = ""
        if tok:
            try:
                negozi = chiama("https://api.printify.com/v1/shops.json", {"Authorization": "Bearer " + tok})
            except Exception as e:
                sys.exit("Printify ha rifiutato il token: " + str(e))
            if not negozi:
                sys.exit("Il token funziona ma non vede nessun negozio.")
            scelto = negozi[0]
            for n in negozi:
                if "etsy" in str(n.get("sales_channel", "")).lower():
                    scelto = n
            env["PRINTIFY_TOKEN"] = tok
            env["PRINTIFY_SHOP_ID"] = str(scelto["id"])
            scrivi_env(env)
            print("Printify: collegato al negozio \"%s\"." % scelto.get("title", scelto["id"]))
        else:
            print("Printify: saltato.")
    if "--printify-stdin" in sys.argv:
        return        # l'ingresso e' servito per il token: il permesso Etsy si da' col comando normale

    # ---------- Etsy: permesso di leggere gli ordini ----------
    if os.path.exists(TOKEN):
        print("Etsy: permesso gia' dato (etsy_token.json c'e'). Per rifarlo cancella quel file.")
    else:
        keystring = env["ETSY_API_KEY"].split(":")[0]
        verifier = secrets.token_urlsafe(64)[:96]
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        state = secrets.token_urlsafe(16)
        url = "https://www.etsy.com/oauth/connect?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": keystring, "redirect_uri": REDIRECT,
            "scope": "transactions_r shops_r", "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256"})
        print("\nETSY - apri questo link nel browser dove sei gia' dentro Etsy e premi \"Grant access\":\n\n" + url + "\n")
        print("Finisci su una pagina n8n con un errore: e' normale. Copia l'indirizzo INTERO dalla barra.")
        # Un indirizzo sbagliato non chiude il programma: lo dice e richiede.
        while True:
            back = input("Incollalo qui e premi Invio: ").strip()
            q = urllib.parse.parse_qs(urllib.parse.urlparse(back).query)
            if q.get("state", [""])[0] == state and q.get("code"):
                break
            if "etsy.com/oauth" in back:
                print("\nQuesto e' il link di ETSY, non quello di ritorno: vuol dire che Etsy non ti ha ancora")
                print("mandato avanti. Nella pagina Etsy premi \"Grant access\"; se invece mostra un errore,")
                print("non c'e' niente da copiare: fermati con Ctrl+C e riferisci l'errore.")
                print("L'indirizzo giusto inizia con  https://n8n.stoicinkco.com/  e contiene  code=\n")
            elif q.get("error"):
                sys.exit("Etsy ha risposto con un errore: " + str(q.get("error_description", q["error"])[0]))
            else:
                print("\nNon e' l'indirizzo giusto: deve iniziare con https://n8n.stoicinkco.com/ e contenere code=\n")
        dati = urllib.parse.urlencode({"grant_type": "authorization_code", "client_id": keystring,
                                       "redirect_uri": REDIRECT, "code": q["code"][0],
                                       "code_verifier": verifier}).encode()
        req = urllib.request.Request("https://api.etsy.com/v3/public/oauth/token", data=dati, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
        try:
            tok = json.loads(urllib.request.urlopen(req, timeout=60).read())
        except Exception as e:
            sys.exit("Etsy non ha accettato il codice: " + str(e))
        with open(TOKEN, "w") as f:
            json.dump({"refresh_token": tok["refresh_token"]}, f)
        os.chmod(TOKEN, 0o600)
        print("Etsy: permesso salvato.")

    print("\nFatto. Ora la lettura parte da sola ogni notte; per provarla subito:")
    print("    python3 ~/stoicinkco/fiscale/leggi.py")


if __name__ == "__main__":
    main()
