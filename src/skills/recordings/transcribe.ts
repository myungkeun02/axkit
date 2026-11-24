import { access, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProcessRunner } from '../../core/process/types.js';
import type { SecretReader } from '../../core/secrets/types.js';

/**
 * Speech to text. Two adapters, both chosen by the owner: an OpenAI-compatible `/audio/transcriptions` endpoint (the
 * key stays in the Keychain), or a local command such as whisper.cpp (`{in}` = audio path, `{out}` = output base path,
 * the tool writes `{out}.txt` or prints the text), or local whisper.cpp with its own ffmpeg step (`kind: "whisper"`).
 */
export const transcribeConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api'),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    model: z.string().min(1).max(80).default('whisper-1'),
    keySecret: z.string().min(1).max(80).default('openai.api-key'),
    language: z.string().min(2).max(5).optional(),
  }),
  z.object({
    kind: z.literal('command'),
    command: z.string().min(1).max(300),
    args: z.array(z.string().max(300)).max(30).default(['{in}']),
    timeoutMinutes: z.number().int().min(1).max(240).default(60),
  }),
  z.object({
    kind: z.literal('whisper'),
    /** A ggml model file; large-v3-turbo handles Korean well on Apple silicon. */
    model: z.string().min(1).max(300).default(join(homedir(), '.ax-kit', 'models', 'ggml-large-v3-turbo.bin')),
    /** "ko", "en" or "auto"; unset follows the assistant's language. */
    language: z.string().min(2).max(5).optional(),
    whisperCli: z.string().min(1).max(300).optional(),
    ffmpeg: z.string().min(1).max(300).optional(),
    timeoutMinutes: z.number().int().min(1).max(240).default(90),
    /**
     * Silero VAD model (ggml-silero-v5.1.2.bin). When the file is there, only the parts with speech are transcribed,
     * so silence and humming no longer come back as made-up subtitles ("감사합니다.").
     */
    vadModel: z.string().min(1).max(300).default(join(homedir(), '.ax-kit', 'models', 'ggml-silero-v5.1.2.bin')),
  }),
]);
export type TranscribeConfig = z.infer<typeof transcribeConfigSchema>;

/** The local tools or model are not on this Mac: the owner gets install steps, not an error code. */
export class TranscriberMissingError extends Error {
  override readonly name = 'TranscriberMissingError';
}

export interface Transcriber {
  transcribe(audioPath: string, signal?: AbortSignal): Promise<string>;
}

export function apiTranscriber(config: Extract<TranscribeConfig, { kind: 'api' }>, secrets: SecretReader, fetchImpl: typeof fetch = fetch): Transcriber {
  return {
    async transcribe(audioPath, signal) {
      const key = await secrets.get(config.keySecret);
      if (key === undefined || key === '') throw new Error(`No key in the Keychain under "${config.keySecret}"`);
      const form = new FormData();
      form.set('model', config.model);
      if (config.language !== undefined) form.set('language', config.language);
      form.set('response_format', 'text');
      const webm = audioPath.endsWith('.webm');
      form.set('file', new Blob([await readFile(audioPath)], { type: webm ? 'audio/webm' : 'audio/mp4' }), webm ? 'audio.webm' : 'audio.m4a');
      const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`Transcription failed (HTTP ${response.status})`);
      return (await response.text()).trim();
    },
  };
}

export function commandTranscriber(config: Extract<TranscribeConfig, { kind: 'command' }>, run: ProcessRunner): Transcriber {
  return {
    async transcribe(audioPath, signal) {
      const out = `${audioPath}.transcript`;
      const args = config.args.map((arg) => arg.replaceAll('{in}', audioPath).replaceAll('{out}', out));
      const result = await run(config.command, args, { timeoutMs: config.timeoutMinutes * 60_000, ...(signal !== undefined ? { signal } : {}) });
      if (result.timedOut) throw new Error('Transcription timed out');
      if (result.code !== 0) throw new Error(`Transcription command failed (exit ${result.code})`);
      const file = await readFile(`${out}.txt`, 'utf8').catch(() => undefined);
      await rm(`${out}.txt`, { force: true });
      return (file ?? result.stdout).trim();
    },
  };
}

/** The daemon runs under launchd without Homebrew on PATH, so look in Homebrew's folders first. */
export async function findTool(name: string): Promise<string> {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')]) {
    if (dir === '') continue;
    const path = `${dir}/${name}`;
    if (await access(path).then(() => true, () => false)) return path;
  }
  throw new TranscriberMissingError(`${name} is not installed`);
}

/** whisper.cpp reads wav, not m4a or webm: ffmpeg makes 16 kHz mono wav first, then whisper-cli writes text. */
export function whisperTranscriber(config: Extract<TranscribeConfig, { kind: 'whisper' }>, run: ProcessRunner, defaultLanguage: string): Transcriber {
  return {
    async transcribe(audioPath, signal) {
      if (!(await access(config.model).then(() => true, () => false))) throw new TranscriberMissingError(`No whisper model at ${config.model}`);
      const wav = `${audioPath}.16k.wav`;
      const out = `${audioPath}.transcript`;
      const timeoutMs = config.timeoutMinutes * 60_000;
      const opts = { timeoutMs, ...(signal !== undefined ? { signal } : {}) };
      try {
        const converted = await run(config.ffmpeg ?? (await findTool('ffmpeg')), ['-nostdin', '-y', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], opts);
        if (converted.timedOut) throw new Error('Audio conversion timed out');
        if (converted.code !== 0) throw new Error(`Audio conversion failed (exit ${converted.code})`);
        const language = config.language ?? defaultLanguage;
        const vad = (await access(config.vadModel).then(() => true, () => false)) ? ['--vad', '-vm', config.vadModel] : [];
        const result = await run(config.whisperCli ?? (await findTool('whisper-cli')), ['-m', config.model, '-l', language, '-f', wav, '-otxt', '-of', out, '-np', '-sns', ...vad], opts);
        if (result.timedOut) throw new Error('Transcription timed out');
        if (result.code !== 0) throw new Error(`Transcription command failed (exit ${result.code})`);
        return (await readFile(`${out}.txt`, 'utf8')).trim();
      } finally {
        await rm(wav, { force: true });
        await rm(`${out}.txt`, { force: true });
      }
    },
  };
}
