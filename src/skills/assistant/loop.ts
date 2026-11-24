import type { ChatMessage, LlmGateway } from '../../core/llm/types.js';
import { LlmError } from '../../core/llm/types.js';
import type { TurnStatus } from '../../core/contracts/assistant.js';
import type { AwaitOwner, CompletedTool, InProgressTurn, IncomingMessage, LiveHandoff, OutgoingMessage } from '../../core/conversation/types.js';
import type { Logger } from '../../core/log/types.js';
import type { Toolbox } from '../../core/tools/types.js';
import type { AssistantTexts } from './locale.js';
import type { ConversationMemory, MemoryStore } from './memory.js';
import { emptyMemory } from './memory-shape.js';
import type { Plan, PlanNotes } from './plan.js';
import type { PlanOrFailed } from './plan-request.js';
import { PLAN_FAILED, requestPlan } from './plan-request.js';
import { liveHandoffOf } from './live.js';
import type { ToolResult } from './render.js';
import { renderToolResults, textLeaves, wrapData } from './render.js';
import { refsOf, shortResult } from './tool-refs.js';
import { llmErrorText, llmFailure, partialReply, resumeNote } from './turn-failure.js';
import { unrepeat } from './unrepeat.js';

export { overlap } from './unrepeat.js';

const STEP_LIMIT_NOTE =
  'The tool step limit is reached. Answer now using only what you already have; do not call any tools.';
const REFS_NOTE =
  'What tools returned in the last few turns, numbered in the order shown then ("두 번째 거" = #2). Use these ids instead of searching again.';
const INFLIGHT_NOTE =
  'Other messages from the owner in this conversation that are still being answered (oldest first). If the owner asks how one is going, say it is still in progress.';

export interface TurnDeps {
  llm: LlmGateway;
  tools: Toolbox;
  memory: MemoryStore;
  log: Logger;
  texts: AssistantTexts;
  systemPrompt: string;
  maxSteps: number;
  /** Usage and tier routing key: "assistant.turn", or "bot.<id>" in a bot's room (R12: a tier per bot). */
  purpose?: string;
  /** Told before each tool call, for the channel's "working on it" hint. */
  onTool?: (conversation: IncomingMessage['conversation'], tool: string) => void;
  /** Told after each tool that finished, so a restart knows what already ran. */
  onToolDone?: (tool: CompletedTool) => void;
  /** A replay after a restart: these tools already ran and must not run again blindly. */
  resumed?: readonly CompletedTool[];
  /** Other owner messages of this conversation that arrived and are not answered yet (from the router). */
  inProgress?: () => readonly InProgressTurn[];
  /** Confirmation cards of this conversation still waiting for the owner's answer. */
  awaiting?: () => readonly string[];
  /** Lets a tool wait for the owner's card without holding the conversation (from the router). */
  awaitOwner?: AwaitOwner;
  afterTurn?: (work: () => Promise<void>) => void;
  /** What the turn left behind (facts to remember, undecided items); failures never cost the reply. */
  onNotes?: (message: IncomingMessage, notes: PlanNotes) => Promise<void>;
}

export interface ConversationInput {
  message: IncomingMessage;
  memory: ConversationMemory;
  deps: TurnDeps;
}

/** Owner messages of this conversation still waiting or running, not shown yet; marks them shown. */
const AWAITING_NOTE =
  'Confirmation cards in this conversation are open right now, waiting for the owner\'s answer (newest last). A question or "그거" in the owner\'s new message most likely refers to the newest one. The owner answers the card itself; saying "취소해" closes it as a no.';

function inProgressNote(deps: TurnDeps, self: string, shown: Set<string>): ChatMessage | undefined {
  const others = (deps.inProgress?.() ?? []).filter((item) => item.id !== self && !shown.has(item.id));
  if (others.length === 0) return undefined;
  for (const item of others) shown.add(item.id);
  const lines = others.map((item) => `- ${item.at.toISOString().slice(11, 16)} ${item.text.slice(0, 300)}`).join('\n');
  // the owner's own words, so not inside <data> (which the rules say never to follow); only tag-like text is defused
  return { role: 'user', content: `${INFLIGHT_NOTE}\n<owner_messages_in_progress>\n${lines.replace(/</g, '‹')}\n</owner_messages_in_progress>` };
}

