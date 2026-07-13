# Deepfreee UI System — Phase 2 Next Steps Plan

> **Date:** 2026-03-22
> **Status:** Phase 1 Complete (porcelain-json + audit foundation), Phase 2 Ready to Implement

---

## Overview

Phase 1 is complete. Two feature branches have been created:

| Branch | Status | Description |
|--------|--------|-------------|
| `feature/porcelain-json` | ✅ Committed | All actions output JSON in `--porcelain` mode |
| `feature/audit-logging` | ✅ Committed | Audit logging foundation (`audit.py`) created |

**This plan documents the remaining work** to fully integrate audit logging into actions and the CLI.

---

## Phase 2: Audit Integration

### Goal

Wire up the audit logging infrastructure to actually record all mutating actions. This includes:

1. **Action integration** — Each mutating action accepts and uses `AuditLogger`
2. **CLI integration** — CLI creates `AuditLogger` and passes to actions
3. **Status command extension** — Add `--audit` flag to view recent audit entries
4. **Setup creates audit index** — Ensure `deepfreeze-audit` ES index exists

---

## Implementation Steps

### Step 1: Modify Action Classes

Add optional `audit` parameter to each mutating action's `__init__` and integrate tracking.

#### Setup Action

**File:** `packages/deepfreeze-core/deepfreeze_core/actions/setup.py`

**Changes:**
```python
def __init__(
    self,
    client: Elasticsearch,
    year: int = None,
    ...
    porcelain: bool = False,
    audit: AuditLogger = None,  # ADD THIS
    **kwargs,
) -> None:
    ...
    self.audit = audit  # ADD THIS

def do_action(self) -> None:
    tracker = None
    if self.audit:
        tracker = self.audit.start_tracking(
            action="setup",
            dry_run=False,
            parameters={
                "repo_name_prefix": self.settings.repo_name_prefix,
                "bucket_name_prefix": self.settings.bucket_name_prefix,
                "ilm_policy_name": self.ilm_policy_name,
                "index_template_name": self.index_template_name,
            }
        )
    
    try:
        # At each existing result point, also call:
        if tracker:
            tracker.add_result({"type": "settings_index", "action": "created"})
        
        # ... rest of existing logic ...
        
        if tracker:
            tracker.set_summary({
                "repository": self.new_repo_name,
                "bucket": self.new_bucket_name,
                "base_path": self.base_path,
            })
    except Exception as e:
        if tracker:
            tracker.add_error({"code": type(e).__name__, "message": str(e)})
        raise
    finally:
        if self.audit and tracker:
            self.audit.commit(tracker)

def do_dry_run(self) -> None:
    # Same pattern as do_action but with dry_run=True
    tracker = None
    if self.audit:
        tracker = self.audit.start_tracking(
            action="setup",
            dry_run=True,
            parameters={...}
        )
    try:
        # ... existing logic ...
        if tracker:
            tracker.add_result({"type": "precondition", ...})
    finally:
        if self.audit and tracker:
            self.audit.commit(tracker)
```

#### Rotate Action

**File:** `packages/deepfreeze-core/deepfreeze_core/actions/rotate.py`

**Changes:**
```python
def __init__(..., audit: AuditLogger = None):
    ...
    self.audit = audit

def do_action(self):
    tracker = None
    if self.audit:
        tracker = self.audit.start_tracking(
            action="rotate",
            dry_run=False,
            parameters={"keep": self.keep, "year": self.year, "month": self.month}
        )
    
    try:
        # After creating repository:
        if tracker:
            tracker.add_result({
                "type": "repository",
                "name": new_repo,
                "action": "created"
            })
        
        # After each ILM policy update:
        if tracker:
            tracker.add_result({
                "type": "ilm_policy",
                "name": policy,
                "action": "updated"
            })
        
        # After each repo archive:
        if tracker:
            tracker.add_result({
                "type": "repository",
                "name": repo,
                "action": "archived"
            })
        
        if tracker:
            tracker.set_summary({
                "new_repository": new_repo,
                "archived_count": len(archived_repos),
            })
    except Exception as e:
        if tracker:
            tracker.add_error({"code": type(e).__name__, "message": str(e)})
        raise
    finally:
        if self.audit and tracker:
            self.audit.commit(tracker)
```

