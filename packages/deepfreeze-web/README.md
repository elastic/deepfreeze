# deepfreeze-web

Web UI for deepfreeze — FastAPI backend serving a React/Elastic EUI frontend.

## Quick Start (Development)

```bash
# Terminal 1 — Backend
deepfreeze-web --config ~/.deepfreeze/config.yml --host 0.0.0.0 --port 8000

# Terminal 2 — Frontend dev server (hot reload)
cd frontend
npm install
npm run dev
```

Browse to `http://<host>:5173`

## Production Build

Build the frontend so FastAPI serves everything from a single process:

```bash
cd frontend
npm install
npm run build      # outputs to frontend/dist/
```

Then run the backend only — it auto-detects `frontend/dist/` and serves the built files:

```bash
deepfreeze-web --config ~/.deepfreeze/config.yml --host 0.0.0.0 --port 8000
```

Browse to `http://<host>:8000`

## Running as a systemd Service

1. Build the frontend (see above).

2. Copy the service file and edit it to match your environment:

```bash
sudo cp deepfreeze-web.service /etc/systemd/system/
sudo vi /etc/systemd/system/deepfreeze-web.service
```

At minimum, update:
- `User` — the Linux user that runs deepfreeze
- `Environment PATH` — ensure it includes pyenv shims or your virtualenv bin
- `ExecStart` — path to `deepfreeze-web` binary and your config file
- `WorkingDirectory` — home directory of the service user

3. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable deepfreeze-web
sudo systemctl start deepfreeze-web
```

4. Check status and logs:

```bash
sudo systemctl status deepfreeze-web
journalctl -u deepfreeze-web -f
```

## CLI Options

```
deepfreeze-web [OPTIONS]

  --config, -c PATH     Path to config file (default: ~/.deepfreeze/config.yml)
  --host HOST           Bind address (default: 0.0.0.0)
  --port, -p PORT       Listen port (default: 8000)
  --reload              Enable auto-reload for development
  --cors-origin URL     Allowed CORS origin (repeatable, default: *)
```

## Pages

| Page | Description |
|------|-------------|
| Overview | Cluster health, repo/thaw/bucket/ILM counts — click any card for details |
| Repositories | Sortable, searchable repo table with flyout detail view |
| Thaw Requests | Thaw request table with status, date range, repo list |
| Actions | Run Thaw, Cleanup, Refreeze, Fix/Repair, Rotate with dry-run option |
| Activity | Audit log from Elasticsearch with full detail flyouts |
