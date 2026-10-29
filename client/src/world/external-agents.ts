import type { AgentEvent, ExternalAgent } from '../../../shared/agent-events';
import type { AppearanceParts } from '../../../shared/appearance';
import type { Appearance, ArtModule, Dir, HeldItem, IconName, Pose } from '../art/api';
import type { SpotDef } from './layout/types';
import { FOOT_DX, FOOT_DY, TILE, WALK_SPEED } from './constants';
import { PathFinder } from './path/astar';
import type { WalkGrid } from './path/grid';
import { dirOf } from './sim/character';
import { pickIdleActivity, type IdleActivity } from './sim/behavior';
import { hasTrait, personaFor, soloWeights } from './social/persona';
import type { SpotRegistry } from './sim/spots';
import { CAFE_ID, LOUNGE_ID } from './layout/core';
import { mulberry32 } from '../../../shared/hash';
import { tr } from '../../../shared/i18n';
import { HOMELAB_ROOM_ID } from './homelab-room';

export const EXTERNAL_IDLE_WANDER_MS = 5 * 60_000;
export const EXTERNAL_IDLE_LOUNGE_MS = 10 * 60_000;
export const EXTERNAL_TASK_REWARD_COINS = 10;
export const EXTERNAL_TERMINAL_INDICATOR_MS = 4_000;
export const EXTERNAL_AGENT_IDS: readonly ExternalAgent[] = ['bmo', 'hermes', 'claw'];
export const EXTERNAL_AGENT_SEEDS: Readonly<Record<ExternalAgent, number>> = { bmo: 70_501, hermes: 481_627, claw: 8_460 };
export const EXTERNAL_AGENT_APPEARANCE: Readonly<Partial<Record<ExternalAgent, { look: 'm'; parts: AppearanceParts }>>> = {
  bmo: {
    look: 'm',
    parts: {
      skin: '#9a6444',
      hair: '#7cc45a',
      hairStyle: 'short',
      top: '#6b4a35',
      topAccent: '#e2604f',
      topStyle: 'jacket',
      accessory: 'none',
      facialHair: 'none',
    },
  },
  claw: {
    look: 'm',
    parts: {
      skin: '#f6cfb0',
      hair: '#f0a24a',
      hairStyle: 'short',
      top: '#f4f4f0',
      topAccent: '#c0392b',
      topStyle: 'shirt_tie',
      accessory: 'none',
      facialHair: 'none',
    },
  },
};

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
  completedTasks?: number;
}

export interface ExternalAgentCardDetails {
  projectPath: string;
  order: string;
  action: string;
  actionIcon: string;
  elapsedMs?: number;
  timerStartedAt?: number;
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
  activity: ExternalIdleActivity | null;
  nextOutingAt: number;
  nextBathroomAt: number;
  activityText: string;
  activityTextUntil: number;
  hidden: boolean;
  activityCount: number;
}

export type ExternalIdleActivityKind = 'coffee' | 'water' | 'snack' | 'bathroom' | 'tv' | 'pingpong' | 'lounge';
type ExternalIdleActivityPhase = 'travel' | 'using' | 'drinking' | 'travel_seat' | 'eating' | 'waiting_group' | 'watching' | 'playing' | 'hidden' | 'washing';

export interface ExternalIdleActivity {
  kind: ExternalIdleActivityKind;
  phase: ExternalIdleActivityPhase;
  spotId: string;
  extraSpotId?: string;
  furnitureId?: string;
  groupId?: string;
  partner?: ExternalAgent;
  startedAt: number;
  until: number;
}

export interface ExternalAgentWalletSnapshot {
  bmo: number;
  hermes: number;
  claw: number;
}

