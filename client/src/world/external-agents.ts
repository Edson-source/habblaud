import type { AgentEvent, ExternalAgent } from '../../../shared/agent-events';
import type { Appearance, ArtModule, Dir, HeldItem, IconName, Pose } from '../art/api';
import type { SpotDef } from './layout/types';
import { FOOT_DX, FOOT_DY, TILE, WALK_SPEED } from './constants';
import { PathFinder } from './path/astar';
import type { WalkGrid } from './path/grid';
import { dirOf } from './sim/character';
import { tr } from '../../../shared/i18n';

export const EXTERNAL_IDLE_WANDER_MS = 5 * 60_000;
export const EXTERNAL_IDLE_LOUNGE_MS = 10 * 60_000;
export const EXTERNAL_TASK_REWARD_COINS = 10;
export const EXTERNAL_TERMINAL_INDICATOR_MS = 4_000;
export const EXTERNAL_AGENT_IDS: readonly ExternalAgent[] = ['bmo', 'hermes', 'claw'];
export const EXTERNAL_AGENT_SEEDS: Readonly<Record<ExternalAgent, number>> = { bmo: 739_391, hermes: 481_627, claw: 928_451 };

export type ExternalAgentStatus =
  | 'unknown'
  | 'receiving'
  | 'routing'
  | 'routed'
  | 'waiting'
  | 'waiting_shell'
  | 'needs_help'
  | 'working'
  | 'completed'
  | 'failed'
  | 'dispatch_uncertain'
  | 'delivered'
  | 'delivery_failed';

export interface ExternalAgentPresence {
  agent: ExternalAgent;
  status: ExternalAgentStatus;
  lastEvent?: AgentEvent;
  idleSince?: number;
}

export type ExternalIdleVisual = 'stationary' | 'wandering' | 'lounging';

interface RequestPresence {
  status: ExternalAgentStatus;
  event: AgentEvent;
  idleSince?: number;
}

export interface ExternalAgentGoal {
  key: string;
  tile: readonly [number, number];
  pose: Pose;
  held: HeldItem;
  dir?: Dir;
  x?: number;
  y?: number;
  seated?: boolean;
  sortY?: number;
}

export interface ExternalAgentCharacter {
  readonly agent: ExternalAgent;
  readonly id: string;
  readonly seed: number;
  readonly appearance: Appearance;
  presence: ExternalAgentPresence;
  x: number;
  y: number;
  tx: number;
  ty: number;
  dir: Dir;
  pose: Pose;
  held: HeldItem;
  seated: boolean;
  sortY: number | null;
  animT: number;
  path: number[];
  pathIndex: number;
  destination: string;
  actionIndex: number;
  nextActionAt: number;
  lastEventId: string;
  workSpotId: string;
}

export function externalAgentsInRect(
  agents: readonly Pick<ExternalAgentCharacter, 'tx' | 'ty'>[],
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  return agents.some((agent) => agent.tx >= rect.x && agent.ty >= rect.y && agent.tx < rect.x + rect.w && agent.ty < rect.y + rect.h);
}

export function externalAgentCompletionEvents(events: readonly AgentEvent[], agent: ExternalAgent): AgentEvent[] {
  return events.filter((event) => event.agent === agent && event.type === 'agent_completed');
}

const LABELS: Record<ExternalAgent, string> = { bmo: 'BMO', hermes: 'Hermes', claw: 'Claw' };
const SEEDS = EXTERNAL_AGENT_SEEDS;
const HOME: Record<ExternalAgent, readonly [number, number]> = {
  bmo: [6, 8],
  hermes: [22, 23],
  claw: [27, 7],
};
const WORK: Record<ExternalAgent, readonly [number, number]> = {
  bmo: [6, 8],
  hermes: [22, 23],
  claw: [27, 7],
};
const LOUNGE: Record<ExternalAgent, readonly [number, number]> = {
  bmo: [8, 22],
  hermes: [22, 22],
  claw: [24, 22],
};
const WORK_CYCLE: Record<ExternalAgent, readonly (readonly [number, number])[]> = {
  bmo: [[8, 14], [12, 14]],
  hermes: [[22, 14], [25, 14]],
  claw: [[12, 14], [22, 14], [25, 14]],
};
const WANDER_CYCLE: Record<ExternalAgent, readonly (readonly [number, number])[]> = {
  bmo: [[6, 8], [7, 5], [2, 8]],
  hermes: [[22, 23], [25, 23], [27, 19]],
  claw: [[27, 7], [29, 8], [22, 10]],
};
const WORK_SPOT_KINDS: readonly SpotDef['kind'][] = ['desk', 'cafe_seat', 'sofa', 'armchair', 'beanbag'];

