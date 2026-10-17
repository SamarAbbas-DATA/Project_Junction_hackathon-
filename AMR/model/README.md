# AMR prediction model: trained on real hospital data

Predicts, **as percentages**, which antibiotics will work for a patient's infection before the lab's final result is back.

- Trained on **130,051 real bacterial isolates** from Stanford hospitals, covering 2008–2024. The source is the [ARMD dataset](https://datadryad.org/dataset/doi:10.5061/dryad.jq2bvq8kp) (CC0).
- It **uses the patient's history**: earlier lab results, recent antibiotics, earlier organisms, and nursing home visits.

| Stage | You give it | You get back |
|---|---|---|
| 1. Sample taken | specimen, setting, age (+ history) | likely organism with % (top-k) and % chance each antibiotic covers it → `predict_organism()`, `empiric_coverage()` |
| 2. Organism identified | + organism | % chance each antibiotic works, the **top 3**, and a **recommended** top 3 → `predict_resistance()` |
| 3. Some results back | + results so far | updated % for the pending antibiotics → `predict_resistance(known_results=...)` |

**To use it you need two files and plain Python 3.8+, with nothing to install:** `amr_predict.py` and `amr_model.json` (2.7 MB). Loading takes about 25 ms, a prediction about 0.1 ms.

```
amr_model_real/
├── amr_predict.py          ← inference (stdlib only)          ┐ copy these two
├── amr_model.json          ← trained parameters (2.7 MB)       ┘
├── test_amr_predict.py     ← 24 tests (stdlib only)
├── prepare_data.py         ← raw ARMD (1.1 GB) → ../data_real/isolates.csv.gz (7.6 MB)
├── train.ipynb             ← cleaning checks, 6 approaches compared, export (outputs saved)
└── requirements-train.txt  ← only for re-training
```

---

## Use it

```python
from amr_predict import AMRModel
m = AMRModel.load("amr_model.json")

history = {   # optional, but it is where most of the accuracy comes from
    "prior_results":     [{"antibiotic": "Ciprofloxacin", "organism": "Escherichia coli", "result": "R", "days_ago": 30}],
    "prior_antibiotics": [{"drug": "ciprofloxacin", "antibiotic_class": "Fluoroquinolone", "days_ago": 25}],
    "prior_organisms":   [{"organism": "Escherichia coli", "days_ago": 30}],
    "nursing_home": False,
}

# Stage 1: sample taken
m.predict_organism("urine", setting="emergency", age=78, history=history, top_k=3)
# [{"organism": "Escherichia coli", "probability": 0.848, "percent": 84.8}, ...]
m.empiric_coverage("urine", setting="emergency", age=78, history=history)
# {"likely_organisms": [...], "percent_other_organism": ...,
#  "ranked": [{"antibiotic": "Meropenem", "aware": "Watch", "percent_covers": 93.3}, ...],
#  "top": [...3...], "recommended": [...3...]}

# Stages 2-3: organism identified, some results back
out = m.predict_resistance("Escherichia coli", "urine", setting="emergency", age=78, history=history,
                           known_results={"Cefazolin": "R"}, top_k=3)
out["top"]          # 3 antibiotics most likely to work
out["recommended"]  # 3 narrowest-spectrum antibiotics with >= 80% (WHO AWaRe: Access before Watch before Reserve)
out["ranked"]       # every antibiotic:
# {"antibiotic": "Ciprofloxacin", "class": "Fluoroquinolones", "aware": "Watch",
#  "percent_works": 4.0, "p_resistant": 0.96, "source": "model", "n_train": 61358}
```

### Inputs

| Input | Values |
|---|---|
| `specimen` | `urine`, `blood`, `respiratory` |
| `setting` | `outpatient`, `emergency`, `inpatient`, `icu` |
| `age` | years, adults only (≥ 18) |
| `gender` | `"0"`/`"1"`. ARMD anonymised gender as 0/1 without saying which is which, so you can leave it out. |
| `organism` | One of 19, case-insensitive: *Escherichia coli*, *Klebsiella pneumoniae / oxytoca / aerogenes*, *Proteus mirabilis*, *Pseudomonas aeruginosa*, *Enterococcus (faecalis/spp.)*, *Enterococcus faecium*, *Staphylococcus aureus*, Coagulase-negative staphylococci, *Streptococcus agalactiae (group B)*, *Streptococcus pneumoniae*, *Enterobacter cloacae complex*, *Citrobacter koseri*, *Citrobacter freundii complex*, *Serratia marcescens*, *Morganella morganii*, *Stenotrophomonas maltophilia*, *Achromobacter xylosoxidans*. The list is in `m.organisms`. |
| `known_results` | `{"Cefazolin": "R", "Ciprofloxacin": "S"}`. `I` (intermediate) counts as R. ARMD antibiotic names are in `m.antibiotics`. |
| `flags` | lab tags in the organism name: `mrsa`, `vre`, `cre` (carbapenem-resistant), `esbl`, `mucoid`, `cf` |
| `history` | as in the example above; every part is optional |

**Important:** give the patient's **whole** prior history, susceptible results included. The model learned from complete records. For example, "prior *E. coli*, resistant to cipro" with no other results listed gets read as "the other antibiotics were not resistant".

### `source` field

| Value | Meaning |
|---|---|
| `model` | logistic regression prediction |
| `intrinsic` | the organism is naturally resistant (≥ 99% R), e.g. *Klebsiella* + ampicillin |
| `rule` | a lab flag implies resistance (learned from data), e.g. MRSA → oxacillin, cefazolin and penicillin; VRE → vancomycin |
| `lab` | result already known |

### Command line

```bash
python amr_predict.py --organism "Escherichia coli" --specimen urine --setting outpatient --age 45
python amr_predict.py --organism "Escherichia coli" --specimen urine --setting outpatient --age 45 --prior-r Ciprofloxacin:30 --prior-abx ciprofloxacin:25 --known Cefazolin=R
python amr_predict.py --specimen blood --setting icu --age 70          # no organism → stage 1 (empiric)
python amr_predict.py ... --json --top 5
```

### Demo UI

```bash
python demo/server.py          # then open http://127.0.0.1:8765   (standard library only)
```

- **Buttons along the top**:
  - **① Example patient** (78 years old, ED, urine, *E. coli*);
  - **② Same patient + history** (cipro-resistant *E. coli* 30 days ago, took cipro 25 days ago);
  - **③ Lab: Cefazolin R + Ceftriaxone R**.
- **Shortcuts:** `#step1`, `#step2` and `#step3` jump straight to each stage, e.g. `http://127.0.0.1:8765/#step3`.
- **Lab buttons:** clicking **S / R / pending** on any antibiotic re-scores all the others. The "▼ was X%" marker shows the change since the last update.
- **"why?"** shows the logistic-regression arithmetic: starting score + the weight of each true fact → total → %.
- `demo/server.py` is also a reference backend: four JSON endpoints, and the model is loaded once at startup.

### Test

```bash
python -m unittest -v test_amr_predict.py
python -S -m unittest -v test_amr_predict.py     # with site-packages disabled: proves nothing needs installing
```

The 24 tests cover:
- the percentages are valid and sorted;
- top-k and the recommendation;
- prior resistance and prior antibiotic use **lower** the chance an antibiotic works, and a prior susceptible result **raises** it;
- partial results update the predictions;
- intrinsic resistance and the MRSA rule;
- the urine-only filter;
- drug-name normalisation;
- age bins;
- history features, including the leakage guard;
- the CLI.

---

## What we found in real data (this is why the model works)

The table shows *E. coli* % resistant across all 130k isolates:

| | Ciprofloxacin | Ceftriaxone | TMP/SMX | Nitrofurantoin |
|---|---|---|---|---|
| All *E. coli* | 23% | 12% | 29% | 4% |
| Patient has **no history** | 15% | 8% | 24% | 3% |
| **Same drug resistant in last 90 days** | **85%** | **78%** | **82%** | **29%** |
| Same drug **susceptible** (same organism) in last year | 13% | 7% | 18% | 4% |
| **Took that antibiotic class** in last 90 days | **55%** | 20% | 49% | 7% |
| Nursing home | 43% | 25% | 29% | 6% |

So a patient's history changes the answer a lot. A single antibiogram number can't capture that.

## How it was built

### Data preparation (`prepare_data.py`)

**Organism names were normalised**:
- name variants were merged, e.g. `STAPH AUREUS {MRSA}` becomes *S. aureus* with the MRSA flag;
- `ZZZENTEROBACTER AEROGENES` becomes *K. aerogenes*;
- the 3 *Pseudomonas* variants were merged.

**Inclusion:**
- 19 organisms with ≥ 400 isolates are modelled; rarer ones become "Other";
- mycobacteria were dropped.

**Results**:
- Intermediate counts as R ("non-susceptible");
- Inconclusive, Synergism and Null results were dropped (5,905 rows);
- duplicate results take the worst case (23,541 merged).

**History**:
- prior resistance from ARMD's resistance file;
- prior R **and** S results from the patient's own earlier cultures in the cohort (that file only covers some antibiotics, e.g. not TMP/SMX or pip-tazo);
- prior antibiotics by class, plus the 30 most common drugs, with drug names normalised ("Cipro" / "Ciprofloxacin Hcl" become ciprofloxacin);
- prior organisms and nursing home visits.

**No leakage:** history only counts events ≥ 1 day before the culture. Earlier cultures only count if taken ≥ 3 days before, so their result would actually be available.

**Model**: one L2 logistic regression per (organism, antibiotic) pair, C = 0.03, 200 pairs in total.
- **Constant pairs:** 89 pairs with fewer than 20 R or 20 S use the historical rate.
- **Masking:** each training isolate appears 3× with a random share of its other results hidden. That lets one model handle stages 2 and 3.
- **Pruning:** rare features (< 10 occurrences) and tiny weights are dropped, which keeps the file at 2.7 MB.
- **Organism:** a multinomial logistic regression over 20 classes.

**Validation** splits by **time**:
- train on 2008–2019;
- validate on 2020–2021, used to tune C and for LightGBM early stopping;
- **test on 2022–2024**: 21,627 isolates and 322,704 results the models never saw.

The exported model is refit on all years.

## Results on 2022–2024

The main metric is **AUC within pair**: how well the model tells resistant from susceptible *for the same organism and antibiotic*. 0.5 is a coin flip and 1.0 is perfect. An antibiogram is 0.5 by definition, because it gives every patient the same number.

| Approach | Organism known, no results | Half the results known | All but one known |
|---|---|---|---|
| A. Antibiogram (what hospitals use) | 0.500 | 0.500 | 0.500 |
| B. Antibiogram by specimen × in/outpatient | 0.549 | 0.549 | 0.549 |
| C. Logistic regression, context only (ward, age…) | 0.595 | – | – |
| D. LR + patient history | 0.748 | – | – |
| **E. LR + history + partial results (exported)** | **0.739** | **0.867** | **0.905** |
| F. LightGBM (same features) | 0.763 | 0.892 | 0.923 |

Brier score, lower is better: antibiogram 0.096 → exported model 0.076 / 0.053 / 0.040 across the three stages.

**Patients with history vs without** (organism known, no results):

| Approach | With history | Without history |
|---|---|---|
| Antibiogram | 0.50 | 0.50 |
| Exported model | **0.76** | 0.60 |

**Calibration:** the percentages are honest. When the model says 2–5% resistant, 3% are; 20–30% → 21%; 50–70% → 56%; 90%+ → 98%.

**Stage 1 (sample just taken):** the organism's first guess is right 61% of the time vs 58% for "most common for this specimen"; the right organism is in the top 3 77% of the time. With history the shift is large: for an ED urine sample, *E. coli* goes from 57% to 85% when the patient had a prior *E. coli*.

**If the doctor follows the pick** (organism known, no results): the top-1 antibiotic worked **99.4%** of the time. The stewardship pick worked 98.7% and was an Access-group drug in **98.1%** of cases, vs 96.8% when the same rule runs on the antibiogram. So the model allows narrower antibiotics more often without losing safety.

### Why the exported model is logistic regression, not LightGBM

LightGBM is better by about 0.02 AUC. The rule in the notebook was to switch only for a gain > 0.02 in every stage, and it gained 0.024, 0.024 and 0.018, so it didn't qualify.

The logistic regression also:
- needs nothing installed;
- is 2.7 MB of readable weights, where trees would be much larger and need a tree runtime;
- matches sklearn exactly (difference 1.8e-7).

If the extra 0.02 matters later, the notebook already trains LightGBM; exporting it would be the next step.

## Limitations (read before presenting)

- **This is US data** (Stanford, 2008–2024). Resistance rates differ by country and hospital. Before real use, re-train on the local hospital's own data by running the same two scripts.
- **Before any history or results, gains are modest** (0.60 vs 0.50). The big gains come from patient history and partial results.
- **`recommended` is a simple rule.** It picks the narrowest WHO AWaRe group with ≥ 80%. It does **not** know route (oral vs IV), dosing, allergies, pregnancy, kidney function, or whether a drug reaches the infection site (e.g. tigecycline in urine). For an outpatient UTI it may suggest amikacin (IV-only). Present it as decision support for a clinician, never as an order.
- **Empiric coverage** counts an antibiotic as "not covering" an organism the lab doesn't test it for, e.g. meropenem vs *Staph*. "Other" rare organisms (about 15% of blood cultures) are left out and reported separately as `percent_other_organism`.
- **The model uses ARMD organism and antibiotic names.** The hackathon dashboard data (Finnish, synthetic) uses different codes, so connecting them needs a small mapping table, e.g. `CIP` → `Ciprofloxacin`, `TMP` → `Trimethoprim/Sulfamethoxazole` (approximate).
- ARMD is de-identified: dates are jittered, ages are binned, and gender is an anonymous 0/1.

## Re-train

1. In your browser, download these files from [Dryad](https://datadryad.org/dataset/doi:10.5061/dryad.jq2bvq8kp) into `../new model/` (about 1.1 GB):
   `microbiology_cultures_cohort.csv`, `_demographics.csv`, `_ward_info.csv`, `_microbial_resistance.csv`, `_antibiotic_class_exposure.csv`, `_nursing_home_visits.csv`, `implied_susceptibility_rules.csv`, `README.md`.
2. Then run:

```bash
python -m venv .venv && .venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements-train.txt
python prepare_data.py                                    # ~1 min  → ../data_real/isolates.csv.gz
jupyter nbconvert --to notebook --execute --inplace train.ipynb   # ~30 min → amr_model.json
python -m unittest test_amr_predict.py
```

Data citation: Nateghi Haredasht F. et al., *Antibiotic Resistance Microbiology Dataset (ARMD)*, Stanford Healthcare, 2025. [arXiv:2503.07664](https://doi.org/10.48550/arXiv.2503.07664)
