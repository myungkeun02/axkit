import { join } from 'node:path';
import { z } from 'zod';
import type { ProcessRunner, RunResult } from '../../core/process/types.js';
import type { Tool } from '../../core/tools/types.js';
import type { AxReader } from './reader.js';

export interface KakaoSendDeps {
  run: ProcessRunner;
  reader: AxReader;
  home: string;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  kmsgPath?: string;
}

export interface KakaoSendInput {
  room: string;
  text: string;
}

export interface KakaoSendOutput {
  sent: true;
  room: string;
}

const input: z.ZodType<KakaoSendInput> = z.object({
  room: z
    .string()
    .min(1)
    .max(100)
    .describe('Exact KakaoTalk room title as shown in the chat list.'),
  text: z.string().min(1).max(1000).describe('Message text to send.'),
});

const ChatsOutput = z.object({
  chats: z.array(z.object({ chat_id: z.string(), title: z.string() })),
});

const KMSG_CANDIDATES = ['/opt/homebrew/bin/kmsg', '/usr/local/bin/kmsg'] as const;

function normalize(value: string): string {
  return value.normalize('NFC').trim();
}

async function findKmsg(deps: KakaoSendDeps): Promise<string> {
  if (deps.kmsgPath !== undefined) return deps.kmsgPath;
  for (const candidate of KMSG_CANDIDATES) {
    if (await deps.exists(candidate)) return candidate;
  }
  throw new Error('kmsg is not installed (brew install channprj/tap/kmsg)');
}

async function assertNoSavedLogin(deps: KakaoSendDeps): Promise<void> {
  const configDir = join(deps.home, '.config', 'kmsg');
  const message =
    'kmsg has saved KakaoTalk credentials; ax-kit never logs in for the owner. Remove them to use kakao.send.';
  if (await deps.exists(join(configDir, 'credentials.json'))) throw new Error(message);
  const credentialsDir = join(configDir, 'credentials');
  if (await deps.exists(credentialsDir) && (await deps.listDir(credentialsDir)).length > 0) {
    throw new Error(message);
  }
}

function assertOk(result: RunResult, what: string): void {
  if (result.timedOut) throw new Error(`${what} timed out.`);
  if (result.code !== 0) throw new Error(`${what} failed with exit code ${result.code}.`);
}

async function listChats(
  deps: KakaoSendDeps,
  kmsg: string,
): Promise<z.infer<typeof ChatsOutput>['chats']> {
  const result = await deps.run(kmsg, ['chats', '--json'], { timeoutMs: 60_000 });
  assertOk(result, 'kmsg chats');

  const start = result.stdout.indexOf('{');
  if (start === -1) throw new Error('kmsg did not return chat data.');
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout.slice(start));
  } catch {
    throw new Error('kmsg returned invalid chat data.');
  }
  const parsed = ChatsOutput.safeParse(raw);
  if (!parsed.success) throw new Error('kmsg returned an unexpected chat list.');
  return parsed.data.chats;
}

function chatIdFor(chats: readonly { chat_id: string; title: string }[], room: string): string {
  const wanted = normalize(room);
  const matches = chats.filter((chat) => normalize(chat.title) === wanted);
  if (matches.length === 0) throw new Error(`No KakaoTalk room titled "${room}".`);
  if (matches.length > 1) {
    throw new Error(`More than one KakaoTalk room is titled "${room}"; refusing to guess.`);
  }
  const found = matches[0];
  if (found === undefined) throw new Error(`No KakaoTalk room titled "${room}".`);
  return found.chat_id;
}

/** Sends through kmsg by chat id only: kmsg's room-name search is fuzzy and can reach the wrong room. */
export function kakaoSendTool(deps: KakaoSendDeps): Tool<KakaoSendInput, KakaoSendOutput> {
  return {
    name: 'kakao.send',
    description:
      'Send a KakaoTalk message to one existing room. The room must already be in the chat list; nothing is opened or launched.',
    input,
    effects: ['send'],
    timeoutMs: 180_000,
    describe: ({ room, text }) => `KakaoTalk → ${room}\n${text}`,
    async run(value) {
      const kmsg = await findKmsg(deps);
      await assertNoSavedLogin(deps);

      const snapshot = await deps.reader.dump(['com.kakao.KakaoTalkMac']);
      if (!snapshot.running) throw new Error('KakaoTalk is not running; ax-kit never launches it.');

      const chatId = chatIdFor(await listChats(deps, kmsg), value.room);
      const result = await deps.run(kmsg, ['send', '--chat-id', chatId, value.text], {
        timeoutMs: 90_000,
      });
      assertOk(result, 'kmsg send');
      return { sent: true, room: value.room };
    },
  };
}
