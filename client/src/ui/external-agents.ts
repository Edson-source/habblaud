import type { AgentEvent, ExternalAgent } from '../../../shared/agent-events';
import {
  deriveExternalAgentPresence,
  EXTERNAL_TASK_REWARD_COINS,
  EXTERNAL_AGENT_IDS,
  externalAgentName,
  externalIdleVisual,
  type ExternalAgentPresence,
  type ExternalAgentStatus,
} from '../world/external-agents';
import { safeLocalStorage } from './prefs';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setText, setTitle } from './dom';
import { formatClock } from './format';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

const AVATARS: Record<ExternalAgent, string> = { bmo: '🤖', hermes: '📚', claw: '🦀' };
const STATUS_LABELS: Record<ExternalAgentStatus, () => string> = {
  unknown: () => tr('Sem evento confirmado'),
  receiving: () => tr('Recebeu uma solicitação'),
  routing: () => tr('Definindo o roteamento'),
  routed: () => tr('Encaminhado; aguardando início confirmado'),
  waiting: () => tr('Aguardando o agente'),
  waiting_shell: () => tr('Esperando o shell'),
  needs_help: () => tr('Precisa de ajuda'),
  working: () => tr('Execução iniciada (confirmada)'),
  completed: () => tr('Execução concluída'),
  failed: () => tr('Falha reportada pelo agente'),
  dispatch_uncertain: () => tr('Falha de comunicação; execução incerta'),
  delivered: () => tr('Resposta entregue'),
  delivery_failed: () => tr('Falha na entrega da resposta'),
};
const EVENT_LABELS: Record<AgentEvent['type'], () => string> = {
  request_received: () => tr('Solicitação recebida'),
  route_decided: () => tr('Roteamento decidido'),
  agent_started: () => tr('Execução iniciada'),
  agent_waiting_shell: () => tr('Esperando o shell'),
  agent_needs_help: () => tr('Pediu ajuda'),
  agent_completed: () => tr('Execução concluída'),
  agent_failed: () => tr('Agente reportou falha'),
  dispatch_failed: () => tr('Falha de comunicação'),
  response_delivered: () => tr('Resposta entregue'),
  response_delivery_failed: () => tr('Falha na entrega da resposta'),
};
const SOURCE_LABELS: Record<AgentEvent['source'], () => string> = {
  terminal: () => tr('Terminal'),
  discord: () => tr('Discord'),
  esp: () => tr('ESP'),
};

const EXTERNAL_WALLET_KEY = 'habblaud:external-agent-wallet:v1';
const WALLET_EVENT_LIMIT = 500;
type WalletCoins = Record<ExternalAgent, number>;

export class ExternalAgentWallet {
  private coins: WalletCoins = { bmo: 0, hermes: 0, claw: 0 };
  private readonly seen = new Set<string>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage()) {
    try {
      const raw = storage?.getItem(EXTERNAL_WALLET_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const value = parsed as { coins?: unknown; eventIds?: unknown };
      if (value.coins && typeof value.coins === 'object') {
        const coins = value.coins as Record<string, unknown>;
        for (const agent of EXTERNAL_AGENT_IDS) {
          if (typeof coins[agent] === 'number' && Number.isFinite(coins[agent]) && coins[agent] >= 0) this.coins[agent] = coins[agent];
        }
      }
      if (Array.isArray(value.eventIds)) {
        for (const id of value.eventIds.slice(-WALLET_EVENT_LIMIT)) if (typeof id === 'string') this.seen.add(id);
      }
    } catch (error) {
      console.warn('[agentes externos] não foi possível restaurar a carteira estética', error);
    }
  }

  sync(events: readonly AgentEvent[]): void {
    let changed = false;
    for (const event of events) {
      if (event.type !== 'agent_completed' || this.seen.has(event.event_id)) continue;
      this.seen.add(event.event_id);
      this.coins[event.agent] += EXTERNAL_TASK_REWARD_COINS;
      changed = true;
    }
    if (!changed) return;
    while (this.seen.size > WALLET_EVENT_LIMIT) this.seen.delete(this.seen.values().next().value!);
    try {
      this.storage?.setItem(EXTERNAL_WALLET_KEY, JSON.stringify({ coins: this.coins, eventIds: [...this.seen] }));
    } catch (error) {
      console.warn('[agentes externos] não foi possível salvar a carteira estética', error);
    }
  }

  balance(agent: ExternalAgent): number {
    return this.coins[agent];
  }
}

export function externalAgentStatusLabel(status: ExternalAgentStatus): string {
  return STATUS_LABELS[status]();
}

function eventLabel(type: AgentEvent['type']): string {
  return EVENT_LABELS[type]();
}

export class ExternalAgentsPanel implements UiComponent {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  private readonly actors = new Map<ExternalAgent, HTMLElement>();
  private readonly statuses = new Map<ExternalAgent, HTMLElement>();
  private readonly cards = new Map<ExternalAgent, HTMLElement>();
  private readonly list: HTMLOListElement;
  private readonly empty: HTMLElement;
  private drawn = '';
  private closedAt = -Infinity;