export interface ExternalAgentFacilities {
  spots: SpotRegistry;
  machineUntil: Map<string, number>;
  stallBusy: Set<string>;
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

const EVENT_EMOJI: Record<AgentEvent['type'], string> = {
  request_received: '📨',
  route_decided: '🧭',
  agent_started: '🔎',
  agent_waiting_shell: '⏳',
  agent_needs_help: '🙋',
  agent_completed: '✅',
  agent_failed: '❌',
  dispatch_failed: '⚠️',
  response_delivered: '📤',
  response_delivery_failed: '⚠️',
};

function eventTime(event: AgentEvent | undefined): number | undefined {
  const at = event ? Date.parse(event.occurred_at) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

function latestEvent(events: readonly AgentEvent[]): AgentEvent | undefined {
  return [...events].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0];
}

export function externalAgentCardDetails(
  events: readonly AgentEvent[],
  presence: ExternalAgentPresence,
  now: number,
): ExternalAgentCardDetails {
  const requestId = presence.lastEvent?.request_id;
  const requestEvents = requestId ? events.filter((event) => event.request_id === requestId) : [];
  const orderEvent = requestEvents.find((event) => event.type === 'request_received');
  const order = orderEvent?.summary ?? '';
  const ownEvents = requestEvents.filter((event) => event.agent === presence.agent);
  const actionEvent = latestEvent(ownEvents) ?? presence.lastEvent;
  const started = ownEvents.find((event) => event.type === 'agent_started');
  const requestStarted = orderEvent;
  const timerStartEvent = started ?? (presence.agent === 'bmo' ? requestStarted : undefined);
  const timerStartedAt = eventTime(timerStartEvent);
  const terminalEvent = ownEvents.find((event) => event.type === 'agent_completed' || event.type === 'agent_failed');
  const deliveredEvent = presence.agent === 'bmo'
    ? requestEvents.find((event) => event.type === 'response_delivered' || event.type === 'response_delivery_failed')
    : undefined;
  const endAt = eventTime(deliveredEvent ?? terminalEvent);
  const elapsedMs = timerStartedAt === undefined
    ? undefined
    : Math.max(0, (endAt ?? (['completed', 'failed', 'delivered', 'delivery_failed'].includes(presence.status)
      ? eventTime(presence.lastEvent) ?? now
      : now)) - timerStartedAt);

  const waitingForAgent = presence.status === 'waiting' && presence.lastEvent?.agent !== presence.agent
    ? externalAgentName(presence.lastEvent!.agent)
    : undefined;
  const action = waitingForAgent
    ? tr('Aguardando {0}', [waitingForAgent])
    : presence.status === 'routed'
      ? tr('Aguardando início da execução')
      : actionEvent?.summary ?? '';

  return {
    projectPath: '~/homelab/',
    order,
    action,
    actionIcon: waitingForAgent || presence.status === 'routed' ? '⏳' : actionEvent ? EVENT_EMOJI[actionEvent.type] : '💤',
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(timerStartedAt === undefined ? {} : { timerStartedAt }),
  };
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

function currentPresence(agent: ExternalAgent, requests: Map<string, RequestPresence>, completedTasks: number): ExternalAgentPresence {
  const all = [...requests.values()];
  if (!all.length) return { agent, status: 'unknown', completedTasks };
  const current = all.sort(newest)[0];
  return {
    agent,
    status: current.status,
    lastEvent: current.event,
    completedTasks,
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

  const completedTasks = new Map<ExternalAgent, number>(EXTERNAL_AGENT_IDS.map((agent) => [agent, 0]));
  for (const event of ordered) {
    if (event.type === 'agent_completed') completedTasks.set(event.agent, (completedTasks.get(event.agent) ?? 0) + 1);
  }
  return EXTERNAL_AGENT_IDS.map((agent) => {
    const requests = agent === 'bmo' ? bmoRequests : byAgent.get(agent) ?? requestMap();
    return currentPresence(agent, requests, completedTasks.get(agent) ?? 0);
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

export function externalAgentBubbleText(presence: ExternalAgentPresence, activityText = ''): string {
  const { agent, status, lastEvent } = presence;
  if (activityText) return activityText;
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

function activityGoal(
  character: ExternalAgentCharacter,
  spots: SpotRegistry,
): ExternalAgentGoal | null {
  const activity = character.activity;
  if (!activity) return null;
  const spotId = activity.phase === 'travel_seat' || activity.phase === 'eating' ? activity.extraSpotId : activity.spotId;
  const spot = spots.get(spotId);
  if (!spot) return null;
  const seated = activity.kind === 'tv' || activity.kind === 'lounge' || activity.phase === 'travel_seat' || activity.phase === 'eating';
  let pose: Pose = 'stand';
  let held: HeldItem = 'none';
  if (activity.kind === 'coffee') {
    pose = activity.phase === 'drinking' ? 'drink' : 'use';
    if (activity.phase === 'drinking') held = 'coffee';
  } else if (activity.kind === 'water') {
    pose = activity.phase === 'drinking' ? 'drink' : 'use';
    if (activity.phase === 'drinking') held = 'water';
  } else if (activity.kind === 'snack') {
    pose = activity.phase === 'using' ? 'use' : 'wait';
    if (activity.phase !== 'using') held = 'popcorn';
  } else if (activity.kind === 'bathroom') {
    pose = 'use';
  } else if (activity.kind === 'pingpong') {
    pose = 'play';
    held = 'paddle';
  } else if (activity.kind === 'tv') {
    pose = 'wait';
    held = 'popcorn';
  } else {
    pose = 'sit';
  }
  return {
    key: `outing:${activity.groupId ?? activity.kind}:${activity.phase}:${spot.id}`,
    tile: [spot.tx, spot.ty],
    x: spot.x,
    y: spot.y,
    dir: spot.dir,
    seated,
    sortY: spot.sortY,
    pose,
    held,
  };
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
  private workAreaId = HOMELAB_ROOM_ID;
  private wallet: ExternalAgentWalletSnapshot = { bmo: 0, hermes: 0, claw: 0 };
  private activitySequence = 0;

  constructor(private readonly art: Pick<ArtModule, 'appearanceFromSeed'>, grid: WalkGrid) {
    this.grid = grid;
    this.finder = new PathFinder(grid);
    this.characters = EXTERNAL_AGENT_IDS.map((agent) => {
      const [tx, ty] = HOME[agent];
      return {
        agent,
        id: `external:${agent}`,
        seed: SEEDS[agent],
        appearance: art.appearanceFromSeed(SEEDS[agent], EXTERNAL_AGENT_APPEARANCE[agent]),
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
        activity: null,
        nextOutingAt: 0,
        nextBathroomAt: 0,
        activityText: '',
        activityTextUntil: 0,
        hidden: false,
        activityCount: 0,
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

  setWorkAreaId(areaId: string): void {
    if (areaId === this.workAreaId) return;
    this.workAreaId = areaId;
    for (const character of this.characters) {
      character.workSpotId = '';
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
        character.activityText = '';
        character.activityTextUntil = 0;
        if (['completed', 'delivered'].includes(presence.status) && presence.idleSince !== undefined) {
          character.nextOutingAt = presence.idleSince + 25_000 + (character.seed % 35_000);
          character.nextBathroomAt = presence.idleSince + 60 * 60_000;
        } else {
          character.nextOutingAt = 0;
          character.nextBathroomAt = 0;
        }
      }
      character.presence = presence;
    }
  }

  setWallet(wallet: ExternalAgentWalletSnapshot): void {
    this.wallet = {
      bmo: Math.max(0, Number.isFinite(wallet.bmo) ? wallet.bmo : 0),
      hermes: Math.max(0, Number.isFinite(wallet.hermes) ? wallet.hermes : 0),
      claw: Math.max(0, Number.isFinite(wallet.claw) ? wallet.claw : 0),
    };
  }

  update(
    dt: number,
    now: number,
    liveliness: 'calm' | 'normal' | 'lively' = 'normal',
    availableSpots: readonly SpotDef[] = [],
    facilities?: ExternalAgentFacilities,
  ): void {
    const step = WALK_SPEED * dt;
    const actionInterval = liveliness === 'lively' ? 9_000 : liveliness === 'calm' ? 30_000 : 16_000;
    if (facilities) {
      this.advanceActivities(now, facilities);
      this.startScheduledActivities(now, facilities);
    }
    const assignedSpots = new Set<string>();
    for (const character of this.characters) {
      character.animT += dt * 1000;
      const idle = ['completed', 'delivered'].includes(character.presence.status) && character.presence.idleSince !== undefined;
      if (facilities && !idle && character.activity) this.cancelActivity(character, now, facilities);
      if (character.activity?.phase === 'hidden') continue;
      const roams = character.presence.status === 'unknown' || (idle && externalIdleVisual(character.presence, now) === 'wandering');
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
            .filter((spot) => spot.areaId === this.workAreaId && WORK_SPOT_KINDS.includes(spot.kind) && !assignedSpots.has(spot.id))
            .sort((a, b) => WORK_SPOT_KINDS.indexOf(a.kind) - WORK_SPOT_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));
          workSpot = candidates[EXTERNAL_AGENT_IDS.indexOf(character.agent) % Math.max(1, candidates.length)];
          character.workSpotId = workSpot?.id ?? '';
        }
        if (workSpot) assignedSpots.add(workSpot.id);
      } else {
        character.workSpotId = '';
      }
      const goal = (facilities ? activityGoal(character, facilities.spots) : null)
        ?? goalOf(character.agent, character.presence, now, character.actionIndex, workSpot);
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
    if (facilities) this.activateArrivedActivities(now, facilities);
  }

  private startScheduledActivities(now: number, facilities: ExternalAgentFacilities): void {
    const active = new Set(['receiving', 'routing', 'routed', 'waiting', 'waiting_shell', 'needs_help', 'working']);
    for (const character of this.characters) {
      const idle = ['completed', 'delivered'].includes(character.presence.status) && character.presence.idleSince !== undefined;
      if (!idle) {
        if (character.activity) this.cancelActivity(character, now, facilities);
        continue;
      }
      if (!character.activity && !active.has(character.presence.status) && now >= character.nextOutingAt) {
        this.planOuting(character, now, facilities);
      }
    }
  }

  private planOuting(character: ExternalAgentCharacter, now: number, facilities: ExternalAgentFacilities): void {
    const { spots } = facilities;
    const rng = mulberry32((character.seed + Math.imul(++character.activityCount, 0x9e3779b1)) >>> 0);
    const companion = this.characters.find((other) =>
      other !== character &&
      !other.activity &&
      ['completed', 'delivered'].includes(other.presence.status) &&
      other.presence.idleSince !== undefined,
    );
    const pingPongGroup = companion
      ? spots.findFreeGroup('pingpong', { filter: (group) => group.every((spot) => spots.isFree(spot.id) && spot.areaId === LOUNGE_ID) })
      : null;
    const tvSeats = [...spots.ofKind('sofa'), ...spots.ofKind('armchair')]
      .filter((spot) => spot.areaId === LOUNGE_ID && spot.seated && spots.isFree(spot.id));
    const loungeSeats = [...tvSeats, ...spots.ofKind('beanbag')]
      .filter((spot) => spot.areaId === LOUNGE_ID && spot.seated && spots.isFree(spot.id));
    const cafeSeats = spots.ofKind('cafe_seat').filter((spot) => spot.areaId === CAFE_ID && spots.isFree(spot.id));
    const dueBathroom = character.nextBathroomAt > 0 && now >= character.nextBathroomAt;
    const available: Partial<Record<IdleActivity, boolean>> = {
      coffee: !!spots.findFree('coffee', { by: character.id }),
      water: !!spots.findFree('water', { by: character.id }),
      bathroom: dueBathroom && !!spots.findFree('stall', { by: character.id, filter: (spot) => !!spot.furnitureId }),
      lounge: loungeSeats.length > 0,
      pingpong: !!pingPongGroup,
      snack: cafeSeats.length > 0 && (!!spots.findFree('snack', { by: character.id }) || !!spots.findFree('fridge', { by: character.id })),
    };
    for (const key of ['talk', 'window', 'shelf', 'stretch', 'arcade', 'mirror', 'phone'] as const) available[key] = false;
    const chosen = dueBathroom && available.bathroom
      ? 'bathroom'
      : pickIdleActivity(rng, available, soloWeights(personaFor(character.seed)));
    if (!chosen) {
      character.nextOutingAt = now + 30_000;
      return;
    }
    if (chosen === 'coffee' || chosen === 'water' || chosen === 'snack' || chosen === 'bathroom') {
      const spot = chosen === 'coffee'
        ? spots.findFree('coffee', { near: character, by: character.id, rng })
        : chosen === 'water'
          ? spots.findFree('water', { near: character, by: character.id, rng })
          : chosen === 'bathroom'
            ? spots.findFree('stall', { by: character.id, rng, filter: (candidate) => !!candidate.furnitureId })
            : spots.findFree('snack', { by: character.id, rng }) ?? spots.findFree('fridge', { by: character.id, rng });
      const snackSeat = chosen === 'snack'
        ? spots.findFree('cafe_seat', { near: character, by: character.id, rng, filter: (candidate) => candidate.areaId === CAFE_ID })
        : undefined;
      if (spot && this.startActivity(character, chosen, spot, now, facilities, snackSeat ?? undefined)) {
        this.sayActivity(character, chosen === 'coffee' ? tr('Hora de um café! ☕') : chosen === 'water' ? tr('Vou beber uma água.') : chosen === 'snack' ? tr('Pausa para um lanche!') : tr('Pausa rápida para ir ao banheiro.'), now);
        return;
      }
    } else if (chosen === 'pingpong' && companion && pingPongGroup) {
      this.startPairActivity(character, companion, 'pingpong', pingPongGroup, now, facilities);
      return;
    } else if (chosen === 'lounge') {
      const watch = tvSeats.length > 0 && rng() < 0.7;
      const seats = watch && tvSeats.length >= 2 && companion
        ? tvSeats.slice(0, 2)
        : watch
          ? tvSeats.slice(0, 1)
          : loungeSeats.slice(0, 1);
      if (watch && seats.length > 1 && companion) {
        this.startPairActivity(character, companion, 'tv', seats, now, facilities);
      } else {
        const seat = seats[0];
        if (seat && this.startActivity(character, watch ? 'tv' : 'lounge', seat, now, facilities)) {
          this.sayActivity(character, watch ? tr('Vou assistir um pouco de TV.') : tr('Vou relaxar um pouco no lounge.'), now);
        }
      }
      return;
    }
    character.nextOutingAt = now + 30_000;
  }

  private startPairActivity(
    first: ExternalAgentCharacter,
    second: ExternalAgentCharacter,
    kind: 'tv' | 'pingpong',
    seats: readonly SpotDef[],
    now: number,
    facilities: ExternalAgentFacilities,
  ): void {
    if (seats.length < 2) return;
    const groupId = `external:${kind}:${++this.activitySequence}`;
    if (!facilities.spots.reserve(seats[0].id, first.id)) return;
    if (!facilities.spots.reserve(seats[1].id, second.id)) {
      facilities.spots.release(seats[0].id, first.id);
      return;
    }
    const start = (character: ExternalAgentCharacter, spot: SpotDef, partner: ExternalAgentCharacter) => {
      character.activity = { kind, phase: 'travel', spotId: spot.id, groupId, partner: partner.agent, startedAt: now, until: 0 };
      character.nextOutingAt = 0;
    };
    start(first, seats[0], second);
    start(second, seats[1], first);
    const invite = kind === 'pingpong' ? tr('Quer jogar uma partida de pingue-pongue? 🏓') : tr('Vamos assistir um pouco de TV? 📺');
    const accept = kind === 'pingpong' ? tr('Aceito! 🏓') : tr('Boa ideia! 📺');
    this.sayActivity(first, invite, now);
    this.sayActivity(second, accept, now);
  }

  private startActivity(
    character: ExternalAgentCharacter,
    kind: ExternalIdleActivityKind,
    spot: SpotDef,
    now: number,
    facilities: ExternalAgentFacilities,
    extraSpot?: SpotDef,
  ): boolean {
    if (!facilities.spots.reserve(spot.id, character.id)) return false;
    if (extraSpot && !facilities.spots.reserve(extraSpot.id, character.id)) {
      facilities.spots.release(spot.id, character.id);
      return false;
    }
    character.activity = {
      kind,
      phase: 'travel',
      spotId: spot.id,
      ...(extraSpot ? { extraSpotId: extraSpot.id } : {}),
      ...(spot.furnitureId ? { furnitureId: spot.furnitureId } : {}),
      startedAt: now,
      until: 0,
    };
    character.nextOutingAt = 0;
    return true;
  }

  private advanceActivities(now: number, facilities: ExternalAgentFacilities): void {
    const completedGroups = new Set<string>();
    for (const character of this.characters) {
      const activity = character.activity;
      if (!activity) continue;
      if (!facilities.spots.get(activity.spotId) || (activity.extraSpotId && !facilities.spots.get(activity.extraSpotId))) {
        this.cancelActivity(character, now, facilities);
        continue;
      }
      if (activity.until > 0 && now < activity.until) continue;
      if (activity.phase === 'using') {
        if (activity.kind === 'snack' && activity.extraSpotId) {
          activity.phase = 'travel_seat';
          character.destination = '';
        } else if (activity.kind === 'coffee' || activity.kind === 'water') {
          activity.phase = 'drinking';
          activity.until = now + 3_000;
        } else {
          completedGroups.add(activity.groupId ?? character.id);
        }
      } else if (activity.phase === 'hidden') {
        const areaId = facilities.spots.get(activity.spotId)?.areaId;
        if (activity.furnitureId) facilities.stallBusy.delete(activity.furnitureId);
        facilities.spots.release(activity.spotId, character.id);
        const sink = facilities.spots.findFree('sink', { near: character, by: character.id, filter: (spot) => spot.areaId === areaId && facilities.spots.isFree(spot.id) });
        if (sink && facilities.spots.reserve(sink.id, character.id)) {
          activity.spotId = sink.id;
          activity.furnitureId = undefined;
          activity.phase = 'washing';
          activity.until = 0;
          character.hidden = false;
          character.destination = '';
        } else completedGroups.add(activity.groupId ?? character.id);
      } else if (activity.phase === 'travel_seat' || activity.phase === 'travel') {
        continue;
      } else {
        completedGroups.add(activity.groupId ?? character.id);
      }
    }
    for (const groupId of completedGroups) this.finishActivityGroup(groupId, now, facilities);
  }

  private activateArrivedActivities(now: number, facilities: ExternalAgentFacilities): void {
    const groups = new Map<string, ExternalAgentCharacter[]>();
    for (const character of this.characters) {
      const activity = character.activity;
      if (!activity) continue;
      if (activity.groupId) {
        const group = groups.get(activity.groupId) ?? [];
        group.push(character);
        groups.set(activity.groupId, group);
        continue;
      }
      if (character.pathIndex * 2 < character.path.length) continue;
      if (activity.phase === 'travel') {
        if (activity.kind === 'bathroom') {
          character.hidden = true;
          activity.phase = 'hidden';
          activity.until = now + 6_000;
          if (activity.furnitureId) facilities.stallBusy.add(activity.furnitureId);
          character.nextBathroomAt = now + 60 * 60_000;
        } else if (activity.kind === 'lounge') {
          activity.phase = 'watching';
          activity.until = now + 20_000 + (character.seed % 20_000);
          this.sayActivity(character, tr('Pausa merecida. Já concluí {0} tarefas por aqui.', [character.presence.completedTasks ?? 0]), now);
        } else if (activity.kind === 'tv') {
          activity.phase = 'watching';
          activity.until = now + 35_000;
          this.sayActivity(character, this.tvCommentary(character), now);
        } else {
          activity.phase = 'using';
          activity.until = now + (activity.kind === 'water' ? 900 : 1_700);
          if (activity.kind === 'coffee' && activity.furnitureId) facilities.machineUntil.set(activity.furnitureId, activity.until);
        }
      } else if (activity.phase === 'travel_seat') {
        activity.phase = 'eating';
        activity.until = now + 8_000 + (character.seed % 8_000);
      } else if (activity.phase === 'washing') {
        activity.until = now + 2_000;
      }
    }
    for (const [groupId, members] of groups) {
      if (members.length !== 2 || members.some((member) => member.pathIndex * 2 < member.path.length)) continue;
      for (const member of members) {
        const activity = member.activity!;
        activity.phase = activity.kind === 'pingpong' ? 'playing' : 'watching';
        activity.startedAt = now;
        activity.until = now + (activity.kind === 'pingpong' ? 30_000 : 35_000);
        const goal = activityGoal(member, facilities.spots);
        if (goal) {
          member.pose = goal.pose;
          member.held = goal.held;
          member.seated = goal.seated ?? false;
          member.sortY = goal.sortY ?? null;
        }
      }
      const first = members[0];
      if (first.activity?.kind === 'tv') {
        const commentator = members.find((member) => hasTrait(personaFor(member.seed), 'economia'));
        const speaker = commentator ?? first;
        this.sayActivity(speaker, this.tvCommentary(speaker), now);
      }
      void groupId;
    }
  }

  private tvCommentary(character: ExternalAgentCharacter): string {
    if (hasTrait(personaFor(character.seed), 'economia')) {
      const coins = this.wallet[character.agent];
      const goal = 100 * (1 + ((character.seed >>> 3) % 5));
      return tr('Já juntei {0} moedinhas; minha meta é {1}!', [coins, goal]);
    }
    if (character.presence.completedTasks) {
      return tr('Já concluí {0} tarefas por aqui. Hora de relaxar.', [character.presence.completedTasks]);
    }
    return tr('Uma pausa na TV vai bem. 📺');
  }

  private sayActivity(character: ExternalAgentCharacter, text: string, now: number): void {
    character.activityText = text;
    character.activityTextUntil = now + 5_000;
  }

  private finishActivityGroup(groupId: string, now: number, facilities: ExternalAgentFacilities): void {
    for (const character of this.characters) {
      const activity = character.activity;
      if (!activity || (activity.groupId ?? character.id) !== groupId) continue;
      if (activity.furnitureId) facilities.stallBusy.delete(activity.furnitureId);
      facilities.spots.release(activity.spotId, character.id);
      facilities.spots.release(activity.extraSpotId, character.id);
      character.activity = null;
      character.hidden = false;
      character.destination = '';
      character.nextOutingAt = now + 120_000 + (character.seed % 180_000);
    }
  }

  private cancelActivity(character: ExternalAgentCharacter, now: number, facilities: ExternalAgentFacilities): void {
    const groupId = character.activity?.groupId ?? character.id;
    this.finishActivityGroup(groupId, now, facilities);
    if (!character.activity) {
      character.hidden = false;
      character.destination = '';
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

  tvSeed(): number | null {
    const watcher = this.characters.find((character) => character.activity?.kind === 'tv' && character.activity.phase === 'watching');
    return watcher ? watcher.seed : null;
  }

  pingPongPair(): readonly [ExternalAgentCharacter, ExternalAgentCharacter] | null {
    const players = this.characters.filter((character) => character.activity?.kind === 'pingpong' && character.activity.phase === 'playing');
    return players.length === 2 ? [players[0], players[1]] : null;
  }
}
