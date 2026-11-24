import { MissingKeyError } from '../../core/contracts/index.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { SecretReader } from '../../core/secrets/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { KoLifeTexts } from './locale.js';
import type { KoSecretName } from './secrets.js';

export interface KoLifeDeps {
  fetch: typeof fetch;
  secrets: SecretReader;
  clock: Clock;
  kv: KeyValueStore;
  texts: KoLifeTexts;
}

/** Reads a key at call time: the owner may add one while the daemon is running. */
export async function keyOf(deps: KoLifeDeps, name: KoSecretName): Promise<string> {
  const value = await deps.secrets.get(name);
  if (value === undefined || value.trim() === '') throw new MissingKeyError(name, deps.texts.guides[name]);
  return value.trim();
}
