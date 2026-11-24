export const CHUNK_CHARS = 1_500;
export const MAX_CHUNKS_PER_FILE = 20;

function splitLong(paragraph: string): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > CHUNK_CHARS) {
    const window = rest.slice(0, CHUNK_CHARS);
    const newline = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    const breakAt = Math.max(newline, space);
    const cut = breakAt > CHUNK_CHARS / 2 ? breakAt : CHUNK_CHARS;
    const piece = rest.slice(0, cut).trim();
    if (piece !== '') pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/** Splits text into at most 20 chunks of about 1,500 characters, preferring blank-line boundaries. */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return [];
  const paragraphs = normalized.split(/\n\s*\n/);

  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    for (const piece of splitLong(paragraph.trim())) {
      if (piece === '') continue;
      if (current === '') {
        current = piece;
      } else if (current.length + 2 + piece.length <= CHUNK_CHARS) {
        current = `${current}\n\n${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
      if (chunks.length >= MAX_CHUNKS_PER_FILE) return chunks.slice(0, MAX_CHUNKS_PER_FILE);
    }
  }
  if (current !== '') chunks.push(current);
  return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}
