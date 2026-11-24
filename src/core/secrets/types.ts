/** Secret names are dotted ids such as "discord.bot-token" or "llm.anthropic.api-key". */
export type SecretName = string;

export interface SecretReader {
  get(name: SecretName): Promise<string | undefined>;
}

export interface SecretStore extends SecretReader {
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  /** Names only, never values (used by `doctor`). */
  has(name: SecretName): Promise<boolean>;
}
