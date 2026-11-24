import type { SecretName, SecretStore } from './types.js';

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<SecretName, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      this.values.set(name, value);
    }
  }

  async get(name: SecretName): Promise<string | undefined> {
    return this.values.get(name);
  }

  async set(name: SecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: SecretName): Promise<void> {
    this.values.delete(name);
  }

  async has(name: SecretName): Promise<boolean> {
    return this.values.has(name);
  }
}
