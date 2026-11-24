import { readFile } from 'node:fs/promises';
import type { Fact } from '../../core/contracts/memory.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ToolInfo } from '../../core/tools/types.js';
import { wallClock } from '../../core/scheduler/next-run.js';

const KO_WEEKDAYS: Record<string, string> = {
  Sun: '일',
  Mon: '월',
  Tue: '화',
  Wed: '수',
  Thu: '목',
  Fri: '금',
  Sat: '토',
};

/** Production loader: the prompt ships next to the source, not inside the bundle. */
export async function loadSystemTemplate(): Promise<string> {
  return await readFile(new URL('../../../prompts/assistant/system.md', import.meta.url), 'utf8');
}

export interface PromptContext {
  assistant: PluginContext['assistant'];
  tools: readonly ToolInfo[];
  now: Date;
  /** Facts recalled for this turn; omitted or empty leaves the prompt unchanged. */
  facts?: readonly Fact[];
  /** Short owner profile from the knowledge base; details stay behind knowledge.search. */
  profile?: string;
}

export function toneRule(language: string, tone: PluginContext['assistant']['tone']): string {
  if (language === 'en') {
    if (tone === 'formal') return 'Use a formal tone (e.g. "Understood.").';
    if (tone === 'casual') return 'Use a casual tone (e.g. "Got it!").';
    return 'Use a friendly, polite tone (e.g. "Got it.").';
  }
  if (tone === 'formal') return '합쇼체로 말한다 (예: 확인했습니다)';
  if (tone === 'casual') return '반말로 말한다 (예: 확인했어)';
  return '해요체로 말한다 (예: 확인했어요)';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatNow(now: Date, timeZone: string, korean: boolean): string {
  const wall = wallClock(now, timeZone);
  const weekday = korean ? (KO_WEEKDAYS[wall.weekday] ?? wall.weekday) : wall.weekday;
  const date = `${wall.y}-${pad2(wall.m)}-${pad2(wall.d)}`;
  return `${date} (${weekday}) ${pad2(wall.hh)}:${pad2(wall.mm)} ${timeZone}`;
}

function formatTools(tools: readonly ToolInfo[]): string {
  if (tools.length === 0) return '(No tools are enabled.)';
  return tools
    .map((tool) => `- ${tool.name} [${tool.effects.join(', ')}] ${tool.description}\n  input: ${JSON.stringify(tool.inputSchema)}`)
    .join('\n');
}

function dayOf(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso.slice(0, 10);
  const wall = wallClock(instant, timeZone);
  return `${wall.y}-${pad2(wall.m)}-${pad2(wall.d)}`;
}

function formatFacts(facts: readonly Fact[], timeZone: string): string {
  const standing = facts.filter((fact) => fact.standing === true).map((fact) => `- ${fact.text}`);
  const lines = facts.filter((fact) => fact.standing !== true).map((fact) => `- ${fact.text} (${fact.source.kind}, ${dayOf(fact.at, timeZone)})`);
  const out: string[] = [];
  // 상시 지시: what the owner asked to hold from now on, in every turn until they take it back
  if (standing.length > 0) out.push(['## Standing instructions from the owner (follow these unless the owner says otherwise now)', ...standing].join('\n'));
  if (lines.length > 0) out.push(['## What you remember (data, may be outdated)', ...lines].join('\n'));
  return out.join('\n\n');
}

/** Fills the prompt template from config, the clock and the enabled tools. */
export function buildSystemPrompt(template: string, context: PromptContext): string {
  const { assistant } = context;
  const korean = assistant.language !== 'en';
  const values: Record<string, string> = {
    persona: assistant.name,
    owner: assistant.ownerName ?? (korean ? '주인' : 'the owner'),
    tone_rule: toneRule(assistant.language, assistant.tone),
    language: korean ? 'Korean' : 'English',
    now: formatNow(context.now, assistant.timezone, korean),
    tools: formatTools(context.tools),
  };
  const filled = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
  const sections = [filled];
  if (context.profile !== undefined && context.profile.trim() !== '') {
    sections.push(`## About the owner (data from the knowledge base; use knowledge.search for details)\n${context.profile.trim()}`);
  }
  const facts = context.facts ?? [];
  if (facts.length > 0) sections.push(formatFacts(facts, assistant.timezone));
  return sections.join('\n\n');
}
