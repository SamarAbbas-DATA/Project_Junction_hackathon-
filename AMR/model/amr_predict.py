"""
AMR prediction model (trained on real hospital data: Stanford ARMD) - inference.

Pure Python standard library (3.8+). No numpy, no sklearn, no lightgbm.
Everything the model knows is in amr_model.json; this file reads it and does the maths.

Three questions it answers, all as percentages:
  1. predict_organism()   - sample just taken: which organism is it likely to be? (top-k with %)
  2. predict_resistance() - organism identified (optionally some results already back):
                            % chance each antibiotic works, plus a stewardship-aware top-k recommendation
  3. empiric_coverage()   - sample just taken: % chance each antibiotic covers whatever grows

Patient history (optional, but it is where most of the real-world signal is):
    history = {
        "prior_results":     [{"antibiotic": "Ciprofloxacin", "organism": "Escherichia coli", "result": "R", "days_ago": 40}],
        "prior_antibiotics": [{"drug": "ciprofloxacin", "days_ago": 20}],          # drug name or "antibiotic_class"
        "prior_organisms":   [{"organism": "Escherichia coli", "days_ago": 40}],
        "nursing_home": True,
    }

Usage:
    from amr_predict import AMRModel
    m = AMRModel.load()
    m.predict_resistance("Escherichia coli", specimen="urine", setting="emergency", age=72,
                         history=history, known_results={"Cefazolin": "R"}, top_k=3)

CLI: python amr_predict.py --help
"""

import argparse
import json
import math
import os
import re

# ---------------------------------------------------------------- vocabulary

SPECIMENS = ("urine", "blood", "respiratory")
# ARMD age bins (adults only)
AGE_BINS = ((24, "18-24"), (34, "25-34"), (44, "35-44"), (54, "45-54"), (64, "55-64"),
            (74, "65-74"), (84, "75-84"), (89, "85-89"))
# convenience settings -> ARMD ward flags + ordering mode
SETTINGS = {
    "outpatient": (("OP",), "outpatient"),
    "emergency": (("IP", "ER"), "inpatient"),     # in ARMD, ER cultures belong to admitted encounters
    "inpatient": (("IP",), "inpatient"),
    "icu": (("IP", "ICU"), "inpatient"),
}
FLAGS = ("mrsa", "vre", "cre", "esbl", "mucoid", "cf")   # tags the lab puts in the organism name
RES_WINDOWS = (30, 90, 365, 100000)          # prior resistance windows (days); 100000 = ever
EXP_WINDOWS = (30, 90, 365)                  # prior antibiotic exposure windows (days)
ORG_WINDOWS = (90, 365, 100000)              # prior organism windows (days)

DRUG_SYNONYMS = {
    "cipro": "ciprofloxacin", "keflex": "cephalexin", "zithromax": "azithromycin", "bactrim": "sulfamethoxazole-trimethoprim",
    "augmentin": "amoxicillin-clavulanate", "amoxicillin-pot clavulanate": "amoxicillin-clavulanate",
    "piperacillin-tazobactam-dextrs": "piperacillin-tazobactam", "zosyn": "piperacillin-tazobactam",
    "macrobid": "nitrofurantoin", "bactrim ds": "sulfamethoxazole-trimethoprim", "septra ds": "sulfamethoxazole-trimethoprim",
    "fosfomycin tromethamine": "fosfomycin", "levaquin": "levofloxacin", "rocephin": "ceftriaxone", "flagyl": "metronidazole",
}
_DRUG_SUFFIX = re.compile(r"\s+(hcl|in nacl|in dextrose|in|hyclate|phosphate|macrocrystal|monohydrate|sodium|"
                          r"potassium|calcium|ethylsuccinate|stearate|lactobionate|mono-mac)\b.*$")


def normalize_drug(name):
    """'Ciprofloxacin Hcl' / 'Cipro' / 'Ciprofloxacin In' -> 'ciprofloxacin'."""
    n = str(name).strip().lower()
    n = _DRUG_SUFFIX.sub("", n)
    n = re.sub(r"-(sodium citrate|diluent combo|dextrose)$", "", n).strip()
    return DRUG_SYNONYMS.get(n, n)


def age_bin(age):
    """Number (years) or an ARMD bin label -> ARMD bin label."""
    if age is None or str(age).strip().lower() in ("", "null", "nan", "none"):
        return None
    if isinstance(age, str) and not age.replace(".", "", 1).isdigit():
        a = age.lower().replace(" years", "").strip()
        return "90+" if ("90" in a and ("above" in a or "+" in a)) else a
    age = float(age)
    if age < 18:
        return None  # model is adults-only
    for upper, label in AGE_BINS:
        if age <= upper:
            return label
    return "90+"


