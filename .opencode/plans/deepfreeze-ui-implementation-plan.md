# Deepfreee UI System — Implementation Plan

> **Project:** deepfreee (UI layer over the deepfreeze CLI)
> **Date:** 2026-03-22
> **Status:** Ready to execute

---

## Overview

Two workstreams that lay the foundation for the deepfreee TUI and Web UI by closing gaps in the deepfreeze CLI output layer and adding operational auditability.

| Workstream | Branch | Base |
|---|---|---|
| JSON Porcelain Output | `feature/porcelain-json` | `dev` |
| Audit Logging | `feature/audit-logging` | `dev` |

Both branches leave `dev` and `main` untouched.

---

## Workstream 1: `feature/porcelain-json`

### Problem

Only the `status` command outputs JSON in `--porcelain` mode. The other 6 commands (`setup`, `rotate`, `thaw`, `refreeze`, `cleanup`, `repair-metadata`) output tab-separated lines. Additionally, `setup --dry-run --porcelain` has only partial support (only precondition errors emit porcelain output).

The planned UI service layer needs structured JSON from every command.

### Solution

Convert all 6 non-status actions to emit a consistent JSON envelope in porcelain mode. Fix Setup's dry-run porcelain to be complete. Add tests validating JSON structure.

### JSON Envelope Schema

Every action's porcelain output follows this envelope:

```json
{
  "action": "rotate",
  "dry_run": false,
  "success": true,
  "timestamp": "2026-03-22T10:30:00+00:00",
  "results": [ ... ],
  "errors": [ ... ],
  "summary": { ... }
}
```

| Field | Type | Description |
|---|---|---|
| `action` | string | Command name (`setup`, `rotate`, `thaw`, `refreeze`, `cleanup`, `repair_metadata`) |
| `dry_run` | boolean | Whether this was a dry run |
| `success` | boolean | `true` if no errors |
| `timestamp` | ISO 8601 | When the action completed |
| `results` | array | Structured action items (created/updated/deleted/archived/etc.) |
| `errors` | array | Error objects: `{"code": "...", "message": "...", "target": "..."}` |
| `summary` | object | Action-specific summary (counts, key identifiers) |

Error envelope (when action fails entirely):

```json
{
  "action": "rotate",
  "dry_run": false,
  "success": false,
  "timestamp": "...",
  "results": [],
  "errors": [
    {"code": "MISSING_INDEX", "message": "Status index deepfreeze-status does not exist. Run 'deepfreeze setup' first."}
  ],
  "summary": null
}
```

### Per-Action JSON Schemas

#### Setup (success)

```json
{
  "action": "setup",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "settings_index", "action": "created"},
    {"type": "bucket", "name": "deepfreeze-bucket", "action": "created"},
    {"type": "repository", "name": "deepfreeze-000001", "bucket": "deepfreeze-bucket", "base_path": "snapshots/000001", "action": "created"},
    {"type": "ilm_policy", "name": "my-policy", "action": "created|updated|unchanged"},
    {"type": "index_template", "name": "my-template", "action": "updated|not_found"}
  ],
  "errors": [],
  "summary": {"repository": "deepfreeze-000001", "bucket": "deepfreeze-bucket", "base_path": "snapshots/000001"}
}
```

#### Setup (dry run)

```json
{
  "action": "setup",
  "dry_run": true,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "precondition", "check": "status_index_not_exists", "passed": true},
    {"type": "precondition", "check": "no_existing_repositories", "passed": true},
    {"type": "precondition", "check": "bucket_not_exists", "passed": true},
    {"type": "precondition", "check": "index_template_exists", "passed": true},
    {"type": "precondition", "check": "repository_plugin_available", "passed": true}
  ],
  "errors": [],
  "summary": {"would_create_repository": "deepfreeze-000001", "would_create_bucket": "deepfreeze-bucket"}
}
```

#### Rotate