function requestMap(): Map<string, RequestPresence> {
  return new Map();
}

function setRequest(
  requests: Map<ExternalAgent, Map<string, RequestPresence>>,
  agent: ExternalAgent,
  requestId: string,
  status: ExternalAgentStatus,
  event: AgentEvent,
  idleSince?: number,
): void {
  let byRequest = requests.get(agent);
  if (!byRequest) requests.set(agent, (byRequest = requestMap()));
  byRequest.set(requestId, { status, event, ...(idleSince === undefined ? {} : { idleSince }) });
}

function newest(a: RequestPresence, b: RequestPresence): number {
  return Date.parse(b.event.occurred_at) - Date.parse(a.event.occurred_at);
}

function currentPresence(agent: ExternalAgent, requests: Map<string, RequestPresence>): ExternalAgentPresence {
  const all = [...requests.values()];
  if (!all.length) return { agent, status: 'unknown' };
  const current = all.sort(newest)[0];
  return {
    agent,
    status: current.status,
    lastEvent: current.event,
    ...(current.idleSince === undefined ? {} : { idleSince: current.idleSince }),
  };
}

/** Deriva apenas estados sustentados pelo contrato; não presume que ausência de eventos significa ociosidade. */
export function deriveExternalAgentPresence(events: readonly AgentEvent[]): ExternalAgentPresence[] {
  const byAgent = new Map<ExternalAgent, Map<string, RequestPresence>>();
  const bmoRequests = new Map<string, RequestPresence>();
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => Date.parse(a.event.occurred_at) - Date.parse(b.event.occurred_at) || a.index - b.index)
    .map(({ event }) => event);

  for (const event of ordered) {
    const at = Date.parse(event.occurred_at);
    switch (event.type) {
      case 'request_received':
        setRequest(byAgent, 'bmo', event.request_id, 'receiving', event);
        bmoRequests.set(event.request_id, { status: 'receiving', event });
        break;
      case 'route_decided':
        setRequest(byAgent, 'bmo', event.request_id, 'routing', event);
        bmoRequests.set(event.request_id, { status: 'routing', event });
        setRequest(byAgent, event.target_agent!, event.request_id, 'routed', event);
        break;
      case 'agent_started': {
        setRequest(byAgent, event.agent, event.request_id, 'working', event);
        if (event.agent === 'bmo') bmoRequests.set(event.request_id, { status: 'working', event });
        else if (bmoRequests.get(event.request_id)?.status === 'routing') {
          bmoRequests.set(event.request_id, { status: 'waiting', event });
        }
        break;
      }
      case 'agent_waiting_shell':
        setRequest(byAgent, event.agent, event.request_id, 'waiting_shell', event);
        break;
      case 'agent_needs_help':
        setRequest(byAgent, event.agent, event.request_id, 'needs_help', event);
        break;
      case 'agent_completed':
        setRequest(byAgent, event.agent, event.request_id, 'completed', event, at);
        if (event.agent === 'bmo') bmoRequests.set(event.request_id, { status: 'completed', event, idleSince: at });
        else if (bmoRequests.get(event.request_id)?.status === 'routing') {
          bmoRequests.set(event.request_id, { status: 'waiting', event });
        }
        break;
      case 'agent_failed':
        setRequest(byAgent, event.agent, event.request_id, 'failed', event);
        if (event.agent !== 'bmo' && bmoRequests.get(event.request_id)?.status === 'routing') {
          bmoRequests.set(event.request_id, { status: 'waiting', event });
        }
        break;
      case 'dispatch_failed':
        setRequest(byAgent, 'bmo', event.request_id, 'dispatch_uncertain', event);
        setRequest(byAgent, event.target_agent!, event.request_id, 'dispatch_uncertain', event);
        bmoRequests.set(event.request_id, { status: 'dispatch_uncertain', event });
        break;
      case 'response_delivered':
        setRequest(byAgent, 'bmo', event.request_id, 'delivered', event, at);
        bmoRequests.set(event.request_id, { status: 'delivered', event, idleSince: at });
        break;
      case 'response_delivery_failed':
        setRequest(byAgent, 'bmo', event.request_id, 'delivery_failed', event);
        bmoRequests.set(event.request_id, { status: 'delivery_failed', event });
        break;
    }
  }

  return EXTERNAL_AGENT_IDS.map((agent) => {
    const requests = agent === 'bmo' ? bmoRequests : byAgent.get(agent) ?? requestMap();
    return currentPresence(agent, requests);
  });
}

