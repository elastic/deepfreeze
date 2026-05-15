import { schema, TypeOf } from '@kbn/config-schema';
import type { PluginConfigDescriptor } from '@kbn/core/server';

/**
 * Plugin configuration schema, read from `kibana.yml` under the
 * `deepfreeze.*` namespace (see `kibana.jsonc` → `configPath`).
 *
 * Sensitive values (cloud-storage credentials, etc.) belong in the
 * Kibana keystore, not in `kibana.yml`. This schema deliberately does
 * not accept secrets as plain config keys.
 */
export const configSchema = schema.object({
  enabled: schema.boolean({ defaultValue: true }),

  /**
   * Whether to emit anonymized usage telemetry. Default off — opt-in
   * (the plan locks this in for Phase 1).
   */
  telemetry: schema.object({
    enabled: schema.boolean({ defaultValue: false }),
  }),
});

export type DeepfreezeConfig = TypeOf<typeof configSchema>;

export const config: PluginConfigDescriptor<DeepfreezeConfig> = {
  schema: configSchema,
  exposeToBrowser: {
    enabled: true,
  },
};