```json
{
  "action": "rotate",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "repository", "name": "deepfreeze-000004", "bucket": "...", "base_path": "...", "action": "created"},
    {"type": "ilm_policy", "name": "my-policy-000004", "action": "updated"},
    {"type": "date_range", "repository": "deepfreeze-000003", "start": "...", "end": "...", "action": "updated"},
    {"type": "repository", "name": "deepfreeze-000001", "action": "archived"},
    {"type": "ilm_policy", "name": "my-policy-000001", "action": "deleted"}
  ],
  "errors": [],
  "summary": {"new_repository": "deepfreeze-000004", "archived_count": 1, "policies_updated": 1, "policies_deleted": 1}
}
```

#### Thaw (create mode)

```json
{
  "action": "thaw",
  "mode": "create",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "thaw_request", "request_id": "abc12345", "action": "created", "start_date": "...", "end_date": "..."},
    {"type": "restore", "repository": "deepfreeze-000001", "objects": 42, "bucket": "...", "action": "initiated"},
    {"type": "restore", "repository": "deepfreeze-000002", "objects": 35, "bucket": "...", "action": "initiated"}
  ],
  "errors": [],
  "summary": {"request_id": "abc12345", "repositories_count": 2, "total_objects": 77}
}
```

#### Thaw (check-status mode)

```json
{
  "action": "thaw",
  "mode": "check_status",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "thaw_request", "request_id": "abc12345", "status": "in_progress", "start_date": "...", "end_date": "..."},
    {"type": "restore_progress", "repository": "deepfreeze-000001", "total": 42, "restored": 30, "in_progress": 12, "not_restored": 0}
  ],
  "errors": [],
  "summary": {"request_id": "abc12345", "status": "in_progress", "overall_progress": "30/42"}
}
```

#### Thaw (list mode)

```json
{
  "action": "thaw",
  "mode": "list",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "thaw_request", "request_id": "abc12345", "status": "in_progress", "start_date": "...", "end_date": "...", "repos": ["..."], "created_at": "..."},
    {"type": "thaw_request", "request_id": "def67890", "status": "completed", "start_date": "...", "end_date": "...", "repos": ["..."], "created_at": "..."}
  ],
  "errors": [],
  "summary": {"total_requests": 2, "in_progress": 1, "completed": 1}
}
```

#### Refreeze

```json
{
  "action": "refreeze",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "thaw_request", "request_id": "abc12345", "action": "refrozen"},
    {"type": "repository", "name": "deepfreeze-000001", "indices_removed": 3, "action": "refrozen", "status": "success"},
    {"type": "repository", "name": "deepfreeze-000002", "indices_removed": 2, "action": "refrozen", "status": "success"}
  ],
  "errors": [],
  "summary": {"requests_refrozen": 1, "repositories_refrozen": 2, "total_indices_removed": 5}
}
```

#### Cleanup

```json
{
  "action": "cleanup",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "expired_repo", "name": "deepfreeze-000001", "expires_at": "...", "action": "cleaned", "status": "success"},
    {"type": "old_request", "request_id": "abc12345", "request_status": "refrozen", "age_days": 40, "action": "deleted", "status": "success"},
    {"type": "orphan_policy", "name": "my-policy-000001", "repository": "deepfreeze-000001", "action": "deleted", "status": "success"}
  ],
  "errors": [],
  "summary": {"expired_repos_cleaned": 1, "old_requests_deleted": 1, "orphan_policies_deleted": 1, "failures": 0}
}
```

#### Repair Metadata

```json
{
  "action": "repair_metadata",
  "dry_run": false,
  "success": true,
  "timestamp": "...",
  "results": [
    {"type": "state_repair", "repository": "deepfreeze-000001", "recorded_state": "active", "actual_state": "frozen", "action": "repaired", "status": "success"},
    {"type": "date_range", "repository": "deepfreeze-000003", "start": "...", "end": "...", "action": "updated", "status": "success"}
  ],
  "errors": [],
  "summary": {"discrepancies_found": 1, "discrepancies_repaired": 1, "date_ranges_updated": 1, "failures": 0}
}
```

### Implementation Approach

For each action class:

