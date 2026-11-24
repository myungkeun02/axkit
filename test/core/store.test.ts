import { describe, expect, it } from 'vitest';
import { openSqliteStore } from '../../src/core/store/sqlite.js';
import type { Migration } from '../../src/core/store/types.js';

const migrations: readonly Migration[] = [
  { id: 'demo/001-notes', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)' },
  { id: 'demo/002-tags', sql: 'ALTER TABLE notes ADD COLUMN tag TEXT' },
];

describe('openSqliteStore', () => {
  it('applies migrations once and returns their ids', async () => {
    const store = openSqliteStore(':memory:');
    expect(await store.migrate(migrations)).toEqual(['demo/001-notes', 'demo/002-tags']);
    expect(await store.migrate(migrations)).toEqual([]);
    await store.close();
  });

  it('applies new migrations on later calls', async () => {
    const store = openSqliteStore(':memory:');
    expect(await store.migrate([migrations[0]!])).toEqual(['demo/001-notes']);
    expect(await store.migrate(migrations)).toEqual(['demo/002-tags']);
    await store.close();
  });

  it('round-trips JSON values through key-value namespaces', async () => {
    const store = openSqliteStore(':memory:');
    const first = store.kv('demo');
    const second = store.kv('other');

    await first.set('profile', { name: 'Ada', tags: ['a', 'b'] });
    await second.set('profile', 'separate');

    expect(await first.get<{ name: string; tags: string[] }>('profile')).toEqual({
      name: 'Ada',
      tags: ['a', 'b'],
    });
    expect(await second.get('profile')).toBe('separate');

    await first.set('profile', 42);
    expect(await first.get('profile')).toBe(42);

    await first.delete('profile');
    expect(await first.get('profile')).toBeUndefined();
    await store.close();
  });

  it('exposes parameterized SQL for core repositories', async () => {
    const store = openSqliteStore(':memory:');
    store.sql.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, label TEXT)');
    store.sql.run('INSERT INTO demo (id, label) VALUES (?, ?)', 1, 'one');
    store.sql.run('INSERT INTO demo (id, label) VALUES (?, ?)', 2, null);

    expect(store.sql.all('SELECT id, label FROM demo ORDER BY id')).toEqual([
      { id: 1, label: 'one' },
      { id: 2, label: null },
    ]);
    expect(store.sql.get('SELECT label FROM demo WHERE id = ?', 2)).toEqual({ label: null });
    expect(store.sql.get('SELECT label FROM demo WHERE id = ?', 9)).toBeUndefined();
    await store.close();
  });

  it('rolls back a failing migration', async () => {
    const store = openSqliteStore(':memory:');
    const bad: Migration = { id: 'demo/003-bad', sql: 'THIS IS NOT SQL' };
    await expect(store.migrate([bad])).rejects.toThrow();
    await expect(store.migrate([bad])).rejects.toThrow();
    await store.close();
  });
});
