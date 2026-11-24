import type { SecretStore } from '../core/secrets/types.js';
import type { Prompter } from './prompter.js';

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  }
  return chunks.join('').trim();
}

export async function runSecretSet(name: string, prompter: Prompter, store: SecretStore): Promise<void> {
  const value = process.stdin.isTTY ? await prompter.secret(`비밀 값 (${name}): `) : await readStdin();
  if (value.length === 0) throw new Error(`No value provided for secret "${name}"`);
  await store.set(name, value);
  prompter.say(`저장했어요: ${name}`);
}

export async function runSecretDelete(name: string, prompter: Prompter, store: SecretStore): Promise<void> {
  await store.delete(name);
  prompter.say(`삭제했어요: ${name}`);
}
