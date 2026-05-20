import { schema, TypeOf } from '@kbn/config-schema';
import type { PluginConfigDescriptor } from '@kbn/core/server';

/**
 * Plugin configuration schema, read from `kibana.yml` under the
 * `xpack.deepfreeze.*` namespace (see `kibana.jsonc` → `configPath`).
 *
 * Sensitive values (`aws.accessKeyId`, `aws.secretAccessKey`,
 * `aws.sessionToken`) belong in the Kibana keystore. Non-sensitive
 * values (`aws.region`, `aws.endpoint`, `aws.forcePathStyle`) can sit
 * in `kibana.yml`. Kibana merges keystore + yaml for us; both arrive
 * here as plain fields on the resolved config object.
 */
export const configSchema = schema.object({
  enabled: schema.boolean({ defaultValue: true }),

  telemetry: schema.object({
    enabled: schema.boolean({ defaultValue: false }),
  }),

  /**
   * AWS S3 credentials and connection settings. All fields optional —
   * a missing or partial block leaves the storage adapter in a
   * "not configured" state; the status endpoint still works, it just
   * skips tier sampling.
   */
  aws: schema.object({
    accessKeyId: schema.maybe(schema.string({ minLength: 1 })),
    secretAccessKey: schema.maybe(schema.string({ minLength: 1 })),
    sessionToken: schema.maybe(schema.string({ minLength: 1 })),
    region: schema.maybe(schema.string({ minLength: 1 })),
    /**
     * Custom S3 endpoint override (LocalStack, MinIO, custom domain).
     * Omit for the default AWS endpoint resolution.
     */
    endpoint: schema.maybe(schema.string({ minLength: 1 })),
    /**
     * Force path-style addressing (`https://s3.amazonaws.com/<bucket>/<key>`)
     * instead of virtual-host (`https://<bucket>.s3.amazonaws.com/<key>`).
     * Defaults off; turn on for LocalStack/MinIO.
     */
    forcePathStyle: schema.boolean({ defaultValue: false }),
  }),
});

export type DeepfreezeConfig = TypeOf<typeof configSchema>;

export const config: PluginConfigDescriptor<DeepfreezeConfig> = {
  schema: configSchema,
  exposeToBrowser: {
    enabled: true,
  },
};
