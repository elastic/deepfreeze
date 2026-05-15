# Development

## Layout assumption

Kibana plugins normally live inside a Kibana checkout. This plugin's
source-of-truth is here (under `deepfreeze/kibana-plugin/`), but to
actually run/build/test it you point a Kibana checkout at this directory.

Recommended layout:

```
~/git/
├── deepfreeze/                ← this repo
│   └── kibana-plugin/
└── kibana/                    ← github.com/elastic/kibana, branch 9.x
    └── x-pack/plugins/
        └── deepfreeze/        ← symlink → ../../../deepfreeze/kibana-plugin
```

```sh
cd ~/git/kibana/x-pack/plugins
ln -s ../../../deepfreeze/kibana-plugin deepfreeze
```

Kibana's build tooling will then treat the plugin as if it lived in-tree.

## Toolchain setup

Inside your Kibana checkout:

```sh
nvm use                # uses .nvmrc, currently Node 20.x for Kibana 9
yarn kbn bootstrap
```

Bootstrap will discover the symlinked plugin and install its references.

## Running

```sh
# From the kibana checkout
yarn start --no-base-path
```

The plugin's app will appear under Stack Management. While you're
iterating, edits to TS/TSX files trigger hot reload.

## Type checking

```sh
# From the kibana checkout
node scripts/type_check --project x-pack/plugins/deepfreeze/tsconfig.json
```

## Tests

```sh
# Unit (Jest)
yarn test:jest --config x-pack/plugins/deepfreeze/jest.config.js

# Functional (FTR)
node scripts/functional_tests --config x-pack/test/deepfreeze/config.ts
```

Jest and FTR configs land in Task #4.

## Working without a Kibana checkout

You can still edit code, write schemas/types, and run the parity tests
in `common/schemas/__tests__/` once Jest is wired up (Task #4). The
plugin lifecycle code (`server/plugin.ts`, `public/plugin.ts`) imports
`@kbn/core` symbols and won't type-check in isolation — those errors are
expected until the symlink-to-Kibana setup above is in place.

## Configuration

In `kibana.yml`:

```yaml
deepfreeze.enabled: true
deepfreeze.telemetry.enabled: false   # opt-in
```

Sensitive values (AWS keys, Azure connection strings, GCS service
accounts) belong in the Kibana keystore — never in `kibana.yml`. The
keys land in later phases when the storage-client port begins.
