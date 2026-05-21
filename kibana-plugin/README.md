# `@kbn/deepfreeze-plugin`

A Kibana plugin for [deepfreeze](https://github.com/elastic/deepfreeze) —
an Elasticsearch snapshot lifecycle tool that ages snapshots into cheap
cold storage (AWS S3 Glacier, Azure Archive, GCS Coldline) and thaws
them back on demand.

This plugin is the **Kibana-native** way to operate deepfreeze. It
replaces the standalone Python web UI in `packages/deepfreeze-server/`
once it reaches feature parity (see the migration plan).

## Status

| Phase | Description | State |
|---|---|---|
| 0 | Foundation: scaffold, schemas, types, CI | complete |
| 1 | Read-only `Status` (Overview, Repos, Thaws, Activity) | complete |
| 2 | `Setup` wizard | complete |
| 3 | `Rotate`, `Cleanup`, `Refreeze` | complete |
| 4 | `Thaw` + `RepairMetadata` (long-running ops) | complete |
| 5 | Scheduler | complete |
| 6 | Python server + CLI deprecated | not started |
| 7 | Upstream submission | **in progress** |

The full migration plan lives in the Obsidian vault at
`Notes/Projects/deepfreeze/kibana-plugin-migration-plan.md`. AWS credential
configuration is covered in [`../AWS_CREDENTIALS.md`](../AWS_CREDENTIALS.md).

## Layout

```
kibana-plugin/
├── kibana.jsonc          Plugin manifest (Kibana 9 v2 format)
├── package.json          Node package descriptor
├── tsconfig.json         TS config (extends Kibana base)
├── README.md             ← you are here
├── DEVELOPMENT.md        How to build / run / test
├── common/               Shared between server and public
│   ├── api/              HTTP path constants
│   ├── constants.ts
│   ├── schemas/          ES index mappings + doc shapes (storage contract)
│   └── types/            API request/response shapes (HTTP contract)
├── server/               Node entry point
│   ├── actions/          status, setup, rotate, cleanup, refreeze, thaw, repair_metadata, update_date_ranges
│   ├── audit/            AuditLogger + tracker (all mutating actions tracked)
│   ├── es/               Index bootstrap (status + audit index lifecycle)
│   ├── errors.ts         Domain error types
│   ├── repositories/     ES data-access helpers (one per doctype + ILM/template)
│   ├── routes/           HTTP route handlers (one per action + scheduler diagnostics)
│   ├── scheduler/        TaskManager registration, sync, bootstrap, schedules CRUD
│   ├── storage/          Cloud-storage adapters (aws_client + factory; Azure/GCS TBD)
│   ├── telemetry/        Opt-in usage collector
│   ├── plugin.ts
│   ├── config.ts
│   ├── index.ts
│   └── types.ts
└── public/               Browser entry point
    ├── components/       Reusable UI bits (modals, refresh control, page states)
    ├── hooks/            React hooks (use_status, etc.)
    ├── pages/            overview, repositories, thaw_requests, activity, schedules, setup_wizard
    ├── utils/            Date formatting + shared helpers
    ├── app.tsx           Router + tab shell + breadcrumbs
    ├── application.tsx
    ├── plugin.ts
    ├── index.ts
    └── types.ts
```

## Compatibility contract

Both this plugin and the legacy Python implementation write into the
same two Elasticsearch indices (`deepfreeze-status`, `deepfreeze-audit`)
using the same document shapes. See `common/schemas/README.md` for the
contract and the cross-references to the Python source.

## License

Apache-2.0. The plugin license may change to Elastic License v2 if/when
it's accepted into Kibana proper.
