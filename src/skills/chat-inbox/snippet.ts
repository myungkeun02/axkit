/** Collapses a preview or message body onto one line for notices and storage. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** One-line quote capped with an ellipsis; notices stay short and never carry the whole body. */
export function quoteText(text: string, max = 60): string {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
