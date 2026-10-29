import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../shared/agent-events';
import { AccountsService } from '../accounts/service';
import { createAgentEventHandler } from '../http/agent-events';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { request } from './permission-server';

const TOKEN = 'test-agent-events-token';
const EVENT: AgentEvent = {
  schema_version: 1,
  event_id: '39b957e3-bb75-40b6-b0d3-c2a36f8f6f57',
  request_id: 'f78c4d01-ae91-48b4-9cbe-90794ec26757',
  occurred_at: '2026-10-29T17:00:00Z',
  source: 'discord',
  type: 'route_decided',
  agent: 'bmo',
  target_agent: 'hermes',
  summary: 'BMO selecionou Hermes para a solicitação.',
};

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

async function serve(token: string | undefined = TOKEN): Promise<{ base: string; hub: Hub }> {
  const office = new Office({
    names: new NameStore(null),
    version: 'test',
    startedAt: Date.now(),
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    terminal: false,
  });
  const hub = new Hub(office);
  const accounts = new AccountsService({ dirs: [], home: '/tmp', env: {}, onChange: () => {} });
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: 'test',
    inDocker: true,
    agentEvents: createAgentEventHandler(hub, token),
  });
  const guard = createRequestGuard();
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://localhost'))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  closeServer = () =>
    new Promise((resolve) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { base: `http://127.0.0.1:${port}`, hub };
}

function initialAgentEvents(base: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let body = '';
    let req: http.ClientRequest | undefined;
    const timer = setTimeout(() => {
      settled = true;
      req?.destroy();
      reject(new Error('SSE did not send the initial agent events.'));
    }, 2_000);
    const request = http.get(new URL('/api/stream', base), (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        const eventFrame = body.split('\n\n').find((frame) => frame.startsWith('event: agent-events\n'));
        if (eventFrame && !settled) {
          settled = true;
          clearTimeout(timer);
          request.destroy();
          resolve(eventFrame);
        }
      });
    });
    req = request;
    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

describe('POST /api/agent-events', () => {
  it('autentica, valida e entrega eventos ao buffer SSE', async () => {
    const s = await serve();
    expect((await request(s.base, '/api/agent-events', { method: 'POST', body: EVENT })).status).toBe(401);
    const accepted = await request(s.base, '/api/agent-events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: EVENT,
    });
    expect(accepted).toMatchObject({ status: 202, json: { accepted: true, event_id: EVENT.event_id } });
    expect(s.hub.recentAgentEvents()).toEqual([EVENT]);
    expect(await initialAgentEvents(s.base)).toContain(EVENT.event_id);
  });

  it('recusa contrato inválido e configuração sem token', async () => {
    const configured = await serve();
    expect(
      await request(configured.base, '/api/agent-events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: { ...EVENT, prompt: 'não deve ser aceito' },
      }),
    ).toMatchObject({ status: 400 });

    await closeServer?.();
    closeServer = undefined;
    const disabled = await serve('');
    expect(
      await request(disabled.base, '/api/agent-events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: EVENT,
      }),
    ).toMatchObject({ status: 503 });
  });

  it('só aceita origem local e método POST', async () => {
    const s = await serve();
    expect(
      await request(s.base, '/api/agent-events', {
        method: 'POST',
        headers: { Host: 'external.example', Authorization: `Bearer ${TOKEN}` },
        body: EVENT,
      }),
    ).toMatchObject({ status: 403 });
    expect((await request(s.base, '/api/agent-events')).status).toBe(405);
  });
});
