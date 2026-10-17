# TYKS × MYLAB - Clinical workspace

A hospital data consolidation application for the TYKS × MYLAB JunctionX case. Independent patient/ward, microbiology and formulary sources send FHIR R4 messages into a PostgreSQL hub. The React dashboard follows patient samples and results, calculates antibiograms, uses the supplied AMR prediction model, detects surveillance signals and provides a local AI assistant in English and Finnish.

All supplied patient and microbiology records are synthetic. Source writes and corrections produce FHIR R4 messages. A paced synthetic feed demonstrates new registrations and staged laboratory reporting through that same path.

## Getting started

**New computer? Follow [setup.md](setup.md)** for prerequisites, the separate baseline
dataset, PostgreSQL, Python, Ollama, startup checks, public demo setup and troubleshooting.

Requirements: Node.js **24+**, PostgreSQL binaries, Python **3.8+** for prediction,
and Ollama with the configured model for the AI assistant. PostgreSQL 18 is used
in development. SQLite is included with Node.js; no separate SQLite service,
model training or vector database is required.

From the repository root, after supplying the dataset and local configuration:

```powershell
npm.cmd ci
ollama pull qwen3.5:4b
npm.cmd run dev
```

Open **http://127.0.0.1:5173/** and wait for initial synchronization. First launch
imports the original six CSVs, creates the private SQLite sources and PostgreSQL
hub, and loads the baseline through FHIR adapters. Later launches retain the
baseline and catch up using saved cursors. The dataset and generated databases
are not included in Git; see [dataset setup](setup.md#3-supply-the-baseline-dataset-and-database-configuration).

The default hub cluster is under `data/hub-postgres`, on `127.0.0.1:55432`,
with database `hub_db` and user `amr_hub`. Use `POSTGRES_BIN` for a custom
binaries directory, or `DATABASE_URL` for an empty dedicated database. Local
settings and credentials belong in an ignored `.env` copied from `.env.example`.

For a temporary judging demo, keep the backend and Ollama running, run
`npm.cmd run demo:web` in another terminal for the bundled frontend on **5174**,
then `npm.cmd run demo:tunnel` after configuring an ngrok account. This uses
[the supplied host-header policy](docs/ngrok-demo.yml); visitors can use the same
API and local AI through the public link. Full instructions are in
[public demo setup](setup.md#8-share-a-temporary-public-demo-with-ngrok).

Use synthetic data for public demos: the current app includes record-writing
controls and does not provide authenticated clinical-user access. A real clinical
deployment needs its own authentication, authorization and approved infrastructure.

## Sources and tables

| Source | Port | Database | Tables |
|---|---|---|---|
| ADT | 8001 | `data/adt_db.sqlite` | `patients`, `wards`, `ward_stays` |
| Microbiology LIS | 8002 | `data/lis_db.sqlite` | `cultures`, `specimen_types`, `isolates`, `ast_results` |
| Pharmacy/reference | 8003 | `data/formulary_db.sqlite` | `antibiotics`, `guidelines` |
| AMR Hub | 8000 | PostgreSQL `hub_db` | source schemas; dimensions/fact views; cursors, events, chat audit and proposals |

Source snapshots retain all 10,000 patients, 46,792 cultures, 24,571 isolates and 172,381 AST results, including cultures with no isolates. The ADT seed has 19,666 distinct ward-stay combinations derived from cultures, explicitly marked `origin=derived_from_cultures`. They are not verified admissions or transfer sequences. Sample ward is not necessarily current patient location.

Imported cultures receive `status=final` as an application import convention; original workflow timestamps/statuses were not supplied. New cultures can be `registered` or `preliminary` with a null result. Unknown never becomes negative. Imported creation/update timestamps describe the import, not historical clinical release times. Blood quantities and unknown guideline effective dates stay null.

Each source table has `created_at`, `updated_at`, and `record_version`. Source SQLite tables use primary keys, relevant local foreign keys, reference validation through the other source APIs, and transactional outbox triggers. SQL triggers capture insert/update/delete events, including direct database edits. API corrections maintain versions and metadata; use APIs for normal writes rather than editing SQL manually.

The hub stores source copies in `adt.*`, `lis.*`, `formulary.*`. `dim_patient`, `dim_ward`, `dim_antibiotic`, `dim_organism`, `fact_culture`, `fact_isolate`, `fact_ast`, and `patient_timeline` are views, so source corrections are reflected without maintaining another duplicate dataset. Left joins preserve records with unresolved external references; overview exposes unresolved culture count.

## APIs

Interactive API docs: `http://127.0.0.1:8000/docs`, and `/docs` on each source port.

Each source table has:

```text
GET   /{table}?q=&limit=25&offset=0
GET   /{table}/{key}
POST  /{table}
PATCH /{table}/{key}       If-Match: current record_version
GET   /fhir/changes?after=0&limit=100
GET   /schema
```

Specific filters use column names, e.g. `/cultures?patient_id=P005095&ward=ED&status=final&from=2026-01-01&to=2026-09-27`. `GET /cultures/{id}` includes isolates and AST results. ADT also has `/patients/{id}/stays`. AST aliases include `/ast` and `/ast-results`; its key is `isolate_id~antibiotic_code`.

Create requests accept an `Idempotency-Key` header. Reusing it with the same payload returns the original record; different payloads return 409. Corrections require `If-Match` and return 409 on an outdated version. Primary keys cannot be changed. Adding an isolate updates its culture's isolate count and preliminary status in the same transaction. The system does not infer that all antibiotic testing is complete from one AST result.

Example append to the patient source:

```powershell
$patientBody = @{patient_id='P100001'; sex='F'; birth_year=1990; home_area='North'} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8001/patients' -ContentType 'application/json' -Headers @{'Idempotency-Key'='register-P100001'} -Body $patientBody
```

The frontend calls `/api/source/{source}/{table}` on the hub. Reads now come from the hub's clean PostgreSQL tables; management writes are forwarded to the owning hospital system and return through its FHIR sender. Source table CRUD remains a private, loopback administration interface; it is not the integration contract. The previous table snapshot and raw change APIs have been removed. Hub query routes include `/api/overview`, `/api/patients`, `/api/patients/{id}/history`, `/api/antibiogram`, `/api/activity`, `/api/sources`, and `/api/catalog`. `/api/sync` requests FHIR catch-up and `/api/events` sends scoped SSE notifications. Activity and health endpoints remain available for backend operations; their screen and navigation entry have been removed.

Each source sender posts a FHIR R4 message Bundle to `POST /api/intake/fhir/{source}`. An API write wakes its sender immediately; a 250 ms local check also detects direct SQL changes. The hub's two-second catch-up reads persisted FHIR messages through `/fhir/changes`, using a sequence cursor rather than timestamps so equal timestamps and deletions are not missed. Both paths use the same saved inbox, source-scoped message IDs and resource-version checks. See [the hospital integration design](docs/hospital-integration.md) for mappings, recovery, the sample document Bundle and the HL7 v2 extension boundary.

## Interface

The overview uses a light canvas, dark readable text, black active navigation, blue actions and dot-matrix charts. Counts and chart values come from the APIs. Motion for React provides navigation transitions, entry animations, count interpolation and animated bars, with reduced-motion support.

The sidebar contains Overview, Patients, Laboratory, Antibiogram, AMR predictor, Anomalies and AI assistant. Laboratory provides source/table browsing and add/correction forms; overview shortcuts open the relevant laboratory table. Source explorer and Reference library are no longer separate tabs. Patients is a dedicated workbench with consolidated summaries, search/sample filters and an expandable sample -> isolate -> antibiotic-result timeline. Patients without samples remain visible. Both record views initially show the newest additions; their order selectors also offer ID/sample-date order. Source headings omit infrastructure port numbers.

Patient, culture, isolate and ward identifiers have a copy icon that appears on hover or keyboard focus (always visible on touch screens). Clicking copies only the identifier and shows a short checkmark confirmation, without opening a record or expanding a sample. The controls appear in the patient directory/timeline, source and laboratory tables, predictor source snapshots and the assistant's source context and recognized IDs in answers. Clipboard failure is reported explicitly; ordinary text selection remains available.

The patient directory API supports `q`, `sex`, `has_samples=yes|no`, `limit` and `offset`. History includes complete linked culture/isolate/AST records and explicitly labelled ward-stay references. Weekly overview graphics use distinct sampled patients, culture counts and AST counts for each week; the patient total is the registered directory count across the complete dataset.

The patient filter's shared sliding highlight adapts Watermelon UI's Tabs interaction. See `THIRD_PARTY_NOTICES.md` for attribution. The main composition is in `apps/web/src/components/Dashboard.tsx`, patient flows in `Patients.tsx`, laboratory browsing in `App.tsx`, anomaly review in `Anomalies.tsx`, and motion primitives in `components/ui/motion.tsx`. Shared styling is in `design.css` and `readability.css`, with form/table primitives in `styles.css`.

## Excel exports and synthetic CSV imports

`output/data` contains nine separate source-table Excel workbooks and `synthetic_hospital_batch.xlsx`. Matching real UTF-8 CSV snapshots are under `output/data/source_tables/{source}`. XLSX is an Excel format, not CSV; the CSV copies remain suitable for data interchange. `ast_results` is the source table corresponding to the original `susceptibility.csv`. The existing `cleaned_microbiology.csv` is retained alongside them: its grain is one antibiotic test, so it does not include patients or cultures with no susceptibility tests.

The source exports preserve database columns and metadata. They include the complete patient directory and pending/no-isolate records, rather than reconstructing these from the flattened report. Readme tabs explain origins and join keys; sample-derived ward stays retain their `origin` value.

```powershell
# Refresh all source CSV/Excel exports and the synthetic Excel review copy.
npm.cmd run data:export

# Generate another linked batch of 50 patients, CSVs and one import ZIP.
npm.cmd run demo:generate -- --patients 50
npm.cmd run demo:excel

# Generate and queue a fresh batch for automatic import while the app runs.
npm.cmd run demo:generate -- --patients 20 --inbox

# Or import a ZIP immediately; source APIs must be running.
npm.cmd run demo:import -- output/data/synthetic_hospital_batch.zip
```

The supplied synthetic batch has 50 new patients, 3 new wards, 33 ward stays, 50 cultures, 35 isolates, 82 antibiotic tests, 3 fictional antibiotics and a test-only guideline. Three specimen codes match the source catalogue. It includes patients without samples, registered samples awaiting results, negative cultures, repeat samples and multiple-isolate cultures. Sample dates are based on 2026-10-17; future batches default to the current date in Europe/Kyiv, or accept `--date YYYY-MM-DD`. Fictional drug names and S/R results are demonstration data, not clinical recommendations.

The backend watches `output/data/inbox` every two seconds after startup. A ZIP must contain `manifest.json` and the nine CSV files at its root, with the exact source-field column names. The hospital feed registers **one new patient every 30 seconds** by default. Reference catalogues are prepared first, then patients arrive with pending cultures. Organisms appear one tick later; S/R results and supplied final report states follow on the next tick. Cultures supplied as pending stay pending. Set `SYNTHETIC_IMPORT_GROUP_SIZE=2` for pairs and `SYNTHETIC_IMPORT_INTERVAL_MS=30000` for the interval. Restart to apply the current interval to both new and unfinished batches; unfinished batches keep their original group boundaries.

Every generated registration and result is written to its hospital source, with reference validation and idempotency keys. That source sends FHIR changes immediately to the hub; SSE updates affected open views. The 30-second interval governs new arrivals, not delivery latency. The importer never writes the hub's clean tables. Sample dates remain the dates in the file. A 50-patient batch takes about 26 minutes including its final laboratory stages, plus source/API time. Queue another batch to continue arrivals during the same run.

Progress and the next tick are saved in `data/demo-imports`. An unfinished feed resumes on restart. **When every ZIP currently in the inbox has completed, the next startup backs up the sources, removes only patients and linked clinical rows owned by those generated batches, resets their receipts and starts their paced feed again.** It preserves the original supplied dataset and shared catalogues; an added manual clinical record protects its generated patient's entire graph. IDs or ID ranges alone never authorize deletion. Backups and a crash-recovery plan are under `data/demo-replays`. Set `SYNTHETIC_REPLAY_ON_RESTART=false` to retain completed batches permanently. Completed batches are skipped during the same run. An unavailable source retries after 30 seconds. Manual `npm.cmd run demo:import -- file.zip` remains the immediate-import maintenance path.

Generated patients use seven-digit hospital-style identifiers, starting at `1018112`. The generator reserves the next available range in a separate SQLite counter, also checking patient IDs already in ADT, so separately generated/queued batches do not reuse IDs. Culture accessions look like `MB26101811501`, isolates add a position such as `MB26101811501-1`, and ward-stay references retain explicit patient/ward/date links. The existing supplied `P...` and `C...` identifiers remain intact. Import package IDs use `BATCH-...` only in manifests and filenames; they are not patient IDs. These are still entirely synthetic records.

Generated batches reference `MED-02`, `ED-02` and `SURG-02` and reuse matching ward/reference rows across imports. Fictional compounds use `SYN-001`–`SYN-003`, clear synthetic names, and the `synthetic_reference` class; the clinical predictor excludes them. Existing differing data raises a conflict and is preserved. Successful imports have content-hash receipts in `data/demo-imports`; reading the same file again adds nothing. A partial import leaves its successful writes in place and retries resume using source records and idempotency keys. An unavailable source is retried by the inbox after 30 seconds. Set `SYNTHETIC_AUTO_IMPORT=false` to disable the watcher or `SYNTHETIC_INBOX` to change its folder. Closing the app stops inbox processing.

`npm.cmd run data:rename` upgrades previously generated `DEMO-...` rows and refreshes the existing synthetic CSV folder/import ZIPs. Source startup also detects and renames legacy source rows before opening APIs. The maintenance step backs up all source SQLite databases, the former import files and the before/after mapping under `data/migrations`; `data/synthetic-identifiers.json` keeps old-to-new aliases. Updates preserve relationships, results and counts. Delete/upsert outbox events remove former keys from the hub through normal synchronization, and historical audit events retain their original identifiers. Known legacy ZIPs are normalized with the same mapping if imported again. Run `npm.cmd run data:export` afterward to refresh CSV snapshots and the existing Excel review copies.

To edit a batch, use the CSVs in `output/data/synthetic_batch`, preserve headers and linked IDs, and ZIP them with `manifest.json` at the archive root. Excel workbooks are review copies; saving an edited worksheet as UTF-8 CSV and replacing that CSV in a ZIP is supported. Source snapshots include audit metadata and are not themselves import batches. Generate a fresh batch when you want additional entries; changing an already imported record requires the normal source correction workflow.

## Synchronization and reporting

The initial baseline is converted to FHIR from each private source with a captured event cursor. Source senders then push persisted FHIR messages as records change; a two-second catch-up loop recovers missed deliveries independently for each source. Intake stores the original message, checks source-scoped message/resource versions, updates clean tables and advances its cursor transactionally. Duplicate/stale resources do not create extra records. A failing source preserves recovery state; references arriving later resolve through the joined views. Rejected messages remain in the inbox with their reason. See [hospital integration](docs/hospital-integration.md) for acceptance and replay behavior.

SSE tells the frontend to refetch affected data; periodic queries and reconnection refreshes also reconcile state. Browser reads, including source-table browsing, come from the hub's clean tables. Management writes are sent to the owning source and return through FHIR. The hub can briefly lag a source while its message is being delivered. Event history starts after the initial load; source outboxes retain their own events.

The default antibiogram is the final 28 days ending at the latest sample date, clearly labelled as historical data. Calendar-year and custom-date views are also available. First-isolate selection is per patient, organism and specimen type within the selected reporting period and location scope. Selection happens before joining AST results. An antibiotic's denominator includes only selected isolates tested against that antibiotic. Percentages are suppressed below 30 tests. Pending cultures are excluded. The Anomalies tab separately evaluates resistance increases, resistant-organism clusters and data/integration issues using configurable research/demo rules. Its biological windows use the current UTC date and may suppress comparisons when recent matched counts are insufficient. The AMR predictor remains the supplied research model.

## AMR predictor

The **AMR predictor** sidebar tab adapts `demo/index.html` from the supplied `AMR/amr_model_real.zip`. It provides the same example-patient → history → partial-lab-result demonstration, patient/sample inputs, earlier S/R results, medication exposure, nursing-home input, likely-organism bars, coverage rankings, AWaRe recommendation lists, Pending/S/R controls, percentage changes and **Why?** explanations. Inputs update predictions after a short debounce; superseded responses are discarded. Outputs are research decision support, not prescriptions.

The archive's `amr_predict.py`, `amr_model.json`, demo server helpers, HTML reference, README and original tests are extracted into `AMR/model`. They remain unchanged; `source-manifest.json` records their SHA-256 hashes. No preparation script, training notebook or training requirements are used. `AMR/dashboard_bridge.py` imports the supplied demo's `MODEL`, context/history helpers and explanation function. The Node API invokes that adapter with JSON, so `npm.cmd run dev` runs everything through the existing dashboard API. There is no separate demo-server terminal or port to start.

Python **3.8+** is required; the supplied inference code uses the standard library only. Python is already installed on the development machine. If the backend cannot find it, set `PYTHON_BIN` to the full executable path in `.env`, then restart the backend. Prediction errors do not stop the source APIs or other dashboard tabs.

You can work with the supplied example scenarios, enter a manual case, or search for a directory patient and load a source sample. Reloading a patient explicitly refreshes that snapshot. Source loading maps exact antibiotic equivalents, retains both earlier S and R results, and excludes current, future and fewer-than-three-day-old samples from imported history. Historical clinical release timestamps are unavailable. Trimethoprim is not mapped to TMP/SMX, cefoxitin screening is not a therapeutic cefoxitin result, and fictional demo antibiotics are excluded. Enterococcus faecalis uses the model's broader Enterococcus group; CPE is not inferred to be CRE. Medication exposure and nursing-home visits are unavailable from the current sources and remain unsupplied until entered manually. Editing model inputs never changes source records.

The model accepts adult ages and urine, blood or respiratory samples. A loaded wound sample is shown as unsupported rather than silently converted. The page distinguishes observed lab results from model estimates and exposes the exact inputs and outputs. The supplied recommendation heuristic prioritizes AWaRe groups at 80% and falls back when necessary; it does not check allergies, renal function, dose or route, and is not locally validated.

Routes: `GET /api/predictor/meta`, `GET /api/predictor/patients/{id}?culture_id=...`, `POST /api/predictor/predict`, and `POST /api/predictor/explain`. The model parameter file stays on the backend. Backend tests compare API predictions exactly with the original Python CLI and check history mapping, validation and explanation consistency. Run the original model tests with:

```powershell
python -S -m unittest discover -s AMR/model -p test_amr_predict.py
```

## AI assistant and quick chat

The top-bar **Language / Kieli** selector switches between **English** and **Suomi** and remembers the choice in browser local storage. Navigation, forms, tables, predictor controls, dates/numbers and chat controls use the selected language without resetting the selected patient, inputs or conversation. Translations live in `apps/web/src/locales/fi.ts`; IDs, database/API keys, Latin organism names, drug names and raw JSON are preserved. Source-provided Finnish ward names are used when available. AMR Hub branding and the patient welcome headline have been removed; TYKS and MYLAB branding remains.

Chat requests send a validated `language: "en" | "fi"` preference to the API. Finnish mode instructs Ollama to answer in Finnish while preserving identifiers, results and citation URLs. Exact-ID searches work in either language; Finnish pending-result, resistance and guideline-topic terms are supported. The selected TYKS reference stays the separately attributed English summary requested for the LLM; the unchanged Finnish PDF remains available from its source links. Existing chat messages retain their original language when the interface language changes.

The **AI assistant** tab opens the clinical assistant; its **AMR assistant** launcher at the bottom right shares the same conversation. The popup remains available on all other tabs, supports minimize/expand, and keeps an answer streaming while you navigate. The interface uses the dashboard's blue actions and dark text, with patient, culture and ward accents and microbiology-specific suggested questions. Four starting choices select **Patient ID**, **Culture ID**, **Ward code** or **General question**. You can also type an exact ID directly in any question, including numeric IDs and `MB...` culture/isolate accessions. Follow-ups retain the resolved scope; a different ID changes it, and New review clears it. Conversation state stays in browser memory and resets on a page refresh.

The backend uses indexed, case-insensitive exact ID searches and fixed aggregate queries in the synchronized PostgreSQL hub. It never asks the LLM to generate SQL and has no embeddings, vector database or document RAG pipeline. Patient → culture → isolate → AST links supply source facts; isolate IDs are also recognized in question text. General questions receive hospital counts, specimen/organism summaries and relevant pending/antibiogram aggregates. Ward queries include sample-based counts, recent/pending samples, organisms and an antibiogram (last 28 days by default; an explicit year selects that calendar year). These are recorded sample locations, not a verified current census. Search is deliberately bounded: ask about one culture when you need detailed test results.

For up to two selected patient/culture samples per question, the backend runs the same supplied Python AMR inference code used by the predictor page, with mapped source inputs and earlier final S/R history. These outputs are labelled model estimates separately from observed results. Unsupported specimens/ages/organisms and unavailable inputs are reported explicitly. Medication exposure, allergies, dosing, renal function and other absent clinical facts are not invented. Predictor-page manual edits are exploratory inputs and are not saved to the patient's source record or chatbot context. Answers support clinical review; they do not issue prescriptions or write records.

The assistant also uses a separately attributed English reference from the supplied **Mikrobilääkesuositus**, dated **13 April 2026**. It was prepared by TYKS, Satasairaala and Vaasa Central Hospital infectious diseases physicians with other specialties. The bundled original PDF and English reference are in `apps/api/resources/guidelines`; a SHA-256 check ties the summary to this exact edition. The running app does not depend on the original Downloads path.

`tyks-guidelines.ts` selects from 30 English reference topics through fixed question keywords and known specimen/organism fields. Every question receives the core sampling, 48–72-hour review and S/I/R explanations; up to three relevant topics are added within a 7,600-character guide budget. No embeddings, vector database, training or runtime document search is added. Patient context and model predictions remain separate. The local assistant context window is 16,384 tokens to accommodate these sources.

This is a **selected English translation/summary**, with page references, rather than a full official translation. The guide has adult scope, assumes normal renal/hepatic function for its dose tables, and does not replace specialist consultation. Its page-8 susceptibility percentages are from **2021**, and its dosing interpretation table cites **EUCAST v11.0**; neither is presented as live data or a current breakpoint standard. Full dosing schedules, laboratory SOPs and numeric breakpoint tables are excluded from the English context. Missing symptoms, allergies, organ function, pregnancy, MICs and actual medication exposure remain unknown.

Both chat views show **TYKS reference** in the source-context panel, with expandable English guidance and links to the original Finnish pages. Answers are instructed to cite only selected source pages and keep recommendations distinct from measured S/R and research predictions. `GET /api/assistant/guidelines/tyks` exposes the English reference for review; `GET /api/assistant/guidelines/tyks/source.pdf` serves the unchanged original. These treatment-guidance resources are separate from `formulary.guidelines`, which contains AST interpretation-edition labels.

Expand the source panel under an answer to inspect matched IDs, sample counts, AMR inputs, source sync times and the complete structured context sent to Ollama. Every new question re-reads the hub. Prediction results are cached for at most 60 seconds using a hash of the complete patient history and model, so a changed source result invalidates the cache. The hub can lag source APIs by the existing polling interval, and offline source status is included. Long histories and ward lists are capped and labelled. Missing models or interrupted streams show errors while keeping the retrieved facts visible.

Ollama runs locally at `http://127.0.0.1:11434`; the default model is **qwen3.5:4b**. It was downloaded on the development machine for this implementation. On another machine:

```powershell
ollama pull qwen3.5:4b
# Start Ollama if it is not already running, then start the app as usual.
npm.cmd run dev
```

Set `OLLAMA_URL`, `OLLAMA_MODEL` and optionally `OLLAMA_TIMEOUT_MS` in `.env` to change the connection, installed model or generation timeout, then restart the backend. The interface hides language-model names and configuration; change the installed model through the server environment. The welcome line is "Ask me anything about the ARM", with the four question-context controls retained. Generation uses Ollama `/api/chat` with streaming and thinking disabled. Stop cancels the active request; unavailable models do not cause a fabricated LLM fallback. See the [Ollama chat API](https://docs.ollama.com/api/chat).

The search can also run without the LLM while the API is running:

```powershell
npm.cmd run assistant:search -- --patient P000001 --query "Summarize the samples and AMR estimates"
npm.cmd run assistant:search -- --culture C0000001 --query "Which results are reported?"
npm.cmd run assistant:search -- --ward ICU --query "Any pending samples?"
npm.cmd run assistant:search -- --query "How many samples are waiting?"
```

Routes: `GET /api/assistant/status`, `POST /api/assistant/search` (structured context), and `POST /api/assistant/chat` (newline-delimited JSON events: phase, context, token, done/error). Bodies accept `message`, `mode`, `identifier`, prior resolved `focus`, a bounded user/assistant `history`, and an optional installed `model`. Context is always assembled on the server. The assistant is read-only; adding/correcting records continues through the existing source forms. Legacy `/api/chat`, `/api/chat/tools`, `/api/chat/models` and review/commit proposal endpoints remain available for existing integrations.

## Development checks

The **Anomalies** tab detects resistance increases, resistant-organism clusters and
data/integration problems from accepted FHIR changes. It provides matched-period
counts, statistical evidence, supporting source records, English/Finnish controls
and persistent acknowledgement/dismissal history. Detection runs in the backend;
the chatbot receives relevant saved findings as context. See
[anomaly detection and testing](docs/ANOMALIES.md) for rules, architecture and the
built-in **Test with synthetic scenarios** controls. Thresholds are research/demo
settings, not TYKS clinical policy.

```powershell
npm.cmd run build
npm.cmd test
```

Backend tests create separate temporary SQLite sources on ports 18001–18003 and a uniquely named temporary PostgreSQL database. They verify snapshot/cursor consistency, append idempotency, optimistic corrections, validation, parent/child updates, first-isolate counts, minimum sample size, corrected AST results, event replay, restart recovery, source outage recovery, reviewable chatbot writes, and joined patient summaries/history. Test data does not enter the development databases. Frontend interaction tests use jsdom with mocked API data to check laboratory/patient navigation, filtering, expandable patient history, patient registration, assistant behavior and anomaly review. They do not substitute for visual browser checks.

FHIR tests also cover all nine mappings, exact persisted message retries, duplicate and stale-resource handling, rejected inbox messages, source push, downtime catch-up, corrections, the 30-second schedule and a protected demo-reset/replay cycle. Frontend tests cover streaming chat scroll control and scoped live refresh. Scrolling up pauses chat following; **Latest response** resumes it in both the popup and full-page assistant.

To view source SQLite files in VS Code, install `alexcvzz.vscode-sqlite` and run **SQLite: Open Database**. Inspect the Postgres hub with a PostgreSQL client using host `127.0.0.1`, port `55432`, database `hub_db`, user `amr_hub` for the default local configuration.
