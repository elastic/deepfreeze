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
| 0 | Foundation: scaffold, schemas, types, CI | **in progress** |
| 1 | Read-only `Status` (Overview, Repos, Thaws, Activity) | not started |
| 2 | `Setup` wizard | not started |
| 3 | `Rotate`, `Cleanup`, `Refreeze` | not started |
| 4 | `Thaw` + `RepairMetadata` (long-running ops) | not started |
| 5 | Scheduler | not started |
| 6 | Python server + CLI deprecated | not started |
| 7 | Upstream submission | not started |

The full plan lives in the Obsidian vault at
`Notes/Projects/deepfreeze/kibana-plugin-migration-plan.md`.

## Layout

```
kibana-plugin/
├── kibana.jsonc        Plugin manifest (Kibana 9 v2 format)
├── package.json        Node package descriptor
├── tsconfig.json       TS config (extends Kibana base)
├── README.md           ← you are here
├── DEVELOPMENT.md      How to build / run / test
├── common/             Shared between server and public
│   ├── constants.ts
│   ├── schemas/        ES index mappings + doc shapes (storage contract)
│   └── types/          API request/response shapes (HTTP contract)
├── server/             Node entry point
│   ├── index.ts
│   ├── plugin.ts
│   ├── config.ts
│   └── types.ts
└── public/             Browser entry point
    ├── index.ts
    ├── plugin.ts
    ├── application.tsx
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