  constructor(private readonly ctx: UiContext) {
    this.button = iconButton(ICONS.externalAgents, tr('Agentes integrados'), () => this.toggle(), 'ui-ext-agents-btn');
    setAttr(this.button, 'aria-haspopup', 'dialog');
    setAttr(this.button, 'aria-expanded', 'false');

    const close = iconButton(ICONS.close, tr('Fechar agentes integrados'), () => this.hide(), 'ui-icon-btn--sm');
    const map = h(
      'div',
      { class: 'ui-ext__map', attrs: { 'aria-label': tr('Mapa visual dos agentes') } },
      h('span', { class: 'ui-ext__zone ui-ext__zone--office', text: tr('Área de trabalho') }),
      h('span', { class: 'ui-ext__zone ui-ext__zone--lounge', text: tr('Lounge visual') }),
    );
    for (const agent of EXTERNAL_AGENT_IDS) {
      const actor = h(
        'div',
        { class: 'ui-ext__actor is-unknown', attrs: { 'data-agent': agent, 'aria-label': tr('Estado desconhecido') } },
        h('span', { class: 'ui-ext__avatar', text: AVATARS[agent], attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'ui-ext__actor-name', text: externalAgentName(agent) }),
      );
      map.append(actor);
      this.actors.set(agent, actor);
    }
    const cards = h('div', { class: 'ui-ext__agents' });
    for (const agent of EXTERNAL_AGENT_IDS) {
      const status = h('p', { class: 'ui-ext__status', text: tr('Sem evento confirmado') });
      const card = h('article', { class: 'ui-ext__card' }, h('h3', { text: externalAgentName(agent) }), status);
      cards.append(card);
      this.statuses.set(agent, status);
      this.cards.set(agent, card);
    }
    this.empty = h('p', { class: 'ui-ext__empty', text: tr('Os agentes aparecem aqui após o primeiro evento confirmado.') });
    this.list = h('ol', { class: 'ui-ext__events', attrs: { 'aria-label': tr('Últimos eventos confirmados') } });
    this.el = h(
      'section',
      { class: 'ui-popover ui-ext', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Painel de agentes integrados'), id: 'ui-external-agents', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Agentes integrados') }), close),
      h('p', { class: 'ui-ext__note', text: tr('Este painel mostra eventos reais dos agentes, sem criar sessões no escritório.') }),
      map,
      h('p', { class: 'ui-ext__motion-note', text: tr('O deslocamento e o lounge são apenas visuais; não representam trabalho real.') }),
      cards,
      h('h3', { class: 'ui-ext__events-title', text: tr('Últimos eventos confirmados') }),
      this.empty,
      this.list,
    );
    this.el.addEventListener('toggle', () => {
      setAttr(this.button, 'aria-expanded', String(this.isOpen));
      this.button.classList.toggle('is-on', this.isOpen);
      this.ctx.root.classList.toggle('has-popover', this.isOpen);
      if (!this.isOpen) this.closedAt = performance.now();
    });
    this.ctx.store.on('agentEvents', () => this.ctx.invalidate());
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(): void {
    if (this.isOpen) return this.hide();
    if (performance.now() - this.closedAt < 250) return;
    this.show(this.button);
  }

  openAgent(agent: ExternalAgent, opener?: HTMLElement): void {
    this.show(opener ?? this.button);
    requestAnimationFrame(() => this.cards.get(agent)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  private show(opener: HTMLElement): void {
    if (this.isOpen) return;
    const r = opener.getBoundingClientRect();
    this.el.style.bottom = `${Math.max(8, Math.round(innerHeight - r.top + 8))}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    setAttr(this.button, 'aria-expanded', 'true');
    this.button.classList.add('is-on');
    this.ctx.root.classList.add('has-popover');
    this.ctx.invalidate();
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    setAttr(this.button, 'aria-expanded', 'false');
    this.button.classList.remove('is-on');
    this.ctx.root.classList.remove('has-popover');
  }

  render(): void {
    const now = Date.now();
    const presences = deriveExternalAgentPresence(this.ctx.store.agentEvents);
    for (const presence of presences) this.renderAgent(presence, now);
    const events = this.ctx.store.agentEvents.slice(-10).reverse();
    setText(this.empty, events.length ? '' : tr('Os agentes aparecem aqui após o primeiro evento confirmado.'));
    this.empty.hidden = events.length > 0;
    const signature = JSON.stringify(events.map((event) => [event.event_id, event.summary]));
    if (signature === this.drawn) return;
    this.drawn = signature;
    this.list.replaceChildren(...events.map((event) => this.renderEvent(event)));
  }

  private renderAgent(presence: ExternalAgentPresence, now: number): void {
    const actor = this.actors.get(presence.agent)!;
    const status = this.statuses.get(presence.agent)!;
    const visual = externalIdleVisual(presence, now);
    const stage = visual === 'lounging' ? 'is-lounging' : visual === 'wandering' ? 'is-wandering' : '';
    actor.className = `ui-ext__actor is-${presence.status}${stage ? ` ${stage}` : ''}`;
    const accessibleState = visual === 'lounging'
      ? tr('Na área de descanso (visual)')
      : visual === 'wandering'
        ? tr('Passeando (visual)')
        : externalAgentStatusLabel(presence.status);
    setAttr(actor, 'aria-label', `${externalAgentName(presence.agent)}: ${accessibleState}`);
    setTitle(actor, `${externalAgentName(presence.agent)}: ${accessibleState}`);
    setText(status, presence.lastEvent
      ? tr('Último evento: {0}', [formatClock(Date.parse(presence.lastEvent.occurred_at))]) + ` · ${externalAgentStatusLabel(presence.status)}`
      : externalAgentStatusLabel(presence.status));
  }

  private renderEvent(event: AgentEvent): HTMLElement {
    const detail = event.type === 'route_decided' && event.target_agent
      ? `${tr('Destino: {0}', [externalAgentName(event.target_agent)])} · ${event.summary}`
      : event.summary;
    return h(
      'li',
      { class: `ui-ext__event is-${event.type.replaceAll('_', '-')}` },
      h('time', { text: formatClock(Date.parse(event.occurred_at)), attrs: { datetime: event.occurred_at } }),
      h('strong', { text: `${externalAgentName(event.agent)} · ${eventLabel(event.type)}` }),
      h('span', { text: `${SOURCE_LABELS[event.source]()} · ${detail}` }),
    );
  }
}
