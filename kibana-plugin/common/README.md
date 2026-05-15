# common/

Code shared between the plugin's `server/` (Node) and `public/` (browser)
halves. Kibana plugins compile both halves from the same `tsconfig`, so
anything that needs to be referenced from both lives here.

## Layout

```
common/
├── constants.ts        Index names, doctypes, enum values
├── schemas/            Storage contract: ES index mappings + doc shapes
│   ├── index_mappings.ts
│   ├── repository.ts
│   ├── thaw_request.ts
│   ├── settings.ts
│   ├── scheduled_job.ts
│   ├── audit_entry.ts
│   └── README.md       Explains the Python-↔-TS contract
└── types/              API contract: request/response shapes for routes
    ├── commands.ts     Action requests (rotate, thaw, …) + CommandResult
    ├── jobs.ts         Job, JobStatus, JobProgress, JobSubmission
    ├── events.ts       Event types (SSE-era; retained for parity)
    ├── errors.ts       ServiceError + error code catalogue
    └── status.ts       SystemStatus, ClusterHealth, ActionHistoryEntry
```

## Why two folders

- **`schemas/`** is the *storage contract*: what we write into
  Elasticsearch. Must match Python byte-for-byte.
- **`types/`** is the *API contract*: what flows over HTTP between the
  Kibana plugin server and the browser. Mirrors the Python server's
  Pydantic models for parity, but is not constrained to match
  Elasticsearch on-disk shapes.

Some docs (e.g. `RepositoryDoc`) appear in both worlds because the
Python server passes them through unchanged. The schema definition is
the source of truth; `types/status.ts` re-uses it.

## Naming conventions

- Wire-format fields stay `snake_case` to match Python.
- TypeScript identifiers (types, functions) use `PascalCase` / `camelCase`.
- Enum-like values are exported as `as const` tuples plus a derived
  union type — usable both for runtime validation and for type narrowing.
