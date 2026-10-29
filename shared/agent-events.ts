export const AGENT_EVENT_TYPES = [
  'request_received',
  'route_decided',
  'agent_started',
  'agent_waiting_shell',
  'agent_needs_help',
  'agent_completed',
  'agent_failed',
  'dispatch_failed',
  'response_delivered',
  'response_delivery_failed',
] as const;

export const EXTERNAL_AGENTS = ['bmo', 'hermes', 'claw'] as const;
export const AGENT_EVENT_SOURCES = ['terminal', 'discord', 'esp'] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
export type ExternalAgent = (typeof EXTERNAL_AGENTS)[number];
export type AgentEventSource = (typeof AGENT_EVENT_SOURCES)[number];

export interface AgentEvent {
  schema_version: 1;
  event_id: string;
  request_id: string;
  occurred_at: string;
  source: AgentEventSource;
  type: AgentEventType;
  agent: ExternalAgent;
  target_agent?: ExternalAgent;
  summary: string;
}

const EVENT_KEYS = new Set([
  'schema_version',
  'event_id',
  'request_id',
  'occurred_at',
  'source',
  'type',
  'agent',
  'target_agent',
  'summary',
]);
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/;

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some((key) => !EVENT_KEYS.has(key))) return false;
  if (event.schema_version !== 1) return false;
  if (typeof event.event_id !== 'string' || !UUID.test(event.event_id)) return false;
  if (typeof event.request_id !== 'string' || !UUID.test(event.request_id)) return false;
  if (typeof event.occurred_at !== 'string') return false;
  const timestamp = UTC_TIMESTAMP.exec(event.occurred_at);
  if (!timestamp) return false;
  const occurredAt = new Date(`${timestamp[1]}Z`);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString().slice(0, 19) !== timestamp[1]) return false;
  if (!(AGENT_EVENT_SOURCES as readonly unknown[]).includes(event.source)) return false;
  if (!(AGENT_EVENT_TYPES as readonly unknown[]).includes(event.type)) return false;
  if (!(EXTERNAL_AGENTS as readonly unknown[]).includes(event.agent)) return false;
  if (
    typeof event.summary !== 'string' ||
    [...event.summary].length < 1 ||
    [...event.summary].length > 120 ||
    /[\r\n\t]/.test(event.summary)
  ) return false;

  const targetRequired = event.type === 'route_decided' || event.type === 'dispatch_failed';
  if (targetRequired !== ('target_agent' in event)) return false;
  if (targetRequired && !(EXTERNAL_AGENTS as readonly unknown[]).includes(event.target_agent)) return false;
  if (
    (event.type === 'request_received' ||
      event.type === 'route_decided' ||
      event.type === 'dispatch_failed' ||
      event.type === 'response_delivered' ||
      event.type === 'response_delivery_failed') &&
    event.agent !== 'bmo'
  ) return false;
  return true;
}
