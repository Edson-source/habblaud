import { describe, expect, it } from 'vitest';
import { isAgentEvent, type AgentEvent } from './agent-events';

const base: AgentEvent = {
  schema_version: 1,
  event_id: '39b957e3-bb75-40b6-b0d3-c2a36f8f6f57',
  request_id: 'f78c4d01-ae91-48b4-9cbe-90794ec26757',
  occurred_at: '2026-10-29T17:00:00Z',
  source: 'discord',
  type: 'request_received',
  agent: 'bmo',
  summary: 'BMO recebeu uma solicitação.',
};

describe('agent events contract v1', () => {
  it('accepts each defined event shape', () => {
    const events: AgentEvent[] = [
      base,
      { ...base, type: 'route_decided', target_agent: 'hermes' },
      { ...base, type: 'agent_started', agent: 'hermes' },
      { ...base, type: 'agent_waiting_shell', agent: 'hermes', summary: 'Aguardando shell de pesquisa.' },
      { ...base, type: 'agent_needs_help', agent: 'claw', summary: 'Preciso de ajuda para continuar.' },
      { ...base, type: 'agent_completed', agent: 'hermes' },
      { ...base, type: 'agent_failed', agent: 'claw' },
      { ...base, type: 'dispatch_failed', target_agent: 'hermes' },
      { ...base, type: 'response_delivered' },
      { ...base, type: 'response_delivery_failed' },
    ];
    for (const event of events) expect(isAgentEvent(event)).toBe(true);
  });

  it('rejects invalid routing, private extra fields and malformed metadata', () => {
    expect(isAgentEvent({ ...base, type: 'dispatch_failed' })).toBe(false);
    expect(isAgentEvent({ ...base, type: 'route_decided', agent: 'hermes', target_agent: 'bmo' })).toBe(false);
    expect(isAgentEvent({ ...base, target_agent: 'hermes' })).toBe(false);
    expect(isAgentEvent({ ...base, prompt: 'private user text' })).toBe(false);
    expect(isAgentEvent({ ...base, occurred_at: '2026-10-29T17:00:00+00:00' })).toBe(false);
    expect(isAgentEvent({ ...base, occurred_at: '2026-02-31T17:00:00Z' })).toBe(false);
    expect(isAgentEvent({ ...base, summary: 'linha 1\nlinha 2' })).toBe(false);
    expect(isAgentEvent({ ...base, schema_version: 2 })).toBe(false);
  });
});
