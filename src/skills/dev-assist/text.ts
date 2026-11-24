/** Keeps the last `maxChars` characters; logs and test tails are read from the end. */
export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** First non-empty line, clipped, for job titles and confirmation cards. */
export function firstLine(text: string, maxChars: number): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the first JSON object in a model reply, tolerating prose or a fenced block around it. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
