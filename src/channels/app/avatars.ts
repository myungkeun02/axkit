import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Bot, BotDirectory } from '../../core/contracts/bots.js';
import type { DeviceFile } from '../../core/contracts/device-api.js';
import type { PluginContext } from '../../core/plugin/types.js';

/**
 * Bot characters (R13): one square picture per bot, made once with an image model when the owner has connected one
 * (OpenAI, key in the Keychain), served to the app as `files/avatar-<bot>.png`. Without a key the app draws its own.
 * Only the bot's name and one-line role leave the Mac, never documents or chat.
 */
export const AVATAR_SECRET = 'llm.openai.api-key';
const AVATAR_ID = /^avatar-([a-z][a-z0-9-]{1,30})\.png$/;
const MAX_TRIES = 3;
const PER_RUN = 2;

export function avatarRef(botId: string): string {
  return `files/avatar-${botId}.png`;
}

export class BotAvatars {
  constructor(
    private readonly dir: string,
    private readonly ctx: PluginContext,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private path(botId: string): string {
    return join(this.dir, `${botId}.png`);
  }

  async has(botId: string): Promise<boolean> {
    return await stat(this.path(botId)).then((info) => info.size > 0, () => false);
  }

  /** For the `files/:id` route: answers only ids shaped like an avatar. */
  async read(id: string): Promise<DeviceFile | undefined> {
    const match = AVATAR_ID.exec(id);
    if (match?.[1] === undefined) return undefined;
    const bytes = await readFile(this.path(match[1])).catch(() => undefined);
    return bytes === undefined ? undefined : { bytes, contentType: 'image/png', name: id };
  }

  /** Makes the missing pictures, a couple per run, each bot at most three tries. Silent when no image key exists. */
  async fill(bots: BotDirectory): Promise<number> {
    const key = await this.ctx.secrets.get(AVATAR_SECRET).catch(() => undefined);
    if (key === undefined || key === '') return 0;
    let made = 0;
    for (const bot of await bots.list()) {
      if (made >= PER_RUN) break;
      if (bot.status === 'off' || (await this.has(bot.id))) continue;
      const tries = (await this.ctx.kv.get<number>(`avatar.tries.${bot.id}`)) ?? 0;
      if (tries >= MAX_TRIES) continue;
      await this.ctx.kv.set(`avatar.tries.${bot.id}`, tries + 1);
      try {
        await this.save(bot.id, await this.draw(bot, key));
        made += 1;
      } catch (error) {
        this.ctx.log.warn('app: bot picture failed', { bot: bot.id, error: error instanceof Error ? error.message.slice(0, 120) : 'error' });
      }
    }
    return made;
  }

  private async draw(bot: Bot, key: string): Promise<Buffer> {
    const prompt = [
      `A cute, friendly 3D clay character, the mascot of an assistant named "${bot.name.slice(0, 40)}"`,
      `whose job is: ${bot.role.slice(0, 120)}.`,
      'Soft studio light, plain pastel background, the whole body centered, big kind eyes, no text, no logos.',
    ].join(' ');
    const response = await this.fetchImpl('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', quality: 'low', n: 1 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`image model answered HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { b64_json?: string }[] };
    const b64 = body.data?.[0]?.b64_json;
    if (b64 === undefined) throw new Error('image model returned no picture');
    return Buffer.from(b64, 'base64');
  }

  private async save(botId: string, bytes: Buffer): Promise<void> {
    const path = this.path(botId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.part`, bytes);
    await rename(`${path}.part`, path);
  }
}
