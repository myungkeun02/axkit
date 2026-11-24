import type { Migration, SqlDatabase } from '../store/types.js';

/**
 * "Never ask the same question twice." Every card about a stable `topic` ("drive:save:meeting-notes",
 * "dev:suggest:payment-export") leaves the owner's last answer here, and the next question on that topic follows it:
 * - yes / a chosen option: done again without a card (the owner hears about it),
 * - no / a typed reply: not asked again until the facts behind it change,
 * - later: brought back once when it is due, then never again on its own.
 */
export const TOPIC_MIGRATIONS: readonly Migration[] = [
  {
    id: 'core/009-owner-topics',
    sql: `CREATE TABLE IF NOT EXISTS owner_topics (topic TEXT PRIMARY KEY, answer TEXT NOT NULL, choice TEXT, label TEXT, facts TEXT, at_ms INTEGER NOT NULL, later_until_ms INTEGER, reopened INTEGER NOT NULL DEFAULT 0);`,
  },
];

export type TopicAnswerKind = 'approved' | 'denied' | 'later' | 'text';

export interface TopicAnswer {
  topic: string;
  answer: TopicAnswerKind;
  choice?: string;
  label?: string;
  facts?: string;
  at: string;
  laterUntil?: string;
  reopened: boolean;
}

export type TopicDecision =
  | { kind: 'ask'; reopening: boolean }
  | { kind: 'reuse'; answer: TopicAnswer }
  | { kind: 'skip'; reason: 'declined' | 'later' | 'reopened_once'; answer: TopicAnswer };

export const TOPIC = /^[\p{L}\p{N}._:/-]{1,120}$/u;
export const DEFAULT_LATER_MS = 20 * 3_600_000;

/** Pure: what to do with a new question on a topic the owner may already have answered. */
export function decideTopic(previous: TopicAnswer | undefined, facts: string | undefined, now: Date): TopicDecision {
  if (previous === undefined) return { kind: 'ask', reopening: false };
  switch (previous.answer) {
    case 'approved':
      return { kind: 'reuse', answer: previous };
    case 'denied':
    case 'text':
      // a no holds until what it was about really changes (another amount, another document)
      return facts !== undefined && previous.facts !== undefined && facts !== previous.facts
        ? { kind: 'ask', reopening: false }
        : { kind: 'skip', reason: 'declined', answer: previous };
    case 'later': {
      if (previous.reopened) return { kind: 'skip', reason: 'reopened_once', answer: previous };
      const due = previous.laterUntil === undefined || Date.parse(previous.laterUntil) <= now.getTime();
      return due ? { kind: 'ask', reopening: true } : { kind: 'skip', reason: 'later', answer: previous };
    }
  }
}

export interface TopicAnswers {
  get(topic: string): Promise<TopicAnswer | undefined>;
  record(topic: string, answer: { answer: TopicAnswerKind; choice?: string; label?: string; facts?: string; laterUntil?: Date }): Promise<void>;
  markReopened(topic: string): Promise<void>;
  list(): Promise<TopicAnswer[]>;
  forget(topic: string): Promise<boolean>;
}

function toAnswer(row: Record<string, unknown>): TopicAnswer {
  return {
    topic: String(row.topic),
    answer: String(row.answer) as TopicAnswerKind,
    ...(typeof row.choice === 'string' ? { choice: row.choice } : {}),
    ...(typeof row.label === 'string' ? { label: row.label } : {}),
    ...(typeof row.facts === 'string' ? { facts: row.facts } : {}),
    at: new Date(Number(row.at_ms)).toISOString(),
    ...(row.later_until_ms !== null && row.later_until_ms !== undefined ? { laterUntil: new Date(Number(row.later_until_ms)).toISOString() } : {}),
    reopened: Number(row.reopened) === 1,
  };
}

export class SqliteTopicAnswers implements TopicAnswers {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly now: () => Date,
  ) {}

  get(topic: string): Promise<TopicAnswer | undefined> {
    const row = this.sql.get('SELECT * FROM owner_topics WHERE topic = ?', topic);
    return Promise.resolve(row === undefined ? undefined : toAnswer(row));
  }

  record(topic: string, answer: { answer: TopicAnswerKind; choice?: string; label?: string; facts?: string; laterUntil?: Date }): Promise<void> {
    this.sql.run(
      `INSERT INTO owner_topics (topic, answer, choice, label, facts, at_ms, later_until_ms, reopened) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (topic) DO UPDATE SET answer = excluded.answer, choice = excluded.choice, label = excluded.label,
         facts = excluded.facts, at_ms = excluded.at_ms, later_until_ms = excluded.later_until_ms,
         reopened = CASE WHEN excluded.answer = 'later' THEN owner_topics.reopened ELSE 0 END`,
      topic,
      answer.answer,
      answer.choice ?? null,
      answer.label?.slice(0, 200) ?? null,
      answer.facts?.slice(0, 200) ?? null,
      this.now().getTime(),
      answer.laterUntil?.getTime() ?? null,
    );
    return Promise.resolve();
  }

  markReopened(topic: string): Promise<void> {
    this.sql.run('UPDATE owner_topics SET reopened = 1 WHERE topic = ?', topic);
    return Promise.resolve();
  }

  list(): Promise<TopicAnswer[]> {
    return Promise.resolve(this.sql.all('SELECT * FROM owner_topics ORDER BY at_ms DESC').map(toAnswer));
  }

  forget(topic: string): Promise<boolean> {
    const had = this.sql.get('SELECT topic FROM owner_topics WHERE topic = ?', topic) !== undefined;
    this.sql.run('DELETE FROM owner_topics WHERE topic = ?', topic);
    return Promise.resolve(had);
  }
}