#### Thaw Action

**File:** `packages/deepfreeze-core/deepfreeze_core/actions/thaw.py`

**Changes:**
```python
def __init__(..., audit: AuditLogger = None):
    ...
    self.audit = audit

# In _initiate_thaw():
def _initiate_thaw(self, dry_run: bool = False):
    tracker = None
    if self.audit:
        tracker = self.audit.start_tracking(
            action="thaw",
            dry_run=dry_run,
            parameters={
                "start_date": self.start_date.isoformat() if self.start_date else None,
                "end_date": self.end_date.isoformat() if self.end_date else None,
                "sync": self.sync,
                "duration": self.restore_days,
                "retrieval_tier": self.retrieval_tier,
            }
        )
    
    try:
        # When creating request:
        if tracker:
            tracker.add_result({
                "type": "thaw_request",
                "request_id": request_id,
                "action": "created"
            })
        
        # For each repo restore:
        if tracker:
            tracker.add_result({
                "type": "restore_initiated",
                "repository": repo.name,
                "objects": len(objects)
            })
        
        if tracker:
            tracker.set_summary({
                "request_id": request_id,
                "repositories_count": len(repos),
            })
    except Exception as e:
        if tracker:
            tracker.add_error({"code": "THAW_ERROR", "message": str(e)})
        raise
    finally:
        if self.audit and tracker:
            self.audit.commit(tracker)
```

#### Refreeze, Cleanup, RepairMetadata Actions

Follow the same pattern:
1. Accept `audit: AuditLogger = None` in `__init__`
2. Create tracker with `start_tracking()` at action start
3. Call `tracker.add_result()` at each result point (where `_results.append()` already exists)
4. Call `tracker.set_summary()` before completion
5. Wrap in try/finally to ensure `audit.commit(tracker)` is always called
6. In except blocks, call `tracker.add_error()` before re-raising

---

### Step 2: Update CLI Main

**File:** `packages/deepfreeze-cli/deepfreeze/cli/main.py`

#### Add AuditLogger Creation

```python
# Near top of file, add import:
from deepfreeze_core import AuditLogger

# In cli() group function, after creating client:
ctx.obj["audit"] = None  # Created lazily

def get_audit_from_context(ctx):
    """Get or create an AuditLogger from the CLI context."""
    if "audit" not in ctx.obj or ctx.obj["audit"] is None:
        try:
            client = get_client_from_context(ctx)
            ctx.obj["audit"] = AuditLogger(client)
        except Exception:
            # Audit logging is optional - if ES is not available, proceed without audit
            ctx.obj["audit"] = None
    return ctx.obj["audit"]
```

#### Update Each Mutating Command

```python
@cli.command()
@click.pass_context
def setup(ctx, ...):
    from deepfreeze_core.actions import Setup
    
    client = get_client_from_context(ctx)
    audit = get_audit_from_context(ctx)  # ADD THIS
    
    action = Setup(
        client=client,
        ...
        audit=audit,  # ADD THIS
    )
    
    try:
        if ctx.obj["dry_run"]:
            action.do_dry_run()
        else:
            action.do_action()
    except DeepfreezeException as e:
        ...

# Same pattern for rotate, thaw, refreeze, cleanup, repair-metadata
```

**Status command does NOT get audit** (read-only).

---

### Step 3: Add `--audit` Flag to Status Command

**File:** `packages/deepfreeze-cli/deepfreeze/cli/main.py`

