import { describe, expect, it } from 'vitest';
import { createLogger, MemoryAuditLog, silentLogger } from '../../src/core/log/console-logger.js';
import { AUDIT_MIGRATIONS, SqliteAuditLog } from '../../src/core/log/sqlite-audit.js';
import { openSqliteStore } from '../../src/core/store/sqlite.js';

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createLogger', () => {
  it('writes one JSON line per entry with scope and fields', () => {
    const lines: string[] = [];
    const log = createLogger({ scope: 'test', sink: (line) => lines.push(line) });
    log.info('hello', { count: 3 });

    const [entry] = parseLines(lines);
    expect(entry).toMatchObject({ level: 'info', scope: 'test', msg: 'hello', count: 3 });
    expect(typeof entry?.t).toBe('string');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
  });

  it('masks secret-like keys and values', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    log.debug('secrets', {
      apiKey: 'plain-value',
      password: 'hunter2',
      authorization: 'anything',
      nested: { refreshToken: 'abc' },
      header: 'Bearer abcdef123456',
      blob: 'abcdef0123456789abcdef0123456789',
      safe: 'visible',
      short: 'hello',
    });

    const [entry] = parseLines(lines);
    expect(entry?.apiKey).toBe('[masked]');
    expect(entry?.password).toBe('[masked]');
    expect(entry?.authorization).toBe('[masked]');
    expect(entry?.nested).toEqual({ refreshToken: '[masked]' });
    expect(entry?.header).toBe('[masked]');
    expect(entry?.blob).toBe('[masked]');
    expect(entry?.safe).toBe('visible');
    expect(entry?.short).toBe('hello');
  });

  it('filters entries below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (line) => lines.push(line) });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(parseLines(lines).map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  it('appends child scopes', () => {
    const lines: string[] = [];
    const log = createLogger({ scope: 'app', sink: (line) => lines.push(line) });
    log.child('discord').child('bot').info('x');

    expect(parseLines(lines)[0]).toMatchObject({ scope: 'app.discord.bot' });
  });

  it('silentLogger ignores everything', () => {
    expect(() => {
      silentLogger.error('x', { token: 'y' });
      silentLogger.child('a').debug('z');
    }).not.toThrow();
  });
});

describe('MemoryAuditLog', () => {
  it('appends entries in order', async () => {
    const audit = new MemoryAuditLog();
    await audit.append({ at: new Date('2026-01-01T00:00:00Z'), kind: 'tool', subject: 'a' });
    await audit.append({ at: new Date('2026-01-02T00:00:00Z'), kind: 'tool', subject: 'b' });

    expect(audit.entries.map((entry) => entry.subject)).toEqual(['a', 'b']);
  });
});

describe('SqliteAuditLog', () => {
  it('appends entries and returns them newest first', async () => {
    const store = openSqliteStore(':memory:');
    await store.migrate(AUDIT_MIGRATIONS);
    const audit = new SqliteAuditLog(store.sql);

    await audit.append({ at: new Date('2026-01-01T00:00:00Z'), kind: 'tool', subject: 'a' });
    await audit.append({
      at: new Date('2026-01-02T00:00:00Z'),
      kind: 'tool',
      subject: 'b',
      detail: { status: 'done', effects: ['read'] },
    });

    expect(audit.recent(10).map((entry) => entry.subject)).toEqual(['b', 'a']);
    expect(audit.recent(1)).toEqual([
      {
        at: new Date('2026-01-02T00:00:00Z'),
        kind: 'tool',
        subject: 'b',
        detail: { status: 'done', effects: ['read'] },
      },
    ]);
    expect(audit.recent(1)[0]?.detail).toBeDefined();
    await store.close();
  });

  it('masks secret-looking detail values before writing', async () => {
    const store = openSqliteStore(':memory:');
    await store.migrate(AUDIT_MIGRATIONS);
    const audit = new SqliteAuditLog(store.sql);
    const secret = 'abcdef0123456789abcdef0123456789';

    await audit.append({
      at: new Date('2026-01-01T00:00:00Z'),
      kind: 'tool',
      subject: 'mail.send',
      detail: {
        status: 'done',
        apiKey: 'plain-value',
        nested: { authorization: 'Bearer abcdef123456' },
        blob: secret,
        recipient: 'minsu@example.com',
      },
    });

    const [entry] = audit.recent(1);
    expect(entry?.detail).toEqual({
      status: 'done',
      apiKey: '[masked]',
      nested: { authorization: '[masked]' },
      blob: '[masked]',
      recipient: 'minsu@example.com',
    });
    const row = store.sql.get('SELECT detail FROM audit');
    expect(String(row?.detail)).not.toContain(secret);
    expect(String(row?.detail)).not.toContain('plain-value');
    await store.close();
  });

  it('stores entries without detail', async () => {
    const store = openSqliteStore(':memory:');
    await store.migrate(AUDIT_MIGRATIONS);
    const audit = new SqliteAuditLog(store.sql);

    await audit.append({ at: new Date('2026-01-01T00:00:00Z'), kind: 'pairing', subject: 'phone' });

    expect(audit.recent(1)[0]?.detail).toBeUndefined();
    await store.close();
  });
});
