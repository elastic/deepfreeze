# Releasing deepfreeze

Deepfreeze publishes three packages to PyPI from this repo:

- [`deepfreeze-core`](https://pypi.org/project/deepfreeze-core/)
- [`deepfreeze-cli`](https://pypi.org/project/deepfreeze-cli/)
- [`deepfreeze-server`](https://pypi.org/project/deepfreeze-server/)

Publishing is automated: pushing a `v*` tag to `elastic/deepfreeze` runs
`.github/workflows/release.yml`, which builds all three packages and uploads
them to PyPI via **Trusted Publishing** (OIDC — no API tokens stored).

## One-time setup

Already configured, documented here for recovery.

### PyPI Trusted Publishers

For **each** of `deepfreeze-core`, `deepfreeze-cli`, `deepfreeze-server`, at
`https://pypi.org/manage/project/<name>/settings/publishing/` (or a *pending*
publisher at https://pypi.org/manage/account/publishing/ for a project that
does not exist yet), add a GitHub publisher with **exactly**:

| Field | Value |
|---|---|
| Owner | `elastic` |
| Repository name | `deepfreeze` |
| Workflow name | `release.yml` |
| Environment name | `pypi` |

### GitHub environment

Create an environment named **`pypi`** in repo Settings → Environments. Optional
but recommended: add required reviewers (the publish job then pauses for
approval) and restrict deployments to `v*` tags.

### Actions permissions

Settings → Actions → General must allow the actions the workflow uses. If the
org enables **"Require actions to be pinned to a full-length commit SHA"**, pin
every `uses:` in the workflow to a SHA.

## Versioning

Versions are **not** locked in step across packages. Each package carries its
own version in two places that must agree:

- `packages/<pkg>/pyproject.toml` → `version` (this is what actually gets built)
- `packages/<pkg>/<module>/__init__.py` → `__version__`

`validate-versions` enforces that per-package agreement, and that the git tag
matches at least one package's version. The publish step uses
`skip-existing: true`, so packages already on PyPI at their current version are
skipped rather than failing the run.

**Practical effect:** bump only the package(s) you changed. Unchanged packages
keep their published version and are skipped automatically. Tag with the version
of the package you're releasing (if several change together, give them the same
version and tag that).

## Cutting a release

1. Land your changes on `main` (via PR).
2. Bump the changed package(s) — `pyproject.toml` **and** `__init__.py` — to the
   new version. Keep them equal within a package.
3. Tag and push:

   ```bash
   git fetch upstream
   git tag vX.Y.Z upstream/main
   git push upstream vX.Y.Z
   ```

4. Watch **Actions → Release**:
   - `validate-versions` → per-package consistency + tag check
   - `build` → sdists + wheels for all three
   - `publish-pypi` → OIDC upload (approve the deployment if the `pypi`
     environment has required reviewers)
   - `github-release` → GitHub Release with generated notes

5. Verify on PyPI, e.g. `https://pypi.org/project/deepfreeze-core/X.Y.Z/`.

## Notes

- A version can never be re-uploaded to PyPI. If a publish partially fails,
  bump to the next patch rather than retrying the same version.
- The packages are licensed under the **Elastic License 2.0**
  (`license = "Elastic-2.0"`); each package bundles a copy of `LICENSE`.
