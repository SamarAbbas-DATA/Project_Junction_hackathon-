# Setup guide

Use this guide to run the TYKS × MYLAB application on a new computer or prepare a
public judging demo. Commands below use Windows PowerShell and run from the
repository root unless stated otherwise.

The application uses synthetic hospital data. Its AMR predictions and anomaly
signals are research/demo decision support and require clinical interpretation.

## 1. Install the prerequisites

| Software | Required for | Installation / notes |
| --- | --- | --- |
| Git | Cloning the repository | [Git downloads](https://git-scm.com/downloads) |
| Node.js 24+ and npm | Backend, React frontend and built-in SQLite support | [Node.js downloads](https://nodejs.org/en/download) |
| PostgreSQL binaries | Consolidated hub database | [Windows installer](https://www.postgresql.org/download/windows/). PostgreSQL 18 is the version used in development. Include `initdb`, `pg_ctl` and `postgres`. |
| Python 3.8+ | The supplied AMR prediction model | [Python downloads](https://www.python.org/downloads/). Enable the Python executable on PATH, or set `PYTHON_BIN` below. No model training or additional Python packages are required. |
| Ollama | Local AI assistant | [Ollama for Windows](https://ollama.com/download/windows). Download the model in step 4. |
| ngrok account and agent | Optional public demo link | A free account is required. See step 8. |

SQLite is supplied by Node.js; no separate SQLite server is needed. Docker,
embeddings and a vector database are not required. Hardware must be able to run
the selected Ollama model; response speed depends on available memory and CPU/GPU.

Open a new terminal after installing tools and check:

```powershell
git --version
node --version
npm.cmd --version
python --version
ollama --version
```

If Windows opens the Microsoft Store instead of Python, install a working Python
interpreter and set its full executable path in `.env`. A working `py` launcher
can help find the interpreter, but `PYTHON_BIN` must point to the actual executable.

## 2. Clone and install the application

```powershell
git clone https://github.com/SamarAbbas-DATA/Project_Junction_hackathon-.git
cd Project_Junction_hackathon-
npm.cmd ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

`npm.cmd` avoids the PowerShell restriction that can block `npm.ps1`. On macOS or
Linux, use `npm` instead, make PostgreSQL binaries available on PATH and use an
ordinary non-root user for the local PostgreSQL cluster. Windows is the primary
development environment.

## 3. Supply the baseline dataset and database configuration

Obtain **`synthetic_microbiology_dataset.zip`** from the project team/case materials.
It is a separate input: the repository does not include the local `data/`,
`output/` or `tmp/` directories, existing databases, Excel exports or generated feeds.

Choose one dataset method:

- Extract the original six CSVs directly into `data/raw/` as shown below; or
- Add an **absolute** `DATASET_ZIP` path to `.env`; or
- Add an **absolute** `CSV_DIR` path containing those six CSVs to `.env`.

```text
data/raw/
  patients.csv
  wards.csv
  cultures.csv
  isolates.csv
  susceptibility.csv
  antibiotics.csv
```

Use the original CSVs, not a joined/cleaned report or the application's exported
tables. In particular, the importer expects `susceptibility.csv`; it maps that
input to the application's `ast_results` table.

Example `.env` entries; replace paths with locations on your computer:

```dotenv
DATASET_ZIP=C:/datasets/synthetic_microbiology_dataset.zip
# Alternative to the ZIP:
# CSV_DIR=C:/datasets/microbiology_csvs

# Optional if PostgreSQL is not automatically found:
# POSTGRES_BIN=C:/Program Files/PostgreSQL/18/bin

# Optional if the Python command on PATH is not a working interpreter:
# PYTHON_BIN=C:/Users/your-name/AppData/Local/Programs/Python/Python313/python.exe
```

On Windows the app detects PostgreSQL under `C:/Program Files/PostgreSQL/<version>/bin`.
By default it creates its own cluster under `data/hub-postgres` on
`127.0.0.1:55432`, with database `hub_db` and user `amr_hub`. It creates three local
source SQLite databases automatically. You do not need to create their schemas.

To use an existing PostgreSQL server instead, set `DATABASE_URL` in `.env` to an
**empty, dedicated application database**. The application creates and manages
its own schemas and hub tables there. Keep passwords in your local `.env` file.
Backend integration tests also require permission to create/drop their isolated
test databases; the default local cluster supports this.

The importer checks `CSV_DIR`, `data/raw` and the legacy
`tmp/microbiology_merge/source` location before using the configured ZIP. Its
fallback ZIP location is the repository's parent directory. Explicit dataset
paths are preferable on a new computer. Seed import runs on first startup;
changing a CSV later does not automatically reseed existing databases.

## 4. Start the local AI model

Install the model used by this app:

```powershell
ollama pull qwen3.5:4b
ollama list
```

Ollama normally runs in the background on Windows. If it is not running, start it
in a separate terminal and leave that terminal open:

```powershell
ollama serve
```

An "address already in use" error on `127.0.0.1:11434` usually means an Ollama
instance is already running. Check it instead of starting another instance:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

The defaults in `.env.example` are:

```dotenv
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b
OLLAMA_TIMEOUT_MS=180000
```

Restart the backend after changing `.env`. The interface hides the model name;
model selection is configured on the server. The AMR predictor separately uses
the already supplied files in `AMR/model` through `AMR/dashboard_bridge.py`.
Do not train or regenerate that model to start the app.

## 5. Run locally

```powershell
npm.cmd run dev
```

Open **http://127.0.0.1:5173/**. Wait for the backend's initial synchronization to
finish on first launch. The frontend may start before the API; a brief initial
proxy connection error can occur while the API is still starting.

| Service | Local address | Purpose |
| --- | --- | --- |
| Development frontend | `http://127.0.0.1:5173` | Dashboard |
| Hub API | `http://127.0.0.1:8000/docs` | App API documentation |
| ADT source API | `http://127.0.0.1:8001/docs` | Patients, wards and stays |
| LIS source API | `http://127.0.0.1:8002/docs` | Cultures, isolates and AST |
| Formulary source API | `http://127.0.0.1:8003/docs` | Antibiotic/reference records |
| PostgreSQL | `127.0.0.1:55432` | Default local hub database |
| Ollama | `http://127.0.0.1:11434` | Local language-model inference |

Do not start `npm.cmd start` alongside `npm.cmd run dev`: both start the backend.
If port 5173 is occupied by your existing dev terminal, reuse it or stop that
terminal with Ctrl+C before starting another copy.

## 6. Check that everything works

1. Open **Overview**, then **Patients**, and open a patient from the directory.
2. Inspect their culture → isolate → antibiotic-result timeline. Hover over an
   identifier to copy it.
3. Open **Laboratory** to browse source tables. Overview shortcuts also open this
   view; Source explorer and Reference library are no longer separate sidebar tabs.
4. Open **AMR predictor** and use an example case or a supported patient/sample.
5. In **AI assistant**, choose Patient ID, Culture ID, Ward code or General question,
   enter a real identifier from the app and send a question. The lower-right popup
   shares the same conversation. The assistant retrieves database context on the
   server, includes applicable AMR estimates and attributed TYKS guideline context,
   then asks the local model to explain it.
6. Change the language between English and Suomi to check localization.

Check the AI connection directly:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/assistant/status
```

`available: true` and `ready: true` mean Ollama is reachable and the configured
model is installed. Also send a real chat question to verify generation; status
alone does not measure answer speed or quality.

An empty **Anomalies** tab can mean that no comparisons qualify, including when
recent matched sample counts are too small. To demonstrate a known signal, open
**Anomalies → Test with synthetic scenarios** and load a scenario. See
[anomaly testing](docs/ANOMALIES.md) for expected counts, corrections and replay.

## 7. Demonstrate incoming patients and results

With the backend running, generate and queue a new synthetic batch:

```powershell
npm.cmd run demo:generate -- --patients 50 --inbox
```

The default feed registers one patient every **30 seconds**. For cases with
supplied results, organisms appear one tick later (about 30 seconds after
registration), then AST results and the supplied final state appear on the next
tick (about 60 seconds after registration), plus processing time. Cases explicitly
supplied as pending stay pending; the app does not invent their missing results.

Changes travel from source databases through FHIR messages to the hub and live
dashboard. This feed interval controls arrivals, not message-delivery latency.
A 50-patient feed takes about 26 minutes including its final result stages;
additional queued batches extend the arrivals during the same session.

Progress survives restart. If all inbox batches finished, the next startup normally
replays only feed-owned patients and linked records; the original baseline is
retained. `.env.example` documents the feed interval, group size, automatic import
and restart/replay controls. Scenarios loaded from the Anomalies tab are separate.

## 8. Share a temporary public demo with ngrok

Use the bundled preview for judging. It serves compiled frontend assets and
forwards `/api` to your existing backend. The database and AI model still run on
your computer; visitors do not install Ollama.

### One-time ngrok setup

Create a [free ngrok account](https://dashboard.ngrok.com/signup) and install the
[Windows agent](https://ngrok.com/download/windows):

```powershell
winget install ngrok -s msstore
```

Open a new PowerShell window if `ngrok` is not found after installation. From
[Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken), copy and
run the account's token command locally:

```powershell
ngrok config add-authtoken "YOUR_TOKEN"
ngrok config check
```

Enter the actual token only in your local terminal. The token is not part of
`docs/ngrok-demo.yml` and must not be committed to the repository.

### Start the demo

Use a separate terminal for each command, all from the repository root:

| Terminal | Command | Leave running |
| --- | --- | --- |
| Backend | `npm.cmd start` | Yes. Skip starting this if `npm.cmd run dev` is already providing the backend. |
| Bundled frontend | `npm.cmd run demo:web` | Yes; wait for `http://127.0.0.1:5174` to appear. |
| Public tunnel | `npm.cmd run demo:tunnel` | Yes; share the printed HTTPS forwarding URL. |

Keep Ollama running too. Open **http://127.0.0.1:5174/** locally before testing the
public URL. If a preview is already running on 5174, use it instead of starting a
second copy. Rebuild with `demo:web` after frontend edits; a running preview does
not automatically rebuild the frontend.

The tunnel script uses [ngrok-demo.yml](docs/ngrok-demo.yml) to set the forwarded
Host header to `localhost`, which avoids editing Vite's hostname allowlist for
each assigned domain. Test on a phone using mobile data: load the dashboard, open
a patient, send a chat question and verify updates. Visitors on the free plan may
see ngrok's initial warning page and need to click through.

Keep the computer awake and connected throughout judging. Ngrok's current free
plan has no endpoint session timeout, but does have monthly traffic/request
quotas; review [the official limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)
and monitor usage for a multi-hour demo. A public link exposes the app's existing
record-writing controls; use synthetic data. The local preview and tunnel are a
temporary demo arrangement, not an authenticated clinical deployment.

LocalTunnel is an alternative, but repeated 502/503 errors occurred during demo
testing. If using it, forward port **5174** and allow its exact assigned hostname
in Vite. Do not disable host checks globally to fix a changed URL.

## 9. Build, test and stop

```powershell
npm.cmd run build
npm.cmd test
```

The backend tests use temporary SQLite directories, separate source ports and
uniquely named PostgreSQL test databases. They need PostgreSQL and the Python
interpreter for predictor checks. Frontend tests use jsdom and mocked APIs.

To stop, press Ctrl+C in the tunnel, preview and app/backend terminals you started.
The default PostgreSQL cluster remains running until explicitly stopped:

```powershell
npm.cmd run db:stop
```

Stop the application/backend before stopping its database. Local databases and
generated files persist across ordinary restarts; they are ignored by Git.

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| `Dataset not found` | Provide the original six CSVs under `data/raw`, or set an absolute `DATASET_ZIP` / `CSV_DIR` path in `.env`. |
| PostgreSQL binaries not found | Install PostgreSQL or set `POSTGRES_BIN` to the directory containing its executables. |
| PostgreSQL port 55432 occupied | Reuse the app's existing cluster, or configure a dedicated external database with `DATABASE_URL`; do not delete a database to free the port. |
| Port 5173, 5174 or 8000 already in use | An app/preview may already be running. Use that instance, or stop its own terminal before restarting it. |
| `ECONNREFUSED 127.0.0.1:8000` | Wait for initial synchronization/startup, or inspect the backend terminal for its startup error. |
| Python predictor unavailable | Check `python --version`, the `PYTHON_BIN` path and the existing files under `AMR/model`. |
| Ollama bind error on 11434 | Check the existing Ollama instance with `/api/tags`; do not start duplicate servers. |
| Assistant unavailable | Check Ollama, `ollama list`, the configured `OLLAMA_MODEL` and `/api/assistant/status`; restart the backend after `.env` changes. |
| `ERR_NGROK_4018` | Create/sign in to an ngrok account and run its token command locally for the same Windows user running the agent. |
| Public page blank / JavaScript 403 | Use the bundled preview on 5174 and the supplied ngrok policy; hard-refresh the browser. |
| Public 502/503 while localhost works | Check the tunnel terminal, its forwarding port and connectivity. Restart the tunnel if it disconnected. This does not by itself establish an app crash. |
| No anomaly results | Check the coverage/settings and source status, then load a controlled anomaly scenario to verify detection. |

For system details, return to the [README](README.md),
[hospital integration design](docs/hospital-integration.md) or
[anomaly detection guide](docs/ANOMALIES.md).
