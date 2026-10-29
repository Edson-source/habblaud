import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../shared/agent-events';
import {
  deriveExternalAgentPresence,
  externalAgentCompletionEvents,
  ExternalAgentCharacters,
  externalAgentsInRect,
  EXTERNAL_IDLE_LOUNGE_MS,
  EXTERNAL_IDLE_WANDER_MS,
  EXTERNAL_TERMINAL_INDICATOR_MS,
  externalAgentBubbleText,
  externalIdleVisual,
  hasConfirmedExternalAgentPresence,
} from '../world/external-agents';
import * as art from '../art';
import { assembleBuilding } from '../world/layout/building';
import { ExternalAgentWallet } from './external-agents';

const requestId = 'f78c4d01-ae91-48b4-9cbe-90794ec26757';
const received: AgentEvent = {
  schema_version: 1,
  event_id: '39b957e3-bb75-40b6-b0d3-c2a36f8f6f57',
  request_id: requestId,
  occurred_at: '2026-10-29T17:00:00Z',
  source: 'discord',
  type: 'request_received',
  agent: 'bmo',
  summary: 'BMO recebeu uma solicitação.',
};

function event(type: AgentEvent['type'], agent: AgentEvent['agent'], second: number, extra: Partial<AgentEvent> = {}): AgentEvent {
  return {
    ...received,
    event_id: `39b957e3-bb75-40b6-b0d3-c2a36f8f6f5${second}`,
    occurred_at: `2026-10-29T17:00:${String(second).padStart(2, '0')}Z`,
    type,
    agent,
    summary: type,
    ...extra,
  };
}

