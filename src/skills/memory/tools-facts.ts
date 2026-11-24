import { z } from 'zod';
import type { Fact, FactSourceKind } from '../../core/contracts/memory.js';
import type { Tool } from '../../core/tools/types.js';
import { evidenceFound } from '../../core/time/evidence.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import { isTimeLimited } from './expiry.js';
import type { FactStore } from './facts.js';
import type { MemoryTexts } from './locale.js';
import { personKey } from './people-keys.js';

const EVIDENCE_HINT =
  "Verbatim quote of the owner's words this fact comes from; never paraphrase. It must appear in this turn.";

const END_HINT =
  "Set when the fact only holds for a while ('출시 전', '이번 주까지'): the last valid day, or the event that ends it.";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const rememberInput = z.object({
  text: z.string().min(1).max(300).describe('The fact to keep, as one short sentence.'),
  about: z.string().max(60).optional().describe("'owner' (the default) or a person's name."),
  validUntil: z.string().regex(YMD).optional().describe(END_HINT),
  untilEvent: z.string().max(60).optional().describe(END_HINT),
  evidence: z.string().min(2).max(300).describe(EVIDENCE_HINT),
  standing: z
    .boolean()
    .optional()
    .describe('True for a standing instruction or preference that should apply from now on ("메일은 항상 존댓말로", "회의는 오후로 잡아줘"). It goes with every turn.'),
});

const recallInput = z.object({
  query: z.string().max(300).optional().describe('Words to match; omit to get the strongest facts.'),
  about: z.string().max(60).optional().describe("'owner' (the default) or a person's name."),
  limit: z.number().int().min(1).max(20).default(8).describe('At most 20.'),
});

const forgetInput = z.object({
  id: z.string().min(1).describe('The id returned by memory.recall or memory.remember.'),
});

export type MemoryRememberInput = z.infer<typeof rememberInput>;
export type MemoryRecallInput = z.infer<typeof recallInput>;
export type MemoryForgetInput = z.infer<typeof forgetInput>;

export interface FactView {
  id: string;
  subject: string;
  text: string;
  source: FactSourceKind;
  date: string;
  /** 0 to 1, rounded to two places. */
  strength: number;
}

/** The saved fact, plus a prompt when the wording suggests an end the owner has not given. */
export interface RememberView extends FactView {
  askEnd?: true;
  message?: string;
}

function dateOf(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso.slice(0, 10);
  const wall = wallClock(instant, timeZone);
  return `${wall.y}-${String(wall.m).padStart(2, '0')}-${String(wall.d).padStart(2, '0')}`;
}

function viewOf(fact: Fact, timeZone: string): FactView {
  return {
    id: fact.id,
    subject: fact.subject,
    text: fact.text,
    source: fact.source.kind,
    date: dateOf(fact.at, timeZone),
    strength: Math.round(fact.strength * 100) / 100,
  };
}

interface FactDeps {
  store: FactStore;
  texts: MemoryTexts;
  timeZone: string;
  language: string;
}

function subjectOf(about: string | undefined, language: string): string {
  if (about === undefined || about.trim().length === 0) return 'owner';
  return about.trim().toLowerCase() === 'owner' ? 'owner' : personKey(about, language);
}

/** Tool "memory.remember": keeps one fact the owner stated, grounded in their own words. */
export function memoryRememberTool(deps: FactDeps): Tool<MemoryRememberInput, RememberView> {
  return {
    name: 'memory.remember',
    description:
      "Remember one short fact about the owner or a person. Only what the owner said, with an exact quote as evidence.",
    input: rememberInput,
    effects: ['write'],
    reject: (input, call) =>
      evidenceFound(input.evidence, call.ownerGrounding ?? call.grounding)
        ? undefined
        : "evidence was not found in this turn; quote the owner's words exactly",
    describe: (input) => `${deps.texts.rememberLabel}: ${input.text}`,
    async run(input) {
      const fact = await deps.store.remember({
        subject: subjectOf(input.about, deps.language),
        text: input.text,
        source: { kind: 'chat' },
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
        ...(input.untilEvent !== undefined ? { untilEvent: input.untilEvent } : {}),
        ...(input.standing === true ? { standing: true } : {}),
      });
      const view = viewOf(fact, deps.timeZone);
      const needsEnd =
        isTimeLimited(input.text) && input.validUntil === undefined && input.untilEvent === undefined;
      return needsEnd ? { ...view, askEnd: true, message: deps.texts.askEnd } : view;
    },
  };
}

/** Tool "memory.recall": reads the owner's own remembered facts. */
export function memoryRecallTool(deps: FactDeps): Tool<MemoryRecallInput, FactView[]> {
  return {
    name: 'memory.recall',
    description:
      'Look up facts the assistant remembered about the owner or a person, ranked by relevance and how strongly they are still held.',
    input: recallInput,
    effects: ['read'],
    async run(input) {
      const facts = await deps.store.recall({
        ...(input.query !== undefined ? { text: input.query } : {}),
        ...(input.about !== undefined ? { subject: subjectOf(input.about, deps.language) } : {}),
        limit: input.limit,
      });
      return facts.map((fact) => viewOf(fact, deps.timeZone));
    },
  };
}

/** Tool "memory.forget": deletion, so the approval card always shows the fact text. */
export function memoryForgetTool(deps: FactDeps): Tool<MemoryForgetInput, { id: string; removed: boolean }> {
  return {
    name: 'memory.forget',
    description: 'Delete one remembered fact permanently.',
    input: forgetInput,
    effects: ['delete'],
    describe(input) {
      const fact = deps.store.get(input.id);
      return `${deps.texts.forgetLabel}: ${fact?.text ?? input.id}`;
    },
    async run(input) {
      const removed = await deps.store.remove(input.id);
      if (removed === undefined) throw new Error(`No fact with id ${input.id}`);
      return { id: removed.id, removed: true };
    },
  };
}
