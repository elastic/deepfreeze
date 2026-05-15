/**
 * Event types from the Python server's SSE event bus.
 *
 * Mirrors:
 *   packages/deepfreeze-server/deepfreeze_server/models/events.py
 *
 * NOTE: the Kibana plugin replaces the SSE stream with a Kibana
 * TaskManager-updated saved object that the UI polls. These types are
 * retained for parity reference and for any optional /events compat
 * route the plugin might expose during the migration window. New plugin
 * code should prefer reading the status saved object directly.
 */

export const EVENT_CHANNELS = ['jobs', 'status', 'thaw', 'scheduler'] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export const EVENT_TYPES = [
  'job.started',
  'job.progress',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'status.changed',
  'thaw.completed',
  'scheduler.fired',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface DeepfreezeEvent {
  type: EventType;
  channel: EventChannel;
  data: Record<string, unknown>;
  timestamp: string;
}
