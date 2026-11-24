import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeviceApi, DeviceApiResponse } from '../../core/contracts/device-api.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { Transcriber } from './transcribe.js';
import { TranscriberMissingError, findTool } from './transcribe.js';
import { formatOf } from './store.js';

/** A chat message spoken into the mic, not a meeting: a few minutes at most. */
const MAX_DICTATION_BYTES = 12 * 1024 * 1024;
const MIN_DICTATION_BYTES = 800;

export interface DictationDeps {
  api: DeviceApi;
  transcriber: Transcriber | undefined;
  /** Scratch folder; each clip is removed as soon as it is read. */
  dir: string;
  korean: boolean;
  warn: (message: string, fields: Record<string, unknown>) => void;
  /** One line per clip (size, type, time, outcome; never the words), so a stuck button can be traced. */
  info?: (message: string, fields: Record<string, unknown>) => void;
  /** Measures how loud a clip with no words was (ffmpeg), to tell "mic hears nothing" from "words not understood". */
  loudness?: (path: string) => Promise<number | undefined>;
}

/** Below this peak (dBFS) the mic gave next to nothing: a muted or wrong input device. */
const QUIET_PEAK_DB = -45;

/** The clip's peak level in dBFS through ffmpeg's volumedetect; undefined when it cannot tell. */
export function ffmpegLoudness(run: ProcessRunner): (path: string) => Promise<number | undefined> {
  return async (path) => {
    const ffmpeg = await findTool('ffmpeg').catch(() => undefined);
    if (ffmpeg === undefined) return undefined;
    const result = await run(ffmpeg, ['-nostdin', '-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 20_000 }).catch(() => undefined);
    const peak = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(result?.stderr ?? '')?.[1];
    return peak === undefined ? undefined : peak === '-inf' ? -120 : Number(peak);
  };
}

/**
 * What whisper writes for noise, humming or silence (it learned them from video subtitles). A clip that comes back as
 * only one of these had no words in it; inside a longer sentence they are left alone.
 */
const HALLUCINATIONS = [
  /^감사합니다$/,
  /^(시청|청취|들어|봐)\S*\s*주셔서\s*감사합니다$/,
  /^구독(과|,)?\s*좋아요.*$/,
  /^다음\s*영상에서\s*만나요$/,
  /^(MBC|KBS|SBS|YTN)\s*뉴스.*$/i,
  /^자막.*(제공|제작).*$/,
  /^thank(s| you)( for watching)?$/i,
  /^\[(BLANK_AUDIO|음악|music|박수|웃음)\]$/i,
  /^\(.*\)$/,
];

/** True when the text is only something whisper makes up for a clip without words. */
export function isMadeUp(text: string): boolean {
  const bare = text.trim().replace(/[.!?。…~\s]+$/u, '').replace(/^[\s"'“]+|[\s"'”]+$/gu, '');
  return bare === '' || HALLUCINATIONS.some((pattern) => pattern.test(bare));
}

const answer = (status: number, body: Record<string, unknown>): DeviceApiResponse => ({ status, body: { ok: status < 400, ...body } });

/** Whether this Mac can transcribe now: an API or command is trusted, whisper needs its model, whisper-cli and ffmpeg. */
export async function canTranscribe(config: { kind: string; model?: string }): Promise<boolean> {
  if (config.kind !== 'whisper') return true;
  const model = await access(config.model ?? '').then(() => true, () => false);
  const tools = await Promise.all(['whisper-cli', 'ffmpeg'].map((name) => findTool(name).then(() => true, () => false)));
  return model && tools.every(Boolean);
}

/**
 * `POST dictation` (docs/APP-PROTOCOL.md §30): the app's mic button. The clip is turned into text on this Mac and the
 * text goes back to the input box; nothing is sent, saved or kept. The owner reads and edits it before sending.
 */
export function registerDictation(deps: DictationDeps): void {
  const { korean } = deps;
  deps.api.upload('dictation', async (upload) => {
    const started = Date.now();
    const measured: { peakDb?: number } = {};
    const reply = await handle(upload, measured);
    deps.info?.('dictation', { bytes: upload.bytes.length, type: upload.contentType, ms: Date.now() - started, status: reply.status, chars: typeof reply.body['text'] === 'string' ? reply.body['text'].length : undefined, error: reply.body['error'], peakDb: measured.peakDb });
    return reply;
  });

  async function handle(upload: { bytes: Buffer; contentType: string; signal?: AbortSignal }, measured: { peakDb?: number }): Promise<DeviceApiResponse> {
    if (deps.transcriber === undefined) return answer(503, { error: 'no_transcriber', message: korean ? '받아쓰기가 꺼져 있어요. 맥에서 ax-kit setup으로 받아쓰기를 켜 주세요.' : 'Speech-to-text is off.' });
    if (upload.bytes.length < MIN_DICTATION_BYTES) return answer(400, { error: 'too_short', message: korean ? '너무 짧아서 알아듣지 못했어요.' : 'Too short to understand.' });
    if (upload.bytes.length > MAX_DICTATION_BYTES) return answer(413, { error: 'too_long', message: korean ? '너무 길어요. 긴 이야기는 회의 녹음으로 해 주세요.' : 'Too long; use a recording for long talks.' });
    await mkdir(deps.dir, { recursive: true });
    const path = join(deps.dir, `d_${randomUUID().slice(0, 12)}.${formatOf(upload.contentType)}`);
    try {
      await writeFile(path, upload.bytes);
      const text = (await deps.transcriber.transcribe(path, upload.signal)).replace(/\s+/g, ' ').trim();
      if (isMadeUp(text)) {
        const peak = await deps.loudness?.(path).catch(() => undefined);
        if (peak !== undefined) measured.peakDb = peak;
        if (peak !== undefined && peak < QUIET_PEAK_DB) {
          return answer(200, { text: '', message: korean ? '마이크 소리가 거의 들어오지 않았어요. 맥의 시스템 설정 › 사운드 › 입력에서 마이크와 입력 음량을 확인해 주세요.' : 'The microphone picked up almost nothing; check the input device and level in System Settings › Sound.' });
        }
        return answer(200, { text: '', message: korean ? '말소리를 알아듣지 못했어요. 조금 더 또렷하게 말해 주세요.' : 'No words were heard; please speak a little more clearly.' });
      }
      return answer(200, { text });
    } catch (error) {
      if (error instanceof TranscriberMissingError) {
        return answer(503, { error: 'no_transcriber', message: korean ? '이 맥에 받아쓰기 도구가 없어요. `brew install whisper-cpp ffmpeg` 후 모델을 ~/.ax-kit/models에 넣어 주세요.' : 'Speech-to-text is not installed on this Mac.' });
      }
      deps.warn('dictation: transcription failed', { error: error instanceof Error ? error.message : 'error' });
      return answer(500, { error: 'failed', message: korean ? '받아쓰기를 하지 못했어요. 다시 해 주세요.' : 'Could not transcribe; try again.' });
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}
