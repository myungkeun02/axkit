import { createHash } from 'node:crypto';

/** Two lines that differ only in case or spacing describe the same thing. */
function norm(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A knowledge line's stable id (area, topic, key), so any plugin can correct a line through `KnowledgeWriter.correct`. */
export function lineId(area: string, topic: string, key: string): string {
  return createHash('sha256').update(`${area}\n${norm(topic)}\n${norm(key)}`).digest('hex').slice(0, 16);
}
