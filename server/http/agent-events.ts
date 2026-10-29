import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAgentEvent } from '../../shared/agent-events';
import { errMsg, log } from '../log';
import { HttpError, readJson, sendJson } from './app';
import type { Hub } from './sse';

function hasValidToken(header: string | undefined, expected: string): boolean {
  const [scheme, token, ...extra] = (header ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || extra.length || !expected) return false;
  const received = Buffer.from(token.trim());
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

export function createAgentEventHandler(hub: Hub, token: string | undefined) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!token) {
      req.resume();
      return void sendJson(res, 503, { error: 'Integração de eventos não configurada.' });
    }
    if (!hasValidToken(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined, token)) {
      req.resume();
      return void sendJson(res, 401, { error: 'Token de integração inválido.' });
    }

    try {
      const body = await readJson(req, 2048);
      if (!isAgentEvent(body)) return void sendJson(res, 400, { error: 'Evento fora do contrato v1.' });
      hub.publishAgentEvent(body);
      sendJson(res, 202, { accepted: true, event_id: body.event_id });
    } catch (error) {
      if (error instanceof HttpError) return void sendJson(res, error.status, { error: error.message });
      log.warn(`Erro ao receber evento de agente: ${errMsg(error)}`);
      sendJson(res, 500, { error: 'Erro interno ao receber evento.' });
    }
  };
}
