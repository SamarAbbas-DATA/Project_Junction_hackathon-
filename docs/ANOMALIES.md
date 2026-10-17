# Anomaly detection and testing

Start or restart the existing application with `npm.cmd run dev`. No new packages,
Python training, vector database or separate anomaly server are required. On startup,
the backend creates the anomaly tables in the existing PostgreSQL hub, queues an
initial evaluation and starts a worker. The hospital source databases remain native
SQLite databases; their changes still travel through the FHIR intake.

## What is detected

| Signal | Initial settings | Interpretation |
| --- | --- | --- |
| Resistance increase | Latest 28 sample-days versus the preceding 84 days; at least 30 tested first isolates in each period; increase of at least 15 percentage points; adjusted p-value at most 0.05 | A change in a matched sampled cohort worth reviewing |
| Resistant-organism cluster | Latest 7 sample-days versus the preceding 84 days; at least 3 flagged current patients, at least 30 baseline patients, flag-proportion increase of at least 10 percentage points and adjusted p-value at most 0.05 | An unusual MRSA/ESBL/VRE/CPE flag pattern; not confirmed transmission or an outbreak |
| Data/integration | Rejected FHIR messages in the past 24 receipt-hours; unavailable sources; missing patient/ward links, orphaned isolates/AST or mismatched final isolate counts after a 120-second arrival grace | A delivery, completeness or integrity issue; not a diagnosis |

These are configurable **research/demo settings, not TYKS clinical policy**. Edit
`apps/api/resources/anomalies/rules.json` and restart the API to change settings.
Bump the human-readable rule version when changing the configuration. Each finding
also saves the full rule settings with its evidence, so the configuration used for
an older finding remains inspectable after a change.

Comparisons are specific to recorded ward, organism and specimen; resistance also
requires the same antibiotic and interpretation-edition label. They use final,
positive-culture isolates and reported S/R. The first isolate is selected before
joining AST results. A missing test is not counted as susceptible. Repeat records
do not increase the patient count, and patients in the current period are excluded
from that comparison's baseline. Flag clusters count any reported flag for each
distinct patient in the period. The baseline proportion is applied to the current
cohort size, rather than treating a larger number of cultures as an outbreak.

The statistical test is a one-sided Fisher exact test. Benjamini–Hochberg adjustment
covers all eligible resistance/flag comparisons **within each ward**, before filtering
on effect size. It is not a hospital-wide false-discovery guarantee. The UI shows
counts, percentages, Wilson 95% proportion intervals, adjusted p-value and the number
of eligible comparisons. Sampling changes, incomplete data and a research baseline
still limit interpretation. Low sample size or incompatible editions suppress a
comparison; no saved signal does not establish that a ward is anomaly-free.

Biological windows use the UTC sample date, not message arrival time. Importing
historical samples does not make them today's cases. Integration checks use receipt
and last-arrival timestamps. There is no clinical turnaround-time rule because a
reliable end-to-end laboratory workflow clock is not supplied by these records.

## Try the three scenarios in the app

1. Open **Anomalies → Test with synthetic scenarios**. Finnish mode uses
   **Poikkeamat → Testaa synteettisillä skenaarioilla**.
2. Under **Resistance increase**, click **Load scenario**. It creates 100 labelled
   test patients in **ANOM-R** through the existing source APIs: 6 resistant out of
   60 baseline patients, and 30 resistant out of 40 current patients. Their original
   sample dates are retained. After FHIR delivery and the background evaluation, a
   resistance signal appears. The worker checks queued work every second; source
   backlogs can add time.
3. Select that signal. Inspect the 10% versus 75% comparison, date ranges, sample
   counts, interpretation edition and supporting records. Patient/culture buttons
   open the existing source-record detail view. Hover over an ID to copy it.
4. Add a note and click **Acknowledge**. To dismiss instead, supply a note and click
   **Dismiss with note**. Review history records the decision; neither action changes
   laboratory results. Use **Alert status** to find dismissed/resolved signals.
5. Click **Replay same message** in the resistance scenario. It resends the exact
   persisted FHIR bundle. The result should report a duplicate: no extra patient,
   AST result or alert is created.
6. Click **Correct test results**. The test service changes only its owned current
   resistant AST rows to S, using their expected source versions. The normal FHIR
   flow causes the signal to resolve. Set **Alert status → All statuses** or
   **Resolved** to find it again. Evidence remains a labelled snapshot from the last
   matching evaluation, while the linked source records show their current values.
7. Click **Restore test signal** to return those owned test results to R. The same
   alert ID starts another episode after the previous episode has resolved. Review
   history remains. Wait for resolution before restoring if you want to demonstrate
   separate episodes.
8. Load **Resistant-organism cluster**. In **ANOM-C**, 60 baseline patients have no
   MRSA flag, while 5 of 10 current patients do. This should create a cluster signal.
   **Correct test results** clears those owned test flags and resolves the signal.
