/** First balanced {...} block from a model answer, tolerating fences and surrounding prose. */
export function jsonObjectText(raw: string): string | undefined {
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}

export function parseJsonObject(raw: string): unknown {
  const json = jsonObjectText(raw);
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
