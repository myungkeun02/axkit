import { join } from 'node:path';
import { openSqliteStore } from '../core/store/sqlite.js';
import { KILL_MIGRATIONS, SqliteKillSwitch } from '../core/switches/kill.js';
import { stopStatusText } from '../core/switches/kill-tools.js';

/** `ax-kit stop [reason]` / `ax-kit resume` / `ax-kit stop --status`: works while the assistant runs (same SQLite file). */
export async function killCommand(home: string, action: 'stop' | 'resume' | 'status', reason: string): Promise<number> {
  const store = openSqliteStore(join(home, 'data', 'ax-kit.db'));
  try {
    await store.migrate(KILL_MIGRATIONS);
    const kill = new SqliteKillSwitch(store.sql, () => new Date());
    const state =
      action === 'stop' ? await kill.stop(reason, 'cli') : action === 'resume' ? await kill.resume('cli') : await kill.state();
    process.stdout.write(`${stopStatusText(state, 'ko')}\n`);
    return 0;
  } finally {
    await store.close();
  }
}