1. Add `self._results = []` and `self._errors = []` instance attributes in `__init__`.
2. Replace each `print("VERB\targ1\targ2")` call with `self._results.append({"type": "...", ...})`.
3. Replace each error `print("ERROR\t...")` call with `self._errors.append({"code": "...", ...})`.
4. Add a `_emit_porcelain(self)` method that assembles the envelope and calls `print(json.dumps(..., indent=2))`.
5. Call `_emit_porcelain()` at the end of `do_action()` and `do_dry_run()` inside `if self.porcelain:` blocks.
6. Non-porcelain (Rich) output is unchanged.

This is a refactor of output format only. No business logic changes.

### Files Modified

| File | Changes |
|---|---|
| `actions/setup.py` | Convert porcelain to JSON, add full dry-run porcelain |
| `actions/rotate.py` | Convert porcelain to JSON |
| `actions/thaw.py` | Convert porcelain to JSON (all 4 modes) |
| `actions/refreeze.py` | Convert porcelain to JSON |
| `actions/cleanup.py` | Convert porcelain to JSON |
| `actions/repair_metadata.py` | Convert porcelain to JSON |
| `tests/cli/test_actions.py` | Add porcelain JSON structure validation tests |
| `tests/cli/test_cli.py` | Add CLI `--porcelain` integration tests |

### Test Strategy

For each action, capture stdout with `io.StringIO` + `contextlib.redirect_stdout`, parse with `json.loads()`, assert on envelope fields and result types:

```python
class TestSetupPorcelainJSON:
    def test_porcelain_success_is_valid_json(self): ...
    def test_porcelain_has_required_envelope_fields(self): ...
    def test_porcelain_dry_run_shows_preconditions(self): ...
    def test_porcelain_error_returns_error_envelope(self): ...
```

---

## Workstream 2: `feature/audit-logging`

### Problem

Deepfreeze has no audit trail. Actions are fire-and-forget — there's no record of what was done, when, by whom, or whether it succeeded. The planned UI needs action history, and operators need accountability.

### Solution

Add an audit logging component to `deepfreeze-core` that records all mutating actions (excluding `status`) to a new `deepfreeze-audit` Elasticsearch index.

### Elasticsearch Index: `deepfreeze-audit`

#### Mapping

```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 1
  },
  "mappings": {
    "properties": {
      "timestamp":      { "type": "date" },
      "action":         { "type": "keyword" },
      "dry_run":        { "type": "boolean" },
      "success":        { "type": "boolean" },
      "duration_ms":    { "type": "long" },
      "parameters":     { "type": "object", "enabled": false },
      "results":        { "type": "object", "enabled": false },
      "errors":         { "type": "object", "enabled": false },
      "summary":        { "type": "object", "enabled": false },
      "user":           { "type": "keyword" },
      "hostname":       { "type": "keyword" },
      "version":        { "type": "keyword" }
    }
  }
}
```

The `parameters`, `results`, `errors`, and `summary` fields use `"enabled": false` — stored but not indexed. They contain arbitrary per-action structures that we retrieve but don't need to query inside.

#### Example Audit Document

```json
{
  "timestamp": "2026-03-22T10:30:00.000Z",
  "action": "rotate",
  "dry_run": false,
  "success": true,
  "duration_ms": 4523,
  "parameters": {
    "year": 2026,
    "month": 3,
    "keep": 6
  },
  "results": [
    {"type": "repository", "name": "deepfreeze-000004", "action": "created"},
    {"type": "repository", "name": "deepfreeze-000001", "action": "archived"}
  ],
  "errors": [],
  "summary": {
    "new_repository": "deepfreeze-000004",
    "archived_count": 1
  },
  "user": "elastic",
  "hostname": "ops-server-1",
  "version": "1.0.1"
}
```

### New Module: `deepfreeze_core/audit.py`

#### Key Classes

**`AuditLogger`** — main entry point:

- `__init__(self, client: Elasticsearch, enabled: bool = True)`
- `ensure_audit_index(self) -> None` — creates index if missing
- `log_action(self, action, dry_run, success, duration_ms, parameters, results, errors, summary) -> None` — writes audit doc, fails silently on ES error
- `start_tracking(self, action, dry_run, parameters) -> ActionTracker` — creates a tracker
- `commit(self, tracker: ActionTracker) -> None` — writes the tracker's accumulated data
- `get_recent_entries(self, limit=25) -> list[dict]` — queries recent audit records for status display