# ---------------------------------------------------------------- features
# prepare_data.py calls these exact functions, so features cannot drift between training and inference.

def context_features(specimen, setting=None, age=None, gender=None, ward_flags=None, ordering_mode=None):
    """Known when the sample is taken."""
    f = ["spec=" + str(specimen).lower()]
    if setting:
        wf, mode = SETTINGS[str(setting).lower()]
        ward_flags = ward_flags or wf
        ordering_mode = ordering_mode or mode
    for w in ward_flags or ():
        f.append("ward=" + str(w).upper())
    if ordering_mode:
        f.append("mode=" + str(ordering_mode).lower())
    b = age_bin(age)
    if b:
        f.append("age=" + b)
    if gender is not None and str(gender) in ("0", "1"):
        f.append("gender=" + str(gender))   # ARMD encodes gender as anonymous 0/1
    return f


def _win(days, windows):
    return [w for w in windows if days <= w]


def _wname(w):
    return "ever" if w >= 100000 else "%dd" % w


def history_features(history=None, organism=None):
    """Patient history before this culture. organism = the organism of this isolate (for same-organism features)."""
    if not history:
        return []
    f = set()
    # "prior_results" = earlier lab results (R or S). "prior_resistance" is accepted as an alias (result R).
    prior = list(history.get("prior_results", ()) or ()) +         [dict(r, result="R") for r in history.get("prior_resistance", ()) or ()]
    for r in prior:
        d = float(r.get("days_ago", 0))
        if d < 1:
            continue
        abx = str(r["antibiotic"])
        res = "S" if str(r.get("result", "R")).upper()[:1] == "S" else "R"
        same = organism and str(r.get("organism", "")).lower() == str(organism).lower()
        if res == "R":
            for w in _win(d, RES_WINDOWS):
                f.add("prevR_%s:%s" % (_wname(w), abx))
        if same:
            for w in _win(d, (365, 100000)):
                f.add("prev%ssame_%s:%s" % (res, _wname(w), abx))
    for e in history.get("prior_antibiotics", ()) or ():
        d = float(e.get("days_ago", 0))
        if d < 1:
            continue
        for w in _win(d, EXP_WINDOWS):
            if e.get("antibiotic_class"):
                f.add("cls_%s:%s" % (_wname(w), e["antibiotic_class"]))
            if e.get("drug"):
                f.add("drug_%s:%s" % (_wname(w), normalize_drug(e["drug"])))
    for o in history.get("prior_organisms", ()) or ():
        d = float(o.get("days_ago", 0))
        if d < 1:
            continue
        for w in _win(d, ORG_WINDOWS):
            f.add("prevOrg_%s:%s" % (_wname(w), o["organism"]))
    if history.get("nursing_home"):
        f.add("nursing_home")
    return sorted(f)


def ast_features(known_results=None, exclude=None):
    """Results already reported for this isolate: {"Ciprofloxacin": "R", "Cefazolin": "S"}. Intermediate counts as R."""
    f = []
    for abx, res in (known_results or {}).items():
        res = str(res).upper()[:1]
        res = "R" if res == "I" else res
        if abx == exclude or res not in ("R", "S"):
            continue
        f.append(res + ":" + abx)
    return f


def flag_features(flags=None):
    return ["flag:" + k for k, v in (flags or {}).items() if k in FLAGS and v]


# ---------------------------------------------------------------- maths

def _sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def _softmax(zs):
    m = max(zs)
    ex = [math.exp(z - m) for z in zs]
    s = sum(ex)
    return [e / s for e in ex]


def _tree_value(tree, fset, fidx):
    """Binary-feature regression tree stored as flat arrays: go right if the feature is present."""
    node = 0
    feat, left, right, value = tree["f"], tree["l"], tree["r"], tree["v"]
    while feat[node] >= 0:
        node = right[node] if fidx[feat[node]] in fset else left[node]
    return value[node]


AWARE_ORDER = {"Access": 0, "Watch": 1, "Reserve": 2}


# ---------------------------------------------------------------- model