9. Load **Rejected FHIR messages**. One deliberately malformed message is saved in
   the integration inbox and rejected. A data/integration signal appears; no patient
   is created by that message. Replay reuses the same rejected inbox record. You can
   dismiss the alert after reviewing it; the original message remains available for
   audit and its rejection signal otherwise expires after the configured window.
10. Switch between **English** and **Suomi**, or restart the app. Alert evidence and
    review history are stored in PostgreSQL and survive browser refresh and worker
    restart. The normal 30-second synthetic patient feed remains separate.

Scenarios are loaded only when requested. Their wards, home-area labels and
`TEST-AMP`/`ANOMALY-TEST-1` references identify them as synthetic. Seven-digit test
patient IDs are generated without overwriting existing records. Repeating a loaded
scenario reuses its source records. External changes to test records are protected
by expected versions; a conflicting test correction stops instead of overwriting
them. Test patients are not part of the cyclic inbox feed and are not cleared by
that feed's restart/reset behavior.

Local test controls are disabled in `NODE_ENV=production`. Set
`ANOMALY_DEMO_ENABLED=false` to hide and disable injection elsewhere. The detection
and review APIs remain available independently of the test controls.

## Test the chatbot

After loading the resistance scenario, open either chat view and use **Ward code**
with **ANOM-R**, then ask:

> Explain the saved resistance signal, its current and baseline counts, and its limitations.

Alternatively copy a current test patient or culture ID from the supporting records,
select that chat scope and ask which saved signals relate to it. Expand the source
panel and **Saved anomaly signals** under the answer to inspect the detector context.
Qwen receives saved findings, evidence periods, counts, rule version, last evaluation
time and review status. It does not detect anomalies or change alert status. Patient
linkage means a record contributed to the cohort; it is not proof that the patient
acquired an infection in that ward. Unknown IDs receive no unrelated anomaly context.

## Implementation and APIs

- `anomaly-statistics.ts`: exact test, adjustment and proportion intervals.
- `anomaly-detector.ts`: final-result cohorts, integrity checks and resumable worker.
- `anomaly-store.ts`: queue, alerts, evidence links, optimistic reviews and audit.
- `anomaly-api.ts`: filters, summary, detail and review endpoints.
- `anomaly-demo.ts`: owned synthetic source scenarios, corrections and exact replay.
- `Anomalies.tsx`: English/Finnish workspace, charts, record links and test controls.

The FHIR acceptance transaction saves detection jobs alongside accepted changes.
The worker processes them after commit, serializing workers using a PostgreSQL
advisory lock. Duplicate/stale resources do not create work. Scope includes previous
and new wards for corrections. Quality grace timestamps reflect accepted arrivals,
not an old source timestamp. Pending generations survive restart and failed jobs
retry with their error visible in the UI. Disconnected sources pause biological
comparisons; a daily refresh handles sample-window expiry, and periodic quality
checks handle delayed parent records and outages. SSE `anomalies.updated` refreshes
anomaly views without invalidating unrelated clinical tables.

Tables: `anomaly_jobs`, `anomaly_subject_seen`, `anomaly_isolate_seen`,
`anomaly_alerts`, `anomaly_links`, `anomaly_review_history`, `anomaly_evaluations`
and `anomaly_demo_runs`. Statistical alert evidence and data-quality records are
snapshots. Reviews retain their episode and actor label; the local app does not
provide authenticated clinician identity.

Endpoints:

- `GET /api/anomalies`: filters `status`, `type`, `ward`, `q`, `from`, `to`, `limit`,
  `offset`. `from`/`to` filter detection dates, not the clinical sample window.
- `GET /api/anomalies/summary`: counts, source state, queued/error jobs, settings
  and last evaluation/coverage.
- `GET /api/anomalies/:id`: evidence, up to 100 supporting snapshots, total record
  count and review history. All linked IDs remain searchable beyond that display cap.
- `PATCH /api/anomalies/:id/review`: `status`, `expected_version`, optional `note`
  (required for dismissal). Resolution follows detector criteria automatically.
- `GET /api/anomalies/demo/status` and `POST /api/anomalies/demo/:kind`,
  `/:kind/correct`, `/:kind/replay`, where `kind` is `resistance`, `cluster` or
  `integration` (correction applies to the two biological tests).

Run `npm.cmd test` and `npm.cmd run build` for automated checks. Backend tests use
their own SQLite directories, source ports 19101–19103 and a uniquely named
temporary PostgreSQL database; they do not add scenario patients to the development
databases. Tests cover expected signals, small/preliminary/missing/incompatible
cohorts, repeat patients, historical arrivals, review races, corrections, duplicate
delivery, restart/concurrency, rejected messages, delayed references and source
outages. Frontend tests cover filters, source links, review/version behavior,
scenario correction/replay, language controls, chatbot context and SSE invalidation.
