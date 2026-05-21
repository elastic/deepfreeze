# AWS credentials for the Kibana plugin

The deepfreeze Kibana plugin makes direct calls to S3 from the Kibana
process (Glacier restore initiation, restore-status polling, per-repo
storage-tier sampling). Elasticsearch already stores credentials for
its own snapshot operations in the ES keystore — but the Kibana process
**cannot read those**. It needs its own credentials.

This document covers every supported method, in priority order. Use
whichever fits your environment.

## How credentials are resolved

The plugin resolves credentials per request, in this order:

1. **Kibana keystore** — `xpack.deepfreeze.aws.accessKeyId` plus
   `xpack.deepfreeze.aws.secretAccessKey` (and optionally
   `xpack.deepfreeze.aws.sessionToken`). When *both* key and secret
   are present in the keystore, the keystore wins outright.
2. **AWS SDK default credential chain** — falls back when the keystore
   entries are absent or incomplete. The chain itself tries, in order:
   1. Environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
      / `AWS_SESSION_TOKEN`).
   2. The shared credentials file (`~/.aws/credentials`) and shared
      config file (`~/.aws/config`), selected by `AWS_PROFILE` if set.
   3. SSO credentials via a profile that uses `sso_*` keys in
      `~/.aws/config`.
   4. Web Identity token (`AssumeRoleWithWebIdentity`) — used by
      EKS IRSA, GitHub Actions OIDC, etc.
   5. ECS task role credentials (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`).
   6. EC2 instance role credentials via IMDS.

The first source that returns a usable identity wins.

Non-secret settings (`region`, `endpoint`, `forcePathStyle`) live in
`kibana.yml`, not the keystore.

---

## Method 1 — Kibana keystore (recommended for production)

Works on every install profile. **Required** on Elastic Cloud, since no
ambient credential sources exist there.

### Self-managed Kibana

From the Kibana install directory:

```sh
# Create the keystore if it doesn't exist yet:
bin/kibana-keystore create

# Add credentials (input is hidden — paste the secret when prompted):
bin/kibana-keystore add xpack.deepfreeze.aws.accessKeyId
bin/kibana-keystore add xpack.deepfreeze.aws.secretAccessKey

# Only for STS / temporary credentials:
bin/kibana-keystore add xpack.deepfreeze.aws.sessionToken

# Verify (lists keys only, never values):
bin/kibana-keystore list
```

**Restart Kibana** after changing the keystore — values are read once at
startup, not on each request.

### Elastic Cloud

1. Open the cloud console → your deployment.
2. **Edit user settings** → **Kibana user settings** → **Kibana keystore**.
3. Add `xpack.deepfreeze.aws.accessKeyId`,
   `xpack.deepfreeze.aws.secretAccessKey`, and (if applicable)
   `xpack.deepfreeze.aws.sessionToken`.
4. Save. Cloud rolls Kibana automatically.

### Non-secret companion settings in `kibana.yml`

```yaml
xpack.deepfreeze.aws.region: us-east-1
# xpack.deepfreeze.aws.endpoint: http://localhost:4566   # LocalStack/MinIO
# xpack.deepfreeze.aws.forcePathStyle: true              # LocalStack/MinIO
```

---

## Method 2 — Environment variables

Useful for local development, CI, and self-managed deployments that already
inject AWS credentials into the process environment. Skipped on Elastic
Cloud (the Kibana process there has no externally-controllable env).

Export before launching Kibana:

```sh
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...   # only for temporary credentials
export AWS_REGION=us-east-1    # SDK default-chain uses this if no region
                               # is set in kibana.yml
yarn start                     # or `bin/kibana`
```

Or via the kibana systemd unit:

```ini
# /etc/systemd/system/kibana.service.d/aws-creds.conf
[Service]
Environment="AWS_ACCESS_KEY_ID=AKIA..."
Environment="AWS_SECRET_ACCESS_KEY=..."
Environment="AWS_REGION=us-east-1"
```

```sh
systemctl daemon-reload && systemctl restart kibana
```

---

## Method 3 — Shared credentials / config file

The plugin honors the standard `~/.aws/credentials` and `~/.aws/config`
files. Pick a profile with `AWS_PROFILE`:

```sh
export AWS_PROFILE=my-deepfreeze-profile
yarn start
```

Example `~/.aws/credentials`:

```ini
[my-deepfreeze-profile]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
region = us-east-1
```

The file must be readable by the user running Kibana.

---

## Method 4 — AWS SSO (`aws configure sso`)

If your organization issues temporary credentials via AWS IAM Identity
Center (formerly AWS SSO), configure a profile and refresh tokens before
starting Kibana:

```sh
aws configure sso          # one-time setup; writes to ~/.aws/config
aws sso login --profile my-sso-profile
export AWS_PROFILE=my-sso-profile
yarn start
```

Kibana picks up the active SSO credentials through the default chain.
SSO tokens expire (default 8h); when they do, run `aws sso login` again
and restart Kibana — currently-cached credentials inside the running
process won't auto-refresh.

---

## Method 5 — EC2 instance role

If Kibana runs on an EC2 instance, attach an IAM role with the required
S3 / Glacier permissions to the instance. No further configuration
required — the SDK fetches credentials from IMDS automatically.

Required IAM permissions for the plugin:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject",
        "s3:RestoreObject"
      ],
      "Resource": [
        "arn:aws:s3:::your-deepfreeze-bucket",
        "arn:aws:s3:::your-deepfreeze-bucket/*"
      ]
    }
  ]
}
```

---

## Method 6 — ECS task role

For Kibana running in ECS / Fargate, attach an IAM role to the task
definition. The SDK reads credentials from
`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (set automatically by the ECS
agent). Same permissions as Method 5.

---

## Method 7 — EKS IRSA (Web Identity)

For Kibana on EKS, configure
[IAM Roles for Service Accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html):

1. Create an IAM role with the permissions above.
2. Annotate the Kibana ServiceAccount with the role ARN.
3. The pod gets `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` env
   vars automatically; the SDK uses them via `AssumeRoleWithWebIdentity`.

No keystore or shared-file configuration required.

---

## Picking a method

| Environment | Recommended | Fallback |
|---|---|---|
| Elastic Cloud | Keystore (Method 1) | — (no ambient sources available) |
| Self-managed, bare-metal/VM | Keystore (Method 1) | EC2 role if applicable (Method 5) |
| Self-managed on EC2 | EC2 role (Method 5) | Keystore (Method 1) |
| Self-managed on ECS/Fargate | ECS task role (Method 6) | — |
| Self-managed on EKS | IRSA (Method 7) | — |
| Local development | SSO profile (Method 4) or env vars (Method 2) | Shared file (Method 3) |
| CI | Env vars (Method 2) | OIDC → Web Identity (Method 7) |

---

## Mirroring credentials from the ES side

ES stores its snapshot-repo credentials in the **ES keystore** under
`s3.client.<name>.access_key` and `s3.client.<name>.secret_key`, where
`<name>` matches the `client` setting on the snapshot repository
(defaults to `default`). The deepfreeze Setup wizard surfaces the
detected client name(s) and shows the exact `kibana-keystore add`
commands you need.

These are two **separate** keystores — values do not propagate between
them. Mirror them deliberately, and rotate them together.

---

## Troubleshooting

### Repositories page shows `N/A` in the Tier column

The plugin tried to call S3 to sample storage classes and failed. Check
the Kibana server log for a line like:

```
Storage-tier sample failed for <repo>: <reason>
```

Common causes:

- **No credentials resolved** — the SDK default chain found nothing.
  Check `bin/kibana-keystore list`, your env vars, and any IAM-role
  metadata. Restart Kibana after changes to the keystore.
- **Region mismatch** — the SDK signs requests for a specific region.
  Set `xpack.deepfreeze.aws.region` in `kibana.yml` to match the
  bucket's region.
- **IAM permission missing** — the role / user needs `s3:ListBucket`
  on the bucket and `s3:GetObject` on its objects. `s3:RestoreObject`
  is also needed for thaw operations.
- **Custom endpoint / path-style** — for LocalStack / MinIO, set
  `xpack.deepfreeze.aws.endpoint` and
  `xpack.deepfreeze.aws.forcePathStyle: true` in `kibana.yml`.

### Setup wizard shows "Detected S3 client name(s): default" but I configured a different client

The wizard reads `settings.client` from existing ES snapshot
repositories. If you previously registered a repo without specifying
`client`, ES defaults it to `"default"`. The displayed name reflects
what ES actually stored, not what you intended — re-register the repo
with the desired `client` setting if needed.

### Credentials change but Kibana keeps using the old ones

Kibana resolves keystore entries once at startup. **Restart Kibana**
after any keystore change. Env-var changes likewise require a process
restart. Credentials cached inside the running process from a previous
SSO login or IMDS fetch won't auto-refresh on rotation — restart to
pick up new values.
