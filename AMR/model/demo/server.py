"""
Tiny demo server for the AMR model. Standard library only.

    python demo/server.py            -> open http://127.0.0.1:8765

Endpoints (all JSON):
    GET  /api/meta         organisms, antibiotics, drugs, settings
    POST /api/empiric      stage 1: likely organisms + % coverage
    POST /api/resistance   stages 2-3: % works for every antibiotic, top-3, recommended
    POST /api/explain      why: the 'risk points' each fact added for one antibiotic
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from amr_predict import (AMRModel, SETTINGS, SPECIMENS, _sigmoid, ast_features,  # noqa: E402
                         context_features, flag_features, history_features)

MODEL = AMRModel.load()   # loaded ONCE at startup (~25 ms); every request reuses it

# drug -> ARMD antibiotic class (as recorded in the training data), so a UI can send just the drug name
DRUG_CLASS = {
    "amoxicillin": "Beta Lactam", "amoxicillin-clavulanate": "Beta Lactam", "cefazolin": "Beta Lactam",
    "cefoxitin": "Beta Lactam", "cefpodoxime": "Beta Lactam", "ceftriaxone": "Beta Lactam", "cephalexin": "Beta Lactam",
    "ertapenem": "Beta Lactam", "piperacillin-tazobactam": "Beta Lactam", "ciprofloxacin": "Fluoroquinolone",
    "levofloxacin": "Fluoroquinolone", "moxifloxacin": "Fluoroquinolone", "nitrofurantoin": "Nitrofuran",
    "sulfamethoxazole-trimethoprim": "Combination Antibiotic", "doxycycline": "Tetracycline",
    "gentamicin": "Aminoglycoside", "vancomycin": "Glycopeptide", "azithromycin": "Macrolide Lincosamide",
    "clindamycin": "Macrolide Lincosamide", "metronidazole": "Nitroimidazole", "linezolid": "Oxazolidinone",
}


def build_history(h):
    """UI history -> model history. Fills in the antibiotic class for each drug and adds
    prior organisms from prior results (a prior result implies that organism was found)."""
    if not h:
        return None
    out = {"prior_results": h.get("prior_results", []), "nursing_home": bool(h.get("nursing_home")),
           "prior_antibiotics": [dict(e, antibiotic_class=DRUG_CLASS.get(e.get("drug"))) for e in h.get("prior_antibiotics", [])],
           "prior_organisms": list(h.get("prior_organisms", []))}
    for r in out["prior_results"]:
        if r.get("organism"):
            out["prior_organisms"].append({"organism": r["organism"], "days_ago": r["days_ago"]})
    return out


def ctx(req):
    return dict(setting=req.get("setting"), age=req.get("age"), history=build_history(req.get("history")))


def explain(req):
    """Logistic regression = start score + one weight per fact that is true. Returns those numbers."""
    org, abx, spec = MODEL._org(req["organism"]), req["antibiotic"], req["specimen"]
    known = {k: v for k, v in (req.get("known_results") or {}).items()}
    flags = req.get("flags") or {}
    if abx in known:
        return {"kind": "lab", "text": "The lab already reported this result."}
    rule = MODEL._rule(org, abx, flags)
    if rule is not None:
        return {"kind": "rule", "percent_works": round(100 * (1 - rule), 1),
                "text": "Lab flag rule: in the training data this flag meant resistant >= 99% of the time."}
    m = MODEL.resistance[org][abx]
    if m["type"] == "constant":
        return {"kind": "constant", "percent_works": round(100 * (1 - m["p"]), 1), "n": m["n"],
                "text": ("Intrinsic resistance - this organism is naturally resistant." if m.get("intrinsic")
                         else "Too few resistant (or susceptible) cases to learn from - uses the historical rate.")}
    c = ctx(req)
    feats = (context_features(spec, c["setting"], c["age"]) + history_features(c["history"], org)
             + flag_features(flags) + ast_features(known, exclude=abx))
    contrib = sorted(([f, m["weights"][f]] for f in feats if f in m["weights"]), key=lambda x: -abs(x[1]))
    z = m["intercept"] + sum(w for _, w in contrib)
    return {"kind": "logistic", "intercept": m["intercept"], "start_percent_resistant": round(100 * _sigmoid(m["intercept"]), 1),
            "contributions": contrib, "total": round(z, 4), "percent_resistant": round(100 * _sigmoid(z), 1),
            "percent_works": round(100 * (1 - _sigmoid(z)), 1), "n_train": m["n"], "n_weights": len(m["weights"])}


def meta():
    return {"organisms": MODEL.organisms, "specimens": SPECIMENS, "settings": sorted(SETTINGS),
            "antibiotics": MODEL.antibiotics, "drugs": sorted(DRUG_CLASS),
            "pairs": {o: sorted(v) for o, v in MODEL.resistance.items()},
            "test": MODEL.meta.get("test_2022_2024", {})}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if self.path == "/api/meta":
            return self._send(200, meta())
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/api/empiric":
                return self._send(200, MODEL.empiric_coverage(req["specimen"], top_k=3, **ctx(req)))
            if self.path == "/api/resistance":
                return self._send(200, MODEL.predict_resistance(req["organism"], req["specimen"], top_k=3,
                                                                known_results=req.get("known_results"),
                                                                flags=req.get("flags"), **ctx(req)))
            if self.path == "/api/explain":
                return self._send(200, explain(req))
            self._send(404, {"error": "not found"})
        except Exception as e:  # demo server: report the problem to the page
            self._send(400, {"error": "%s: %s" % (type(e).__name__, e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print("AMR demo running on http://127.0.0.1:%d  (Ctrl+C to stop)" % port)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
