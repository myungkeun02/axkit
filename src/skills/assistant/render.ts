import type { ToolOutcome } from '../../core/tools/types.js';
import { guardDeep, guardText, wrapData, wrapGuarded } from '../../core/text/data.js';

export { wrapData };

const MAX_OUTPUT_CHARS = 4000;

export interface ToolResult {
  name: string;
  outcome: ToolOutcome;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text;
}

/** What the model is told a tool call did. Decisions stay in code; this is only the report. */
export function renderOutcome(outcome: ToolOutcome): string {
  switch (outcome.status) {
    case 'done':
      // each string is screened on its own: a line aimed at the AI in one mail must not blank the whole result
      return truncate(safeJson(guardDeep('tool_results', outcome.output)));
    case 'denied':
      return 'the owner declined';
    case 'expired':
      return 'no answer, treated as declined';
    case 'rejected':
      return outcome.reason;
    case 'invalid_input':
      return outcome.issues.join('; ');
    case 'failed':
      return outcome.error;
  }
}


export function renderToolResults(results: readonly ToolResult[]): string {
  const lines = results.map(({ name, outcome }) =>
    JSON.stringify({ tool: name, status: outcome.status, result: outcome.status === 'done' ? renderOutcome(outcome) : guardText('tool_results', renderOutcome(outcome)) }),
  );
  return wrapGuarded('tool_results', lines.join('\n'));
}

/** Raw strings inside a tool output, so quoted evidence can match mail text without JSON escapes. */
export function textLeaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) textLeaves(item, out, depth + 1);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) textLeaves(item, out, depth + 1);
  }
  return out;
}