describe('presença dos agentes externos', () => {
  it('não presume que agentes sem eventos estejam ociosos', () => {
    expect(deriveExternalAgentPresence([]).map((presence) => presence.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(deriveExternalAgentPresence([]).map((presence) => presence.agent)).toEqual(['bmo', 'hermes', 'claw']);
    expect(hasConfirmedExternalAgentPresence([])).toBe(false);
    expect(hasConfirmedExternalAgentPresence([received])).toBe(true);
  });

  it('considera personagens externos dentro dos limites de uma sala para iluminação por presença', () => {
    const area = { x: 10, y: 4, w: 6, h: 5 };
    expect(externalAgentsInRect([{ tx: 12, ty: 6 }], area)).toBe(true);
    expect(externalAgentsInRect([{ tx: 16, ty: 6 }], area)).toBe(false);
    expect(externalAgentsInRect([], area)).toBe(false);
  });

  it('recompensa apenas conclusões confirmadas do agente correspondente', () => {
    const events = [
      event('agent_started', 'hermes', 1),
      event('agent_completed', 'hermes', 2),
      event('agent_completed', 'claw', 3),
    ];
    expect(externalAgentCompletionEvents(events, 'hermes')).toEqual([events[1]]);
  });

  it('mantém a carteira cosmética local e não duplica o mesmo evento', () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    };
    const completion = event('agent_completed', 'hermes', 1);
    const wallet = new ExternalAgentWallet(storage);
    wallet.sync([completion]);
    wallet.sync([completion]);
    expect(wallet.balance('hermes')).toBe(10);
    expect(new ExternalAgentWallet(storage).balance('hermes')).toBe(10);
  });

  it('separa roteamento confirmado de início real de execução', () => {
    const routed = event('route_decided', 'bmo', 1, { target_agent: 'hermes' });
    const presences = deriveExternalAgentPresence([received, routed]);
    expect(presences.find((presence) => presence.agent === 'bmo')?.status).toBe('routing');
    expect(presences.find((presence) => presence.agent === 'hermes')?.status).toBe('routed');
  });

  it('marca o executor como trabalhando e o BMO como aguardando', () => {
    const events = [
      received,
      event('route_decided', 'bmo', 1, { target_agent: 'hermes' }),
      event('agent_started', 'hermes', 2),
    ];
    const presences = deriveExternalAgentPresence(events);
    expect(presences.find((presence) => presence.agent === 'bmo')?.status).toBe('waiting');
    expect(presences.find((presence) => presence.agent === 'hermes')?.status).toBe('working');
  });

  it('representa espera de shell e pedido de ajuda como estados confirmados', () => {
    const presences = deriveExternalAgentPresence([
      event('agent_waiting_shell', 'hermes', 1, { summary: 'Hermes aguarda o shell terminar.' }),
      event('agent_needs_help', 'claw', 2, { summary: 'Claw precisa de ajuda.' }),
    ]);
    expect(presences.find((presence) => presence.agent === 'hermes')?.status).toBe('waiting_shell');
    expect(presences.find((presence) => presence.agent === 'claw')?.status).toBe('needs_help');
  });

  it('distingue as falas de quem encaminha e de quem executa', () => {
    const events = [
      received,
      event('route_decided', 'bmo', 1, { target_agent: 'hermes' }),
      event('agent_started', 'hermes', 2),
    ];
    const presences = deriveExternalAgentPresence(events);
    const bmo = presences.find((presence) => presence.agent === 'bmo')!;
    const hermes = presences.find((presence) => presence.agent === 'hermes')!;
    expect(externalAgentBubbleText(bmo)).toBe('Aguardando retorno de Hermes.');
    expect(externalAgentBubbleText(hermes)).toBe('Estou executando a solicitação.');
    expect(externalAgentBubbleText(bmo)).not.toBe(externalAgentBubbleText(hermes));
  });

  it('usa a conclusão recente em vez de manter um trabalho antigo como estado atual', () => {
    const oldRequest = { ...event('agent_started', 'hermes', 1), request_id: 'old-request' };
    const newRequest = { ...event('agent_completed', 'hermes', 2), request_id: 'new-request' };
    const hermes = deriveExternalAgentPresence([oldRequest, newRequest]).find((presence) => presence.agent === 'hermes')!;
    expect(hermes.status).toBe('completed');
    expect(hermes.lastEvent).toBe(newRequest);
    expect(externalAgentBubbleText(hermes)).toBe('Concluí a tarefa.');
  });

  it('remove o ícone de conclusão após quatro segundos', () => {
    const completed = event('agent_completed', 'hermes', 1);
    const characters = new ExternalAgentCharacters(art, assembleBuilding(2, []).grid);
    characters.setPresence(deriveExternalAgentPresence([completed]));
    const hermes = characters.characters.find((character) => character.agent === 'hermes')!;
    const at = Date.parse(completed.occurred_at);
    expect(characters.icon(hermes, at + EXTERNAL_TERMINAL_INDICATOR_MS - 1)).toBe('check');
    expect(characters.icon(hermes, at + EXTERNAL_TERMINAL_INDICATOR_MS)).toBeNull();
  });

  it('inicia passeio e lounge somente após conclusão confirmada e nos limites definidos', () => {
    const completed = event('agent_completed', 'hermes', 2);
    const presence = deriveExternalAgentPresence([completed]).find((item) => item.agent === 'hermes')!;
    const at = Date.parse(completed.occurred_at);
    expect(presence.idleSince).toBe(at);
    expect(externalIdleVisual(presence, at + EXTERNAL_IDLE_WANDER_MS - 1)).toBe('stationary');
    expect(externalIdleVisual(presence, at + EXTERNAL_IDLE_WANDER_MS)).toBe('wandering');
    expect(externalIdleVisual(presence, at + EXTERNAL_IDLE_LOUNGE_MS - 1)).toBe('wandering');
    expect(externalIdleVisual(presence, at + EXTERNAL_IDLE_LOUNGE_MS)).toBe('lounging');
  });

  it('não transforma uma falha de despacho em ociosidade conhecida', () => {
    const failed = event('dispatch_failed', 'bmo', 1, { target_agent: 'claw' });
    const presences = deriveExternalAgentPresence([failed]);
    const claw = presences.find((presence) => presence.agent === 'claw')!;
    expect(claw.status).toBe('dispatch_uncertain');
    expect(externalIdleVisual(claw, Date.parse(failed.occurred_at) + EXTERNAL_IDLE_LOUNGE_MS)).toBe('stationary');
  });

  it('encaminha os três personagens externos pelo prédio sem adicioná-los à simulação', () => {
    const characters = new ExternalAgentCharacters(art, assembleBuilding(2, []).grid);
    characters.setPresence(deriveExternalAgentPresence([
      event('agent_started', 'bmo', 1),
      event('agent_started', 'hermes', 2),
      event('agent_started', 'claw', 3),
    ]));
    for (let frame = 0; frame < 1_000; frame++) {
      characters.update(1 / 30, Date.parse(received.occurred_at));
    }
    for (const character of characters.characters) {
      expect(Number.isFinite(character.x) && Number.isFinite(character.y)).toBe(true);
      expect(character.pathIndex * 2).toBeGreaterThanOrEqual(character.path.length);
      expect(character.pose).toBe('read');
    }
  });

  it('encaminha agentes em execução para assentos de trabalho distintos', () => {
    const layout = assembleBuilding(2, []);
    const characters = new ExternalAgentCharacters(art, layout.grid);
    const spots = layout.spots.filter((spot) => ['desk', 'cafe_seat', 'sofa', 'armchair', 'beanbag'].includes(spot.kind));
    characters.setPresence(deriveExternalAgentPresence([
      event('agent_started', 'bmo', 1),
      event('agent_started', 'hermes', 2),
      event('agent_started', 'claw', 3),
    ]));
    for (let frame = 0; frame < 1_000; frame++) characters.update(1 / 30, Date.parse(received.occurred_at), 'normal', spots);
    expect(new Set(characters.characters.map((character) => character.workSpotId)).size).toBe(3);
    for (const character of characters.characters) {
      expect(character.workSpotId).not.toBe('');
      expect(character.seated).toBe(true);
      expect(character.pose).toBe('sit');
      expect(character.sortY).toBe(spots.find((spot) => spot.id === character.workSpotId)?.sortY ?? null);
    }
  });

  it('leva espera de shell e pedido de ajuda a uma estação com pose correspondente', () => {
    const layout = assembleBuilding(2, []);
    const characters = new ExternalAgentCharacters(art, layout.grid);
    const spots = layout.spots.filter((spot) => ['desk', 'cafe_seat', 'sofa', 'armchair', 'beanbag'].includes(spot.kind));
    characters.setPresence(deriveExternalAgentPresence([
      event('agent_waiting_shell', 'hermes', 1),
      event('agent_needs_help', 'claw', 2),
    ]));
    for (let frame = 0; frame < 1_000; frame++) {
      characters.update(1 / 30, Date.parse(received.occurred_at), 'normal', spots);
    }
    const hermes = characters.characters.find((character) => character.agent === 'hermes')!;
    const claw = characters.characters.find((character) => character.agent === 'claw')!;
    expect(hermes.pose).toBe('type');
    expect(hermes.seated).toBe(true);
    expect(claw.pose).toBe('raise_hand');
    expect(claw.seated).toBe(true);
  });

  it('mantém os destinos de passeio caminháveis e os personagens voltados para a câmera', () => {
    const grid = assembleBuilding(2, []).grid;
    const characters = new ExternalAgentCharacters(art, grid);
    const initial = characters.characters.map(({ x, y }) => [x, y]);
    characters.setPresence(deriveExternalAgentPresence([]));
    for (let frame = 0; frame < 600; frame++) characters.update(1 / 30, Date.parse(received.occurred_at) + frame * (1000 / 30));
    for (let i = 0; i < characters.characters.length; i++) {
      const character = characters.characters[i];
      expect(grid.walkable(character.tx, character.ty)).toBe(true);
      expect([character.x, character.y]).not.toEqual(initial[i]);
      expect(character.dir).toBe('down');
    }
  });
});