```python
@cli.command()
@click.option(
    "-a",
    "--audit",
    "show_audit",
    type=int,
    default=None,
    is_flag=False,
    flag_value=25,
    help="Show recent audit log entries (default: 25, or specify count)",
)
@click.pass_context
def status(
    ctx,
    limit,
    repos,
    show_time,
    thawed,
    buckets,
    ilm,
    show_config_flag,
    show_audit,  # ADD THIS PARAMETER
    porcelain,
):
    from deepfreeze_core.actions import Status
    
    client = get_client_from_context(ctx)
    audit = get_audit_from_context(ctx)  # Get audit logger
    
    action = Status(
        client=client,
        porcelain=porcelain,
        limit=limit,
        show_repos=repos,
        show_thawed=thawed,
        show_buckets=buckets,
        show_ilm=ilm,
        show_config=show_config_flag,
        show_time=show_time,
        show_audit=show_audit,  # PASS TO ACTION
        audit=audit,  # PASS AUDIT LOGGER FOR FETCHING ENTRIES
    )
    ...
```

---

### Step 4: Update Status Action

**File:** `packages/deepfreeze-core/deepfreeze_core/actions/status.py`

```python
def __init__(
    self,
    client: Elasticsearch,
    porcelain: bool = False,
    ...
    show_audit: int = None,  # ADD THIS (None means don't show, int means show N entries)
    audit: AuditLogger = None,  # ADD THIS (for fetching entries)
    **kwargs
):
    ...
    self.show_audit = show_audit
    self.audit = audit

def do_action(self):
    ...
    # Existing sections...
    
    # Add audit section if requested
    if self.show_audit and self.audit:
        audit_entries = self.audit.get_recent_entries(limit=self.show_audit)
        if self.porcelain:
            output["audit"] = audit_entries
        else:
            self._display_audit_table(audit_entries)

def _display_audit_table(self, entries: list):
    """Display audit entries in a Rich table."""
    from rich.table import Table
    
    if not entries:
        self.console.print("[dim]No recent audit entries found.[/dim]")
        return
    
    table = Table(
        title=f"Recent Audit Log (last {len(entries)} entries)",
        show_header=True,
        header_style="bold blue"
    )
    table.add_column("Timestamp")
    table.add_column("Action")
    table.add_column("Dry Run")
    table.add_column("Success")
    table.add_column("Duration")
    table.add_column("User")
    
    for entry in entries:
        table.add_row(
            entry.get("timestamp", "N/A")[:19],  # Trim to date+time
            entry.get("action", "N/A"),
            "Yes" if entry.get("dry_run") else "No",
            "✓" if entry.get("success") else "✗",
            f"{entry.get('duration_ms', 0)/1000:.1f}s",
            entry.get("user", "unknown"),
        )
    
    self.console.print(table)
```

---

### Step 5: Setup Creates Audit Index

**File:** `packages/deepfreeze-core/deepfreeze_core/actions/setup.py`

Add to `do_action()` after creating status index:

```python
# Create audit index alongside status index
if self.audit:
    self.audit.ensure_audit_index()
    self._results.append({"type": "audit_index", "action": "created"})
else:
    # Even without audit logger, ensure the index exists for future use
    from deepfreeze_core.audit import ensure_audit_index
    ensure_audit_index(self.client)
    self._results.append({"type": "audit_index", "action": "created"})
```

---

### Step 6: Add Tests

**File:** `tests/cli/test_actions.py`

Add tests verifying:
1. Actions can be initialized with `audit=None` (default)
2. Actions can be initialized with `audit=mock_audit`
3. When audit is provided, `start_tracking()` is called
4. When audit is provided, `commit()` is called at completion
5. Audit entries are created with correct action names
6. Status command with `--audit` flag fetches and displays entries

