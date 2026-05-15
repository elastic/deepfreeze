# Compatibility Contract — Elasticsearch index schemas

These files define the **wire format** for the two Elasticsearch indices
that deepfreeze writes to:

- `deepfreeze-status` — repositories, thaw requests, settings, scheduled jobs
- `deepfreeze-audit` — action audit log

Both the Python implementation (`packages/deepfreeze-core` and
`packages/deepfreeze-server`) and this Kibana plugin write into the same
indices. A user must be able to:

1. Run the Python server today and the Kibana plugin tomorrow, with no
   re-indexing, and have the plugin see existing state.
2. Run both at the same time (read-mostly from one, writes from the other)
   without corrupting documents.

To make that possible, **field names, types, and document shapes are
frozen** across the two implementations. Any change here must land
simultaneously in the corresponding Python file.

## File map

| File | Python source-of-truth |
|---|---|
| `index_mappings.ts` (status) | `packages/deepfreeze-core/deepfreeze_core/utilities.py` — `ensure_settings_index()` |
| `index_mappings.ts` (audit) | `packages/deepfreeze-core/deepfreeze_core/audit.py` — `AuditLogger.ensure_audit_index()` |
| `repository.ts` | `packages/deepfreeze-core/deepfreeze_core/helpers.py` — `Repository.to_dict()` |
| `thaw_request.ts` | `packages/deepfreeze-core/deepfreeze_core/utilities.py` — `save_thaw_request()` |
| `settings.ts` | `packages/deepfreeze-core/deepfreeze_core/helpers.py` — `Settings.to_dict()` |
| `scheduled_job.ts` | `packages/deepfreeze-server/deepfreeze_server/orchestration/scheduler.py` — `Scheduler._persist_job()` |
| `audit_entry.ts` | `packages/deepfreeze-core/deepfreeze_core/audit.py` — `AuditLogger.log_action()` |

## Doctype discriminator

Documents in `deepfreeze-status` share an index but are distinguished by
a `doctype` keyword field:

- `"repository"`
- `"thaw_request"`
- `"settings"`
- `"scheduled_job"`

Queries that target a single kind of document use `{ term: { doctype: ... } }`.

## Casing

Field names are `snake_case` on the wire to match what Python writes.
If a UI component prefers `camelCase`, do the conversion at the React-
component boundary; **never** in the storage layer.

## Tests

The schema-equivalence harness (see `tests/parity/`) loads fixture
documents produced by the Python actions and asserts that the TS types
here validate them. CI fails if Python writes a field the TS schema
doesn't know about, or vice versa.