function buildMessages(input: ConversationInput, shown: Set<string>): ChatMessage[] {
  const { memory, message, deps } = input;
  const messages: ChatMessage[] = [{ role: 'system', content: deps.systemPrompt }];
  if (memory.summary.length > 0) messages.push({ role: 'user', content: wrapData('memory_summary', memory.summary) });
  const refs = memory.refs.flatMap((turn) => turn.lines);
  if (refs.length > 0) messages.push({ role: 'user', content: `${REFS_NOTE}\n${wrapData('recent_tool_results', refs.join('\n'))}` });
  for (const turn of memory.turns) {
    messages.push({ role: turn.role === 'owner' ? 'user' : 'assistant', content: turn.text });
  }
  const waiting = inProgressNote(deps, message.id, shown);
  if (waiting !== undefined) messages.push(waiting);
  const asked = (deps.awaiting?.() ?? []).map((item) => `- ${item.replace(/\s+/g, ' ').slice(0, 300)}`);
  // "그거 왜 필요해?" while a card is open is about that card, not an older errand
  if (asked.length > 0) messages.push({ role: 'user', content: `${AWAITING_NOTE}\n${wrapData('waiting_for_owner', asked.join('\n'))}` });
  messages.push({ role: 'user', content: message.text });
  if (deps.resumed !== undefined && deps.resumed.length > 0) messages.push({ role: 'user', content: resumeNote(deps.resumed) });
  return messages;
}

interface Conversed {
  plan: PlanOrFailed;
  /** The last page a tool this turn left for the owner to take over. */
  live?: LiveHandoff;
  /** Tools that finished this turn. */
  ran: CompletedTool[];
  /** Compact references from their outputs, kept for the next turns. */
  refs: string[];
  /** The model call that failed after tools had run. */
  failure?: LlmError;
}

async function converse(input: ConversationInput): Promise<Conversed> {
  const { deps, message, memory } = input;
  // Only the owner's words and what tools actually returned may back an action, never the assistant's own earlier text.
  const grounding = [message.text, ...memory.turns.filter((turn) => turn.role === 'owner').map((turn) => turn.text)];
  const toolOutputs: string[] = [];
  const ran: CompletedTool[] = [];
  // actions already done (this turn, or before a restart) by tool and arguments, with why a repeat is refused
  const once = new Map<string, string>((deps.resumed ?? []).filter((tool) => tool.args !== undefined).map((tool) => [`${tool.name}:${tool.args ?? ''}`, 'already done before the restart: not run again']));
  const refs: string[] = [];
  // a message the owner sends while this turn runs is shown at the next step ("아 그건 빼줘")
  const shown = new Set<string>();
  let messages = buildMessages(input, shown);
  let steps = 0;
  let live: LiveHandoff | undefined;
  const done = (plan: PlanOrFailed, failure?: LlmError): Conversed => ({ plan, ran, refs, ...(live !== undefined ? { live } : {}), ...(failure !== undefined ? { failure } : {}) });
  // once tools ran, a failing model call ends the turn with what they did instead of an error alone
  const ask = async (list: readonly ChatMessage[]): Promise<PlanOrFailed | LlmError> => {
    try {
      return await requestPlan(list, deps);
    } catch (error) {
      if (error instanceof LlmError && ran.length > 0) return error;
      throw error;
    }
  };

  for (;;) {
    const plan = await ask(messages);
    if (plan instanceof LlmError) return done(PLAN_FAILED, plan);
    if (plan === PLAN_FAILED || plan.tool_calls.length === 0) return done(await unrepeat(plan, messages, input));

    if (steps >= deps.maxSteps) {
      const final = await ask([...messages, { role: 'user', content: STEP_LIMIT_NOTE }]);
      if (final instanceof LlmError) return done(PLAN_FAILED, final);
      return done(final === PLAN_FAILED ? PLAN_FAILED : { ...final, tool_calls: [] });
    }
    steps += 1;

    const results: ToolResult[] = [];
    for (const call of plan.tool_calls) {
      deps.onTool?.(message.conversation, call.name);
      const effectsOf = deps.tools.list().find((tool) => tool.name === call.name)?.effects ?? [];
      const key = callKey(call.name, call.args);
      // an action that changes something runs once per turn, and never again after a restart replayed the turn
      if (effectsOf.some((effect) => effect !== 'read') && once.has(key)) {
        results.push({ name: call.name, outcome: { status: 'rejected', reason: once.get(key) ?? 'already done' } });
        continue;
      }
      const outcome = await deps.tools.execute(call.name, call.args, {
        grounding: [...grounding, ...toolOutputs],
        ownerGrounding: grounding,
        ...(call.why !== undefined ? { why: call.why } : {}),
        conversation: message.conversation,
        ...(deps.awaitOwner !== undefined ? { awaitOwner: deps.awaitOwner } : {}),
        ...(deps.afterTurn !== undefined ? { afterTurn: deps.afterTurn } : {}),
      });
      results.push({ name: call.name, outcome });
      if (outcome.status === 'done') {
        toolOutputs.push(...textLeaves(outcome.output));
        live = liveHandoffOf(outcome.output) ?? live;
        const effects = effectsOf;
        const finished: CompletedTool = { name: call.name, effects, message: shortResult(outcome.output), args: argsText(call.args) };
        once.set(key, 'already done in this turn: not run again');
        ran.push(finished);
        refs.push(...refsOf(call.name, outcome.output));
        deps.onToolDone?.(finished);
      } else if (outcome.status === 'failed' && /timed out|may not have finished/i.test(outcome.error) && effectsOf.some((effect) => effect === 'send' || effect === 'pay')) {
        // it may have gone through: a retry could send it twice, so the owner checks first
        once.set(key, 'the last try timed out and may have gone through: do not try again; tell the owner to check whether it arrived');
      }
    }

    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(plan) },
      { role: 'user', content: renderToolResults(results) },
    ];
    const arrived = inProgressNote(deps, message.id, shown);
    if (arrived !== undefined) messages.push(arrived);
  }
}