```python
class TestAuditIntegration:
    """Tests for audit logging integration with actions"""
    
    def test_setup_with_audit_logger(self):
        """Test Setup action accepts and uses audit logger"""
        mock_client = MagicMock()
        mock_client.indices.exists.return_value = False
        mock_client.snapshot.get_repository.return_value = {}
        mock_client.info.return_value = {"version": {"number": "8.10.0"}}
        mock_client.ilm.get_lifecycle.return_value = {}
        
        mock_audit = MagicMock()
        mock_tracker = MagicMock()
        mock_audit.start_tracking.return_value = mock_tracker
        
        with patch("deepfreeze_core.actions.setup.s3_client_factory") as mock_factory:
            mock_s3 = MagicMock()
            mock_s3.bucket_exists.return_value = False
            mock_factory.return_value = mock_s3
            
            with patch("deepfreeze_core.actions.setup.ensure_settings_index"):
                with patch("deepfreeze_core.actions.setup.save_settings"):
                    with patch("deepfreeze_core.actions.setup.create_repo"):
                        setup = Setup(
                            client=mock_client,
                            ilm_policy_name="test-policy",
                            index_template_name="test-template",
                            audit=mock_audit,  # Provide audit logger
                        )
                        setup.do_action()
        
        # Verify audit was used
        mock_audit.start_tracking.assert_called_once()
        mock_audit.commit.assert_called_once_with(mock_tracker)
    
    def test_setup_without_audit_logger(self):
        """Test Setup action works without audit logger"""
        # Same test but with audit=None, verify no crash
        ...
    
    # Similar tests for Rotate, Thaw, Refreeze, Cleanup, RepairMetadata
```

---

### Step 7: Update CLI Tests

**File:** `tests/cli/test_cli.py`

Add tests for `--audit` flag:

```python
def test_status_with_audit_flag(self):
    """Test status --audit shows recent audit entries"""
    from click.testing import CliRunner
    from deepfreeze.cli.main import cli
    
    runner = CliRunner()
    
    with patch("deepfreeze.cli.main.get_client_from_context") as mock_client:
        with patch("deepfreeze.cli.main.get_audit_from_context") as mock_audit:
            mock_audit.get_recent_entries.return_value = [
                {"action": "rotate", "success": True, "timestamp": "2026-03-22T10:00:00"}
            ]
            
            result = runner.invoke(cli, ["--config", str(temp_config_file), "status", "--audit"])
            
            assert result.exit_code == 0
            mock_audit.get_recent_entries.assert_called_once_with(limit=25)

def test_status_with_audit_count(self):
    """Test status --audit 50 shows 50 entries"""
    # Similar test with --audit 50
```

---

## Test Plan

After implementing Phase 2:

```bash
# Run all tests
python -m pytest tests/cli/test_actions.py tests/cli/test_cli.py tests/cli/test_audit.py -v

# Expected: 100+ tests passing
```

---

## Files to Modify Summary

| File | Changes |
|------|---------|
| `packages/deepfreeze-core/deepfreeze_core/actions/setup.py` | Add `audit` param, tracking in do_action/do_dry_run |
| `packages/deepfreeze-core/deepfreeze_core/actions/rotate.py` | Add `audit` param, tracking |
| `packages/deepfreeze-core/deepfreeze_core/actions/thaw.py` | Add `audit` param, tracking in all 4 modes |
| `packages/deepfreeze-core/deepfreeze_core/actions/refreeze.py` | Add `audit` param, tracking |
| `packages/deepfreeze-core/deepfreeze_core/actions/cleanup.py` | Add `audit` param, tracking |
| `packages/deepfreeze-core/deepfreeze_core/actions/repair_metadata.py` | Add `audit` param, tracking |
| `packages/deepfreeze-core/deepfreeze_core/actions/status.py` | Add `show_audit` param, display audit entries |
| `packages/deepfreeze-cli/deepfreeze/cli/main.py` | Create/pass AuditLogger, add --audit flag |
| `tests/cli/test_actions.py` | Add audit integration tests |
| `tests/cli/test_cli.py` | Add --audit flag tests |

---

## Estimated Effort

| Task | Estimated Time |
|------|----------------|
| Modify 6 action classes | 2-3 hours |
| Update CLI main | 30 minutes |
| Update Status action | 30 minutes |
| Add tests | 1-2 hours |
| Test & debug | 1 hour |
| **Total** | **5-6 hours** |

---

## Notes

1. **Audit logging is optional** — All actions must work correctly with `audit=None`
2. **Silent failure** — If audit logging fails, the action should still succeed
3. **No breaking changes** — Existing CLI behavior unchanged unless `--audit` is used
4. **ES index auto-created** — `deepfreeze-audit` index created on first use
5. **Future enhancement** — Consider `deepfreeze audit` subcommand for full audit log management