class AMRModel:
    def __init__(self, params):
        self.p = params
        self.meta = params.get("meta", {})
        self.antibiotics = params["antibiotics"]            # name -> {class, aware, specimens}
        self.resistance = params["resistance_models"]       # organism -> antibiotic -> model
        self.rules = params.get("rules", {})                # organism -> flag -> antibiotic -> P(R)
        self.organism_model = params["organism_model"]
        self._org_lookup = {o.lower(): o for o in self.resistance}

    @classmethod
    def load(cls, path=None):
        path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "amr_model.json")
        with open(path, encoding="utf-8") as f:
            return cls(json.load(f))

    @property
    def organisms(self):
        return sorted(self.resistance)

    def _org(self, organism):
        o = self._org_lookup.get(str(organism).lower())
        if not o:
            raise ValueError("Unknown organism %r. Known: %s" % (organism, ", ".join(self.organisms)))
        return o

    # ---- raw probability from one stored model
    def _p(self, model, feats):
        t = model["type"]
        if t == "constant":
            return model["p"]
        if t == "logistic":
            w = model["weights"]
            return _sigmoid(model["intercept"] + sum(w.get(f, 0.0) for f in feats))
        if t == "gbm":
            fset = set(feats)
            z = model["init"] + sum(_tree_value(tr, fset, model["features"]) for tr in model["trees"])
            return _sigmoid(z)
        raise ValueError("unknown model type " + t)

    def _rule(self, organism, abx, flags):
        for fl, v in (flags or {}).items():
            if v:
                p = self.rules.get(organism, {}).get(fl, {}).get(abx)
                if p is not None:
                    return p
        return None

    # ---- 1. organism
    def predict_organism(self, specimen, setting=None, age=None, gender=None, history=None, top_k=None, **ctx):
        m = self.organism_model
        z = list(m["intercept"])
        for f in context_features(specimen, setting, age, gender, **ctx) + history_features(history):
            w = m["weights"].get(f)
            if w:
                z = [a + b for a, b in zip(z, w)]
        probs = sorted(zip(m["classes"], _softmax(z)), key=lambda t: -t[1])
        out = [{"organism": o, "probability": round(p, 4), "percent": round(100 * p, 1)} for o, p in probs]
        return out[:top_k] if top_k else out

    # ---- 2. resistance for a known organism
    def predict_resistance(self, organism, specimen, setting=None, age=None, gender=None, history=None,
                           known_results=None, flags=None, top_k=3, min_percent=80.0, **ctx):
        """Returns {"ranked": every antibiotic sorted by % chance it works,
                    "top": the top_k of those,
                    "recommended": top_k stewardship-aware picks (narrowest WHO AWaRe group with >= min_percent)}"""
        org = self._org(organism)
        spec = str(specimen).lower()
        known = {k: ("R" if str(v).upper()[:1] in "RI" else "S") for k, v in (known_results or {}).items()}
        base = (context_features(spec, setting, age, gender, **ctx) + history_features(history, org)
                + flag_features(flags))
        rows = []
        for abx, model in self.resistance[org].items():
            info = self.antibiotics.get(abx, {})
            if spec not in info.get("specimens", SPECIMENS):
                continue  # e.g. nitrofurantoin is only reported for urine
            rule_p = self._rule(org, abx, flags)
            if abx in known:
                p_r, src = (1.0 if known[abx] == "R" else 0.0), "lab"
            elif rule_p is not None:
                p_r, src = rule_p, "rule"
            else:
                p_r = self._p(model, base + ast_features(known, exclude=abx))
                src = "intrinsic" if model.get("intrinsic") else "model"
            rows.append({"antibiotic": abx, "class": info.get("class"), "aware": info.get("aware"),
                         "percent_works": round(100 * (1 - p_r), 1), "p_resistant": round(p_r, 4),
                         "source": src, "n_train": model.get("n")})
        rows.sort(key=lambda r: -r["percent_works"])
        ok = [r for r in rows if r["percent_works"] >= min_percent]
        rec = sorted(ok, key=lambda r: (AWARE_ORDER.get(r["aware"], 3), -r["percent_works"]))[:top_k] or rows[:top_k]
        return {"organism": org, "ranked": rows, "top": rows[:top_k], "recommended": rec}

    # ---- 3. empiric coverage before anything grows
    def empiric_coverage(self, specimen, setting=None, age=None, gender=None, history=None, top_k=3,
                         min_percent=80.0, **ctx):
        """% chance each antibiotic covers the organism, averaged over the likely organisms.
        'Other' (rare organisms the model has no resistance data for) is left out and reported separately.
        An antibiotic not tested for an organism counts as not covering it."""
        spec = str(specimen).lower()
        orgs = self.predict_organism(spec, setting, age, gender, history, **ctx)
        p_other = sum(o["probability"] for o in orgs if o["organism"] not in self.resistance)
        known_orgs = [o for o in orgs if o["organism"] in self.resistance]
        total = sum(o["probability"] for o in known_orgs) or 1.0
        cover = {}
        for o in known_orgs:
            org, po = o["organism"], o["probability"] / total
            feats = context_features(spec, setting, age, gender, **ctx) + history_features(history, org)
            for abx, model in self.resistance[org].items():
                cover[abx] = cover.get(abx, 0.0) + po * (1 - self._p(model, feats))
        rows = []
        for abx, info in self.antibiotics.items():
            if spec not in info.get("specimens", SPECIMENS) or abx not in cover:
                continue
            rows.append({"antibiotic": abx, "class": info.get("class"), "aware": info.get("aware"),
                         "percent_covers": round(100 * cover[abx], 1)})
        rows.sort(key=lambda r: -r["percent_covers"])
        ok = [r for r in rows if r["percent_covers"] >= min_percent]
        rec = sorted(ok, key=lambda r: (AWARE_ORDER.get(r["aware"], 3), -r["percent_covers"]))[:top_k] or rows[:top_k]
        return {"likely_organisms": orgs[:max(top_k, 5)], "percent_other_organism": round(100 * p_other, 1),
                "ranked": rows, "top": rows[:top_k], "recommended": rec}