/** Arguments as JSON with sorted keys (the same action written in another key order is the same action), capped. */
function argsText(args: unknown): string {
  const sort = (value: unknown): unknown => (Array.isArray(value) ? value.map(sort) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : value);
  return JSON.stringify(sort(args) ?? null).slice(0, 2000);
}

const callKey = (name: string, args: unknown): string => `${name}:${argsText(args)}`;

function toOutgoing(plan: Plan, texts: AssistantTexts): OutgoingMessage {
  const reply = plan.reply.trim();
  const question = plan.question;
  if (question === null) {
    return { text: reply.length > 0 ? reply : texts.emptyReply };
  }
  const text = reply.length > 0 ? `${reply}\n${question.text.trim()}` : question.text.trim();
  const choices = question.choices.slice(0, 4).map((label) => ({ id: label, label }));
  return { text, choices };
}

async function loadMemory(input: { message: IncomingMessage; deps: TurnDeps }): Promise<ConversationMemory> {
  try {
    return await input.deps.memory.load(input.message.conversation);
  } catch (error) {
    input.deps.log.warn('could not read conversation memory', {
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyMemory();
  }
}

async function remember(message: IncomingMessage, replyText: string, deps: TurnDeps, refs: readonly string[] = []): Promise<void> {
  try {
    await deps.memory.append(message.conversation, message.text, replyText, { refs });
  } catch (error) {
    deps.log.warn('could not save conversation memory', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The reply of a turn that ended without a usable plan: what the tools did, when any ran. */
function failedText(result: Conversed, texts: AssistantTexts): string {
  const cause = result.failure !== undefined ? llmErrorText(result.failure, texts) : undefined;
  if (result.ran.length === 0) return cause ?? texts.invalidPlan;
  return partialReply(result.ran, texts, cause);
}

/** How a turn without a usable plan ended: partial when tools had run, failed otherwise. */
function failedStatus(result: Conversed): TurnStatus {
  const reason = result.failure !== undefined ? llmFailure(result.failure) : 'invalid_plan';
  return { state: result.ran.length > 0 ? 'partial' : 'failed', reason };
}

/** A turn's reply and how it ended; callers decide success from `status`, never from the reply's wording. */
export interface TurnResult {
  reply: OutgoingMessage;
  status: TurnStatus;
}

/** One full assistant turn for an owner message: plan, tools, reply, memory. */
export async function runTurn(message: IncomingMessage, deps: TurnDeps): Promise<TurnResult> {
  const memory = await loadMemory({ message, deps });
  const resumed = (deps.resumed?.length ?? 0) > 0;
  const prefixed = (text: string): string => (resumed ? `${deps.texts.resumed} ${text}` : text);
  try {
    const result = await converse({ message, memory, deps });
    const { plan, live } = result;
    const base = plan === PLAN_FAILED ? { text: failedText(result, deps.texts) } : toOutgoing(plan, deps.texts);
    const shown: OutgoingMessage = { ...base, text: prefixed(base.text) };
    const outgoing: OutgoingMessage = live !== undefined ? { ...shown, live } : shown;
    await remember(message, outgoing.text, deps, result.refs);
    if (plan !== PLAN_FAILED && plan.notes !== undefined && deps.onNotes !== undefined) {
      await deps.onNotes(message, plan.notes).catch((error: unknown) => deps.log.warn('could not keep the turn notes', { error: error instanceof Error ? error.message : String(error) }));
    }
    return { reply: outgoing, status: plan === PLAN_FAILED ? failedStatus(result) : { state: 'completed' } };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    const text = prefixed(llmErrorText(error, deps.texts));
    await remember(message, text, deps);
    return { reply: { text }, status: { state: 'failed', reason: llmFailure(error) } };
  }
}
