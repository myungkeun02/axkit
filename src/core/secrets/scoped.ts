import type { SecretName, SecretReader } from './types.js';

export function scopedReader(
  store: SecretReader,
  allowed: readonly string[],
  owner: string,
): SecretReader {
  const permitted = new Set(allowed);
  return {
    async get(name: SecretName): Promise<string | undefined> {
      if (!permitted.has(name)) {
        throw new Error(`${owner} is not allowed to read secret "${name}"`);
      }
      return store.get(name);
    },
  };
}