**`ActionTracker`** — accumulates results during action execution:

- `add_result(self, result: dict) -> None`
- `add_error(self, error: dict) -> None`
- `set_summary(self, summary: dict) -> None`
- `mark_failed(self) -> None`
- `mark_success(self) -> None`

Key design constraint: **audit logging is entirely optional and never blocks the action.** If `audit` is `None`, no audit code runs. If ES is unreachable for audit writes, the action still succeeds (a warning is logged).

### Index Creation Strategy

Belt-and-suspenders:

1. `setup` command creates `deepfreeze-audit` alongside `deepfreeze-status`
2. `AuditLogger.log_action()` auto-creates the index if it doesn't exist (handles upgrades from pre-audit versions)

### Integration with Action Classes

Each mutating action class gets an optional `audit` parameter in `__init__`:

```python
class Rotate:
    def __init__(self, client, ..., audit: AuditLogger = None, **kwargs):
        self.audit = audit

    def do_action(self):
        tracker = None
        if self.audit:
            tracker = self.audit.start_tracking(
                action="rotate", dry_run=False,
                parameters={"year": self.year, "month": self.month, "keep": self.keep}
            )
        try:
            # ... existing logic ...
            # At each result point:
            if tracker:
                tracker.add_result({"type": "repository", "action": "created", ...})
            if tracker:
                tracker.set_summary({...})
                tracker.mark_success()
        except Exception as e:
            if tracker:
                tracker.add_error({"code": "...", "message": str(e)})
                tracker.mark_failed()
            raise
        finally:
            if self.audit and tracker:
                self.audit.commit(tracker)
```

**Actions that get audit integration:** `Setup`, `Rotate`, `Thaw`, `Refreeze`, `Cleanup`, `RepairMetadata`

**Actions excluded (read-only):** `Status`

### CLI Integration

```python
# In cli() group function:
ctx.obj["audit"] = None  # created lazily

def get_audit_from_context(ctx):
    if "audit" not in ctx.obj or ctx.obj["audit"] is None:
        client = get_client_from_context(ctx)
        ctx.obj["audit"] = AuditLogger(client)
    return ctx.obj["audit"]

# In each mutating command:
@cli.command()
def rotate(ctx, ...):
    client = get_client_from_context(ctx)
    audit = get_audit_from_context(ctx)
    action = Rotate(client=client, ..., audit=audit)
```

### Status Command: `--audit` Flag

```python
@click.option(
    "-a", "--audit", "show_audit",
    type=int, default=None, is_flag=False, flag_value=25,
    help="Show recent audit log entries (default: 25, or specify count)",
)
```

Usage:

- `deepfreeze status --audit` — shows last 25 audit entries
- `deepfreeze status --audit 50` — shows last 50
- `deepfreeze status -a` — shows last 25
- `deepfreeze status -a 10` — shows last 10

**Behavior:** When `--audit` is specified, it acts as a section flag like `--repos` or `--ilm`. When no section flags are specified, audit is **not** shown by default (unlike other sections which all show). Audit history is supplemental — operators request it explicitly.

**Rich display:** Table with columns: Timestamp, Action, Dry Run, Success, Duration, User

**Porcelain JSON:** Adds `"audit"` key to the status JSON output, containing slim records (omits full `parameters`/`results`/`errors` arrays for lightweight response)

### Files Created

| File | Purpose |
|---|---|
| `deepfreeze_core/audit.py` | `AuditLogger`, `ActionTracker`, `AUDIT_INDEX`, index mapping |
| `tests/cli/test_audit.py` | Tests for audit module |

### Files Modified