export function hasConfirmedExternalAgentPresence(events: readonly AgentEvent[]): boolean {
  return deriveExternalAgentPresence(events).some((presence) => presence.status !== 'unknown');
}

export function externalIdleVisual(presence: ExternalAgentPresence, now: number): ExternalIdleVisual {
  if (presence.idleSince === undefined || !['completed', 'delivered'].includes(presence.status)) return 'stationary';
  const idleFor = Math.max(0, now - presence.idleSince);
  if (idleFor >= EXTERNAL_IDLE_LOUNGE_MS) return 'lounging';
  if (idleFor >= EXTERNAL_IDLE_WANDER_MS) return 'wandering';
  return 'stationary';
}

export function externalAgentName(agent: ExternalAgent): string {
  return LABELS[agent];
}

export function externalAgentFromId(id: string): ExternalAgent | undefined {
  return EXTERNAL_AGENT_IDS.find((agent) => id === `external:${agent}`);
}

export function externalAgentBubbleText(presence: ExternalAgentPresence): string {
  const { agent, status, lastEvent } = presence;
  if (status === 'waiting_shell') return lastEvent?.summary ?? tr('Aguardando o shell terminar.');
  if (status === 'needs_help') return lastEvent?.summary ?? tr('Preciso de ajuda.');
  if (agent === 'bmo') {
    if (status === 'receiving') return tr('Recebi sua solicitação.');
    if (status === 'routing' && lastEvent?.target_agent) return tr('Vou encaminhar para {0}.', [externalAgentName(lastEvent.target_agent)]);
    if (status === 'waiting' && lastEvent && lastEvent.agent !== 'bmo') return tr('Aguardando retorno de {0}.', [externalAgentName(lastEvent.agent)]);
    if (status === 'delivered') return tr('Resposta enviada.');
  } else {
    if (status === 'routed') return tr('Recebi o encaminhamento do BMO.');
    if (status === 'working') return tr('Estou executando a solicitação.');
    if (status === 'completed') return tr('Concluí a tarefa.');
    if (status === 'waiting') return tr('Aguardando instruções do BMO.');
  }
  if (status === 'failed' || status === 'delivery_failed') return tr('Falha reportada; consulte o registro.');
  if (status === 'dispatch_uncertain') return tr('Encaminhamento incerto; consulte o registro.');
  return lastEvent?.summary ?? '';
}

