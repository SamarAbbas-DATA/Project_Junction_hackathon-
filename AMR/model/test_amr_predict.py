"""Tests for the real-data AMR predictor. Standard library only.

    python -m unittest -v test_amr_predict.py
    python -S -m unittest -v test_amr_predict.py     # -S: proves no installed packages are needed
"""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from amr_predict import AMRModel, age_bin, history_features, normalize_drug  # noqa: E402

ECOLI = "Escherichia coli"
CASE = dict(specimen="urine", setting="emergency", age=78)
CIPRO_HISTORY = {"prior_results": [{"antibiotic": "Ciprofloxacin", "organism": ECOLI, "result": "R", "days_ago": 30}]}


def works(out, abx):
    return {r["antibiotic"]: r for r in out["ranked"]}[abx]["percent_works"]


class TestModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = AMRModel.load(os.path.join(HERE, "amr_model.json"))

    # ---- packaging
    def test_stdlib_only(self):
        for lib in ("numpy", "pandas", "sklearn", "lightgbm"):
            self.assertNotIn(lib, sys.modules)

    def test_contents(self):
        self.assertGreaterEqual(len(self.m.organisms), 15)
        self.assertIn(ECOLI, self.m.organisms)
        self.assertIn("test_2022_2024", self.m.meta)
        self.assertEqual(self.m.antibiotics["Nitrofurantoin"]["aware"], "Access")

    # ---- stage 1: organism
    def test_organism_percentages(self):
        out = self.m.predict_organism("urine", "outpatient", 45)
        self.assertAlmostEqual(sum(o["probability"] for o in out), 1.0, places=2)
        self.assertEqual(out[0]["organism"], ECOLI)
        self.assertEqual(len(self.m.predict_organism("urine", top_k=3)), 3)
        self.assertAlmostEqual(out[0]["percent"], 100 * out[0]["probability"], delta=0.06)

    def test_respiratory_not_ecoli(self):
        top = self.m.predict_organism("respiratory", "icu", 60)[0]["organism"]
        self.assertIn(top, ("Staphylococcus aureus", "Pseudomonas aeruginosa"))

    def test_prior_organism_shifts_prediction(self):
        def p(h):
            return {o["organism"]: o["probability"] for o in self.m.predict_organism("urine", "inpatient", 70, history=h)}
        before = p(None)["Pseudomonas aeruginosa"]
        after = p({"prior_organisms": [{"organism": "Pseudomonas aeruginosa", "days_ago": 30}]})["Pseudomonas aeruginosa"]
        self.assertGreater(after, 2 * before)

    # ---- stage 2: resistance
    def test_output_shape_and_percentages(self):
        out = self.m.predict_resistance(ECOLI, **CASE)
        self.assertEqual(len(out["top"]), 3)
        self.assertTrue(1 <= len(out["recommended"]) <= 3)
        pct = [r["percent_works"] for r in out["ranked"]]
        self.assertEqual(pct, sorted(pct, reverse=True))
        for r in out["ranked"]:
            self.assertTrue(0 <= r["percent_works"] <= 100)
            self.assertAlmostEqual(r["percent_works"], 100 * (1 - r["p_resistant"]), delta=0.06)

    def test_organism_name_case_insensitive(self):
        self.assertEqual(self.m.predict_resistance("escherichia COLI", "urine")["organism"], ECOLI)

    def test_unknown_organism(self):
        with self.assertRaises(ValueError):
            self.m.predict_resistance("Martian bacillus", "urine")

    def test_prior_resistance_lowers_chance(self):
        no_h = works(self.m.predict_resistance(ECOLI, **CASE), "Ciprofloxacin")
        with_h = works(self.m.predict_resistance(ECOLI, **CASE, history=CIPRO_HISTORY), "Ciprofloxacin")
        self.assertLess(with_h, no_h - 20)   # real data: ~85% -> well under 65%

    def test_prior_antibiotic_use_lowers_chance(self):
        no_h = works(self.m.predict_resistance(ECOLI, **CASE), "Ciprofloxacin")
        h = {"prior_antibiotics": [{"drug": "Ciprofloxacin Hcl", "antibiotic_class": "Fluoroquinolone", "days_ago": 20}]}
        self.assertLess(works(self.m.predict_resistance(ECOLI, **CASE, history=h), "Ciprofloxacin"), no_h - 5)

    def test_prior_susceptible_same_organism_raises_chance(self):
        no_h = works(self.m.predict_resistance(ECOLI, **CASE), "Ciprofloxacin")
        h = {"prior_results": [{"antibiotic": "Ciprofloxacin", "organism": ECOLI, "result": "S", "days_ago": 60}]}
        self.assertGreater(works(self.m.predict_resistance(ECOLI, **CASE, history=h), "Ciprofloxacin"), no_h)

    def test_partial_results_update(self):
        base = works(self.m.predict_resistance(ECOLI, **CASE), "Ceftriaxone")
        out = self.m.predict_resistance(ECOLI, **CASE, known_results={"Cefazolin": "R", "Ampicillin": "R"})
        self.assertLess(works(out, "Ceftriaxone"), base - 10)
        lab = {r["antibiotic"]: r for r in out["ranked"] if r["source"] == "lab"}
        self.assertEqual(set(lab), {"Cefazolin", "Ampicillin"})
        self.assertEqual(lab["Cefazolin"]["percent_works"], 0.0)

    def test_intermediate_treated_as_resistant(self):
        out = self.m.predict_resistance(ECOLI, **CASE, known_results={"Cefazolin": "Intermediate"})
        self.assertEqual(works(out, "Cefazolin"), 0.0)

    def test_intrinsic_resistance(self):
        r = {x["antibiotic"]: x for x in self.m.predict_resistance("Klebsiella pneumoniae", "urine")["ranked"]}["Ampicillin"]
        self.assertEqual(r["source"], "intrinsic")
        self.assertLess(r["percent_works"], 1.5)

    def test_mrsa_flag_rule(self):
        out = self.m.predict_resistance("Staphylococcus aureus", "blood", "inpatient", 60, flags={"mrsa": 1})
        ox = {r["antibiotic"]: r for r in out["ranked"]}["Oxacillin"]
        self.assertEqual(ox["source"], "rule")
        self.assertLess(ox["percent_works"], 5)

    def test_urine_only_antibiotics_hidden_for_blood(self):
        names = {r["antibiotic"] for r in self.m.predict_resistance(ECOLI, "blood", "inpatient", 60)["ranked"]}
        self.assertNotIn("Nitrofurantoin", names)
        self.assertIn("Nitrofurantoin", {r["antibiotic"] for r in self.m.predict_resistance(ECOLI, **CASE)["ranked"]})

    def test_recommendation_prefers_narrow_spectrum(self):
        out = self.m.predict_resistance(ECOLI, "urine", "outpatient", 35)
        self.assertEqual(out["recommended"][0]["aware"], "Access")
        self.assertGreaterEqual(out["recommended"][0]["percent_works"], 80)

    def test_deterministic(self):
        a = self.m.predict_resistance(ECOLI, **CASE, history=CIPRO_HISTORY)
        self.assertEqual(a, self.m.predict_resistance(ECOLI, **CASE, history=CIPRO_HISTORY))

    def test_minimal_inputs(self):
        self.assertTrue(self.m.predict_resistance(ECOLI, "urine")["ranked"])
        self.assertTrue(self.m.empiric_coverage("blood")["ranked"])

    # ---- stage 1b: empiric coverage
    def test_empiric(self):
        out = self.m.empiric_coverage("blood", "icu", 65)
        self.assertEqual(len(out["top"]), 3)
        self.assertTrue(0 <= out["percent_other_organism"] <= 100)
        for r in out["ranked"]:
            self.assertTrue(0 <= r["percent_covers"] <= 100)

    # ---- helpers
    def test_normalize_drug(self):
        for raw, want in [("Ciprofloxacin Hcl", "ciprofloxacin"), ("Cipro", "ciprofloxacin"), ("Ciprofloxacin In", "ciprofloxacin"),
                          ("Bactrim DS", "sulfamethoxazole-trimethoprim"), ("Piperacillin-Tazobactam-Dextrs", "piperacillin-tazobactam"),
                          ("Nitrofurantoin Macrocrystal", "nitrofurantoin"), ("Keflex", "cephalexin")]:
            self.assertEqual(normalize_drug(raw), want, raw)

    def test_age_bin(self):
        self.assertEqual([age_bin(a) for a in (17, 18, 30, 64, 65, 89, 95)], [None, "18-24", "25-34", "55-64", "65-74", "85-89", "90+"])
        self.assertEqual(age_bin("65-74 years"), "65-74")
        self.assertEqual(age_bin("above 90"), "90+")
        self.assertIsNone(age_bin("Null"))

    def test_history_features(self):
        h = {"prior_results": [{"antibiotic": "Ciprofloxacin", "organism": ECOLI, "result": "R", "days_ago": 20},
                               {"antibiotic": "Cefazolin", "organism": "Proteus mirabilis", "result": "S", "days_ago": 20},
                               {"antibiotic": "Gentamicin", "organism": ECOLI, "result": "R", "days_ago": 0}],  # same day: ignored
             "nursing_home": True}
        f = set(history_features(h, ECOLI))
        self.assertTrue({"prevR_30d:Ciprofloxacin", "prevR_ever:Ciprofloxacin", "prevRsame_365d:Ciprofloxacin", "nursing_home"} <= f)
        self.assertFalse(any("Gentamicin" in x for x in f))
        self.assertFalse(any("Cefazolin" in x for x in f))   # prior S only counts for the same organism

    # ---- CLI
    def test_cli(self):
        script = os.path.join(HERE, "amr_predict.py")
        r = subprocess.run([sys.executable, script, "--organism", ECOLI, "--specimen", "urine", "--setting", "emergency",
                            "--age", "78", "--prior-r", "Ciprofloxacin:30", "--known", "Cefazolin=R", "--json"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(json.loads(r.stdout)["top"]), 3)
        r = subprocess.run([sys.executable, script, "--specimen", "blood", "--setting", "icu"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Likely organisms", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