# ---------------------------------------------------------------- CLI

def _main():
    ap = argparse.ArgumentParser(description="AMR prediction (real-data model). Omit --organism for empiric mode.")
    ap.add_argument("--model")
    ap.add_argument("--organism")
    ap.add_argument("--specimen", required=True, choices=SPECIMENS)
    ap.add_argument("--setting", choices=sorted(SETTINGS))
    ap.add_argument("--age", type=float)
    ap.add_argument("--known", nargs="*", default=[], help='e.g. "Cefazolin=R" "Ciprofloxacin=S"')
    ap.add_argument("--flag", nargs="*", default=[], help="e.g. mrsa esbl")
    ap.add_argument("--prior-r", nargs="*", default=[], help='prior resistance "Ciprofloxacin:40" (antibiotic:days_ago)')
    ap.add_argument("--prior-abx", nargs="*", default=[], help='prior antibiotics "ciprofloxacin:20" (drug:days_ago)')
    ap.add_argument("--nursing-home", action="store_true")
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    m = AMRModel.load(a.model)
    hist = {"prior_results": [{"antibiotic": s.rsplit(":", 1)[0], "organism": a.organism, "result": "R",
                               "days_ago": float(s.rsplit(":", 1)[1])} for s in a.prior_r],
            "prior_antibiotics": [{"drug": s.rsplit(":", 1)[0], "days_ago": float(s.rsplit(":", 1)[1])} for s in a.prior_abx],
            "nursing_home": a.nursing_home}
    kw = dict(setting=a.setting, age=a.age, history=hist, top_k=a.top)
    if a.organism:
        out = m.predict_resistance(a.organism, a.specimen, known_results=dict(k.split("=", 1) for k in a.known),
                                   flags={f: 1 for f in a.flag}, **kw)
        if a.json:
            return print(json.dumps(out, indent=2))
        print("%s | %s | setting=%s age=%s\n" % (out["organism"], a.specimen, a.setting, a.age))
        print("%-32s %-8s %9s  %s" % ("antibiotic", "AWaRe", "% works", "source"))
        for r in out["ranked"]:
            print("%-32s %-8s %8.1f%%  %s" % (r["antibiotic"], r["aware"] or "-", r["percent_works"], r["source"]))
        print("\nTop %d by probability: %s" % (a.top, ", ".join("%s %.0f%%" % (r["antibiotic"], r["percent_works"]) for r in out["top"])))
        print("Recommended (narrowest >=80%%): %s" % ", ".join("%s %.0f%%" % (r["antibiotic"], r["percent_works"]) for r in out["recommended"]))
    else:
        out = m.empiric_coverage(a.specimen, **kw)
        if a.json:
            return print(json.dumps(out, indent=2))
        print("Empiric mode: %s | setting=%s age=%s\n\nLikely organisms:" % (a.specimen, a.setting, a.age))
        for o in out["likely_organisms"]:
            print("  %-34s %5.1f%%" % (o["organism"], o["percent"]))
        print("\n%-32s %-8s %10s" % ("antibiotic", "AWaRe", "% covers"))
        for r in out["ranked"]:
            print("%-32s %-8s %9.1f%%" % (r["antibiotic"], r["aware"] or "-", r["percent_covers"]))
        print("\nRecommended (narrowest >=80%%): %s" % (", ".join("%s %.0f%%" % (r["antibiotic"], r["percent_covers"]) for r in out["recommended"]) or "-"))


if __name__ == "__main__":
    _main()