function goalOf(
  agent: ExternalAgent,
  presence: ExternalAgentPresence,
  now: number,
  actionIndex: number,
  workSpot?: SpotDef,
): ExternalAgentGoal {
  const visual = externalIdleVisual(presence, now);
  if (visual === 'lounging') return { key: 'lounge', tile: LOUNGE[agent], pose: 'sit', held: 'none' };
  if (['working', 'waiting_shell', 'needs_help'].includes(presence.status)) {
    if (workSpot) {
      const pose = presence.status === 'waiting_shell' ? 'type' : presence.status === 'needs_help' ? 'raise_hand' : workSpot.seated ? 'sit' : 'read';
      return {
        key: `working:${workSpot.id}`,
        tile: [workSpot.tx, workSpot.ty],
        x: workSpot.x,
        y: workSpot.y,
        dir: workSpot.dir,
        seated: workSpot.seated,
        sortY: workSpot.sortY,
        pose,
        held: presence.status === 'needs_help' ? 'none' : agent === 'hermes' ? 'book' : agent === 'claw' ? 'papers' : 'laptop',
      };
    }
    const cycle = WORK_CYCLE[agent];
    return { key: `working-${actionIndex}`, tile: cycle[actionIndex % cycle.length], pose: 'read', held: agent === 'hermes' ? 'book' : agent === 'claw' ? 'papers' : 'laptop' };
  }
  if (presence.status === 'unknown' || visual === 'wandering') {
    const cycle = WANDER_CYCLE[agent];
    return { key: `wander-${actionIndex}`, tile: cycle[actionIndex % cycle.length], pose: 'stand', held: 'none' };
  }
  if (['receiving', 'routing', 'delivered'].includes(presence.status) && agent === 'bmo') {
    return { key: presence.status, tile: WORK.bmo, pose: 'stand', held: 'none' };
  }
  if (presence.status === 'waiting' && agent === 'bmo') return { key: 'waiting', tile: HOME.bmo, pose: 'stand', held: 'none' };
  if (presence.status === 'routed' || presence.status === 'waiting') {
    return { key: presence.status, tile: WORK[agent], pose: 'stand', held: 'none' };
  }
  return { key: 'home', tile: HOME[agent], pose: 'stand', held: 'none' };
}

function iconForStatus(status: ExternalAgentStatus): IconName | null {
  if (status === 'working') return 'idea';
  if (status === 'completed' || status === 'delivered') return 'check';
  if (status === 'failed' || status === 'dispatch_uncertain' || status === 'delivery_failed') return 'sweat';
  if (status === 'waiting_shell') return 'hourglass';
  if (status === 'needs_help') return 'alert';
  if (status === 'routed' || status === 'waiting') return 'box';
  if (status === 'receiving' || status === 'routing') return 'question';
  return null;
}

/** Personagens visuais locais: não pertencem a snapshots, sessões ou ao Habblaud World. */
export class ExternalAgentCharacters {
  readonly characters: ExternalAgentCharacter[];
  private readonly finder: PathFinder;
  private grid: WalkGrid;

  constructor(private readonly art: Pick<ArtModule, 'appearanceFromSeed'>, grid: WalkGrid) {
    this.grid = grid;
    this.finder = new PathFinder(grid);
    this.characters = EXTERNAL_AGENT_IDS.map((agent) => {
      const [tx, ty] = HOME[agent];
      return {
        agent,
        id: `external:${agent}`,
        seed: SEEDS[agent],
        appearance: art.appearanceFromSeed(SEEDS[agent]),
        presence: { agent, status: 'unknown' },
        x: tx * TILE + FOOT_DX,
        y: ty * TILE + FOOT_DY,
        tx,
        ty,
        dir: 'down',
        pose: 'stand',
        held: 'none',
        seated: false,
        sortY: null,
        animT: 0,
        path: [],
        pathIndex: 0,
        destination: '',
        actionIndex: 0,
        nextActionAt: 0,
        lastEventId: '',
        workSpotId: '',
      };
    });
  }

  setGrid(grid: WalkGrid): void {
    if (grid === this.grid) return;
    this.grid = grid;
    this.finder.setGrid(grid);
    for (const character of this.characters) {
      character.path.length = 0;
      character.pathIndex = 0;
      character.destination = '';
    }
  }

  setPresence(presences: readonly ExternalAgentPresence[]): void {
    const incoming = new Map(presences.map((presence) => [presence.agent, presence]));
    for (const character of this.characters) {
      const presence = incoming.get(character.agent) ?? { agent: character.agent, status: 'unknown' };
      const eventId = presence.lastEvent?.event_id ?? '';
      if (eventId !== character.lastEventId) {
        character.lastEventId = eventId;
        character.actionIndex = 0;
        character.nextActionAt = 0;
        character.destination = '';
        character.workSpotId = '';
      }
      character.presence = presence;
    }
  }