| File | Changes |
|---|---|
| `deepfreeze_core/__init__.py` | Export `AuditLogger`, `ActionTracker`, `AUDIT_INDEX` |
| `deepfreeze_core/constants.py` | Add `AUDIT_INDEX = "deepfreeze-audit"` |
| `actions/setup.py` | Create audit index during setup; accept `audit` param |
| `actions/rotate.py` | Accept `audit` param, call tracker at result points |
| `actions/thaw.py` | Same |
| `actions/refreeze.py` | Same |
| `actions/cleanup.py` | Same |
| `actions/repair_metadata.py` | Same |
| `actions/status.py` | Add `show_audit` param, display audit entries |
| `cli/main.py` | Create AuditLogger in context, pass to mutating actions, add `--audit` flag to status |
| `tests/cli/test_actions.py` | Add audit integration tests |
| `tests/cli/test_cli.py` | Test `--audit` flag parsing |

### Test Strategy

```python
class TestAuditLogger:
    def test_log_action_creates_document(self): ...
    def test_log_action_auto_creates_index(self): ...
    def test_log_action_silently_fails_on_es_error(self): ...
    def test_disabled_logger_does_nothing(self): ...

class TestActionTracker:
    def test_add_result(self): ...
    def test_add_error_marks_failed(self): ...
    def test_set_summary(self): ...
    def test_duration_calculated(self): ...

class TestAuditIntegration:
    def test_rotate_with_audit(self): ...
    def test_rotate_without_audit(self): ...
    # ... same for each mutating action
```

---

## Execution Order

### Phase 1: `feature/porcelain-json`

1. Create branch from `dev`
2. Modify `setup.py` — convert porcelain to JSON, add full dry-run porcelain
3. Modify `rotate.py` — convert porcelain to JSON
4. Modify `thaw.py` — convert porcelain to JSON (all 4 modes)
5. Modify `refreeze.py` — convert porcelain to JSON
6. Modify `cleanup.py` — convert porcelain to JSON
7. Modify `repair_metadata.py` — convert porcelain to JSON
8. Add porcelain JSON tests to `test_actions.py`
9. Add CLI porcelain tests to `test_cli.py`
10. Run existing tests — ensure no regressions

### Phase 2: `feature/audit-logging`

1. Create branch from `dev`
2. Add `AUDIT_INDEX` to `constants.py`
3. Create `audit.py` with `AuditLogger`, `ActionTracker`, index mapping
4. Update `__init__.py` exports
5. Integrate audit into each mutating action class
6. Update `setup.py` to create audit index
7. Add `--audit` flag to `status` command and action
8. Update CLI `main.py` to create and pass AuditLogger
9. Create `test_audit.py`
10. Update `test_actions.py` and `test_cli.py`
11. Run all tests

---

## Scope Estimate

| Workstream | Files Modified | Files Created | Lines Changed (est.) |
|---|---|---|---|
| porcelain-json | 8 | 0 | ~1200 |
| audit-logging | 11 | 2 | ~900 |
| **Total** | **17** | **2** | **~2100** |

---

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| TUI framework | Textual | Already uses Rich (deepfreeze dependency). Async, CSS styling, dark themes. |
| Web framework | FastAPI + React + EUI | EUI gives pixel-perfect Elastic brand alignment. FastAPI wraps deepfreeze-core directly. |
| Package location | `packages/deepfreeze-tui` + `packages/deepfreeze-web` | Follows existing monorepo convention. |
| CLI integration | Direct Python import | Import deepfreeze-core action classes directly. No subprocess overhead. |
| EUI components | @elastic/eui | Official component library with dark theme, health badges, data tables. |
| Shared service layer | New deepfreeze-service package | Async service wrapping core, shared by both UIs. |
| Implementation depth | MVP (no auth) | Full feature coverage, notate production requirements for later. |
| Audit storage | Elasticsearch index | Follows existing pattern (deepfreeze-status). Queryable from UI. |
| Branch strategy | Two feature branches off dev | Clean separation, independent review. |
| `--audit` flag default | 25 entries | Integer argument optional: `--audit` = 25, `--audit N` = N. |

---

## Future Production Requirements (not in MVP)

- Authentication (API key or basic auth for web UI)
- HTTPS/TLS configuration
- Docker Compose for web deployment
- Nginx reverse proxy config
- Systemd units for TUI/web services
- Persistent action history (beyond ES audit index)
- Multi-user concurrent access
- RBAC (read-only vs operator roles)
- Metrics/observability (Prometheus endpoint)
