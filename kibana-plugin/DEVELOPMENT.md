# Development

## Layout

This plugin's source-of-truth lives here (`deepfreeze/kibana-plugin/`).
To build, type-check, or run it, Kibana's tooling needs to see it as an
in-tree plugin — so we mirror the source into a sibling Kibana checkout
at `x-pack/platform/plugins/private/deepfreeze`.

```
~/git/
├── deepfreeze/                                 ← canonical source
│   └── kibana-plugin/                          ← edit files here
│       └── scripts/sync-to-kibana.sh
└── kibana/                                     ← Kibana 9.x checkout
    └── x-pack/platform/plugins/private/
        └── deepfreeze/                         ← rsync target
```

### Why rsync, not a symlink

Kibana's plugin discovery uses `git ls-files` from the Kibana repo root.
git treats a symlink as a single entry and does **not** descend into it,
so a symlinked plugin's `kibana.jsonc` is invisible to discovery. An
rsync'd real directory is discovered correctly.

## One-time setup

```sh
# 1. Install nvm + Kibana's Node version
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"

# 2. Clone Kibana 9.x
cd ~/git
git clone --single-branch --branch 9.4 https://github.com/elastic/kibana.git

# 3. Use the Node version Kibana pins
cd kibana
nvm install   # reads .nvmrc

# 4. Enable yarn classic
corepack enable
corepack prepare yarn@1.22.22 --activate

# 5. Sync this plugin into Kibana
cd ~/git/deepfreeze
kibana-plugin/scripts/sync-to-kibana.sh

# 6. Bootstrap Kibana (discovers the plugin, links it into node_modules,
#    updates tsconfig.base.json and the root package.json)
cd ~/git/kibana
yarn kbn bootstrap --force-install
```

Bootstrap takes 3–10 minutes on a fast machine, longer on first run.

## External Kibana dependencies

The plugin needs one third-party package added to Kibana's root
`package.json` that upstream Kibana doesn't currently ship:

| Package                 | Version  | Why                                    |
|-------------------------|----------|----------------------------------------|
| `@aws-sdk/client-s3`    | `3.994.0`| Phase 4 Thaw: `s3:RestoreObject` calls |

Add it under the `dependencies` block (alongside the existing
`@aws-sdk/client-bedrock-*` entries) **and** under `resolutions`
(same version), then re-bootstrap:

```sh
cd ~/git/kibana
# Edit package.json — see above
yarn kbn bootstrap --force-install
```

**This change does not survive a Kibana rebase.** Every time you pull
fresh from `elastic/kibana`, re-apply the two `package.json` entries
and re-run bootstrap. When the plugin is contributed upstream
(Phase 7), the dep addition will land in the same PR; until then it's
a manual step.

Why this dep is mandatory and not optional: Elasticsearch's REST API
has no Glacier-restore primitive — `s3:RestoreObject` calls must come
from Node-side. Three alternatives (drop Glacier support, external
restore handoff, hand-rolled SigV4) were considered and rejected;
keeping the SDK matches what the Python implementation does with
`boto3`, just at the Kibana layer.

## Iteration loop

After editing files under `deepfreeze/kibana-plugin/`:

```sh
# Re-sync (fast — only changed files)
cd ~/git/deepfreeze && kibana-plugin/scripts/sync-to-kibana.sh

# Type-check
cd ~/git/kibana && node scripts/type_check \
  --project x-pack/platform/plugins/private/deepfreeze/tsconfig.json

# Unit tests (Kibana-aware)
cd ~/git/kibana && yarn test:jest \
  --config x-pack/platform/plugins/private/deepfreeze/jest.config.js
```

If you add or rename a `kibana.jsonc` entry (new required plugin, new
plugin ID, etc.), re-run `yarn kbn bootstrap --force-install` after the
sync.

## Standalone tests (no Kibana checkout)

The harness in this directory tests Kibana-independent modules
(`common/`, `server/es/`, `server/audit/`):

```sh
cd kibana-plugin
npm install     # one-time
npm test        # 30 tests, ~0.3s
```

These tests use plain Jest + ts-jest with a self-contained
`tsconfig.test.json` and don't require Kibana to be installed.

## Running Kibana with the plugin

```sh
cd ~/git/kibana
yarn start --no-base-path
```

Once Kibana boots, the plugin's app appears under Stack Management.

## Required Elasticsearch service-account permissions (scheduler)

The plugin stores its state in custom indices (`deepfreeze-status`,
`deepfreeze-audit`) rather than `.kibana_*` SavedObjects. HTTP routes
work fine because they authenticate as the requesting user via
`client.asCurrentUser` — your interactive user (e.g. a superuser)
already has access.

**Background tasks** (the Phase 5 scheduler — Rotate / Cleanup /
RepairMetadata on a timer) have no request context, so they fall back
to `client.asInternalUser`, which authenticates as Kibana's
configured service account — `kibana_system` by default. `kibana_system`
is a reserved user with permissions scoped to `.kibana_*` and **cannot
read `deepfreeze-*` indices**. Without the grant below, the bootstrap
on plugin start fails with `security_exception: action
[indices:data/read/search] is unauthorized for user [kibana_system]`,
and no scheduled tasks fire.

`kibana_system` is reserved and can't be granted additional roles
directly. The fix is to create a custom service user that holds both
the `kibana_system` role (so the rest of Kibana keeps working) plus a
deepfreeze-specific role, and point Kibana at that user.

In Dev Tools (or via the `_security` API as `elastic`):

```
# 1. Role granting access to deepfreeze indices.
PUT _security/role/deepfreeze_access
{
  "indices": [
    {
      "names": ["deepfreeze-*"],
      "privileges": ["read", "write", "create_index", "manage", "view_index_metadata"]
    }
  ],
  "cluster": ["monitor"]
}

# 2. Custom service user that combines kibana_system + the new role.
POST _security/user/deepfreeze_kibana
{
  "password": "<choose-a-password>",
  "roles": ["kibana_system", "deepfreeze_access"],
  "full_name": "Kibana service user with deepfreeze access"
}
```

Then in `~/git/kibana/config/kibana.dev.yml`, swap Kibana's credentials:

```yaml
elasticsearch.username: "deepfreeze_kibana"
elasticsearch.password: "<the password>"
```

Restart Kibana. Verify the bootstrap worked:

```
GET kbn:/api/deepfreeze/scheduler/diagnostics
```

`visible_to_internal_user.count` should match
`visible_to_current_user.count`, and `last_result.scheduled` should
list any non-paused `scheduled_job` docs in the status index.

> **Production note**: this hack works for self-managed clusters where
> you control the service account. On Elastic Cloud (kibana_system
> credentials are managed by the platform) the right answer is to
> migrate `scheduled_job` to a Kibana SavedObject type — tracked as
> follow-up work in the project's TODO list.

## Type-check before commit

CI for the plugin in the deepfreeze repo only runs the standalone Jest
suite. Before committing, manually type-check against Kibana:

```sh
cd ~/git/deepfreeze && kibana-plugin/scripts/sync-to-kibana.sh
cd ~/git/kibana && node scripts/type_check \
  --project x-pack/platform/plugins/private/deepfreeze/tsconfig.json
```

A `pre-push` hook to do this automatically is on the wishlist (Phase 1).

## Configuration

In `kibana.yml`:

```yaml
xpack.deepfreeze.enabled: true
xpack.deepfreeze.telemetry.enabled: false   # opt-in
```

Sensitive values (AWS keys, Azure connection strings, GCS service
accounts) belong in the Kibana keystore — never in `kibana.yml`. The
keys land in later phases when the storage-client port begins.