  update(
    dt: number,
    now: number,
    liveliness: 'calm' | 'normal' | 'lively' = 'normal',
    availableSpots: readonly SpotDef[] = [],
  ): void {
    const step = WALK_SPEED * dt;
    const actionInterval = liveliness === 'lively' ? 9_000 : liveliness === 'calm' ? 30_000 : 16_000;
    const assignedSpots = new Set<string>();
    for (const character of this.characters) {
      character.animT += dt * 1000;
      const roams = character.presence.status === 'unknown' || externalIdleVisual(character.presence, now) === 'wandering';
      const cyclesWork = character.presence.status === 'working';
      const occupiesWorkSpot = ['working', 'waiting_shell', 'needs_help'].includes(character.presence.status);
      if ((roams || cyclesWork) && character.nextActionAt === 0) {
        character.nextActionAt = now + actionInterval * (0.25 + (character.seed % 4) * 0.1);
      }
      if ((roams || cyclesWork) && character.pathIndex * 2 >= character.path.length && now >= character.nextActionAt) {
        const cycle = cyclesWork ? WORK_CYCLE[character.agent] : WANDER_CYCLE[character.agent];
        character.actionIndex = (character.actionIndex + 1) % cycle.length;
        character.nextActionAt = now + actionInterval;
      }
      let workSpot: SpotDef | undefined;
      if (occupiesWorkSpot) {
        workSpot = availableSpots.find((spot) => spot.id === character.workSpotId);
        if (!workSpot) {
          const candidates = availableSpots
            .filter((spot) => WORK_SPOT_KINDS.includes(spot.kind) && !assignedSpots.has(spot.id))
            .sort((a, b) => WORK_SPOT_KINDS.indexOf(a.kind) - WORK_SPOT_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));
          workSpot = candidates[EXTERNAL_AGENT_IDS.indexOf(character.agent) % Math.max(1, candidates.length)];
          character.workSpotId = workSpot?.id ?? '';
        }
        if (workSpot) assignedSpots.add(workSpot.id);
      } else {
        character.workSpotId = '';
      }
      const goal = goalOf(character.agent, character.presence, now, character.actionIndex, workSpot);
      if (character.pathIndex * 2 >= character.path.length && character.destination !== goal.key) {
        this.plan(character, goal.tile);
        character.destination = goal.key;
      }
      if (character.pathIndex * 2 < character.path.length) {
        const tx = character.path[character.pathIndex * 2];
        const ty = character.path[character.pathIndex * 2 + 1];
        const x = tx * TILE + FOOT_DX;
        const y = ty * TILE + FOOT_DY;
        character.dir = dirOf(x - character.x, y - character.y, character.dir);
        character.pose = 'walk';
        character.held = 'none';
        character.seated = false;
        character.sortY = null;
        const dx = x - character.x;
        const dy = y - character.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= step || distance === 0) {
          character.x = x;
          character.y = y;
          character.tx = tx;
          character.ty = ty;
          character.pathIndex++;
          if (character.pathIndex * 2 >= character.path.length) character.dir = 'down';
        } else {
          character.x += (dx / distance) * step;
          character.y += (dy / distance) * step;
        }
      } else {
        character.x = goal.x ?? character.tx * TILE + FOOT_DX;
        character.y = goal.y ?? character.ty * TILE + FOOT_DY;
        if (goal.dir) character.dir = goal.dir;
        character.pose = goal.pose;
        character.held = goal.held;
        character.seated = goal.seated ?? false;
        character.sortY = goal.sortY ?? null;
      }
    }
  }

  private plan(character: ExternalAgentCharacter, target: readonly [number, number]): void {
    const start = this.grid.nearestWalkable(character.tx, character.ty);
    const end = this.grid.nearestWalkable(target[0], target[1]);
    if (!start || !end || !this.finder.find(start.x, start.y, end.x, end.y, character.path)) {
      character.path.length = 0;
      character.pathIndex = 0;
      return;
    }
    character.pathIndex = 0;
  }

  icon(character: ExternalAgentCharacter, now: number): IconName | null {
    const { presence } = character;
    if (
      ['completed', 'delivered'].includes(presence.status) &&
      presence.lastEvent &&
      now - Date.parse(presence.lastEvent.occurred_at) >= EXTERNAL_TERMINAL_INDICATOR_MS
    ) return null;
    if (presence.status === 'waiting_shell') return Math.floor(now / 500) % 2 ? 'hourglass_flip' : 'hourglass';
    return iconForStatus(presence.status);
  }

  label(agent: ExternalAgent): string {
    return LABELS[agent];
  }
}
