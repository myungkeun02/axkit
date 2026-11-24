import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { AppView } from '../../core/contracts/device-api.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { followupTexts, saveToDrive, suggestIdeas } from './followup.js';
import { notesMarkdown, summarizeMeeting } from './notes.js';
import { RecordingStore } from './store.js';
import type { Recording } from './store.js';
import { canTranscribe, ffmpegLoudness, registerDictation } from './dictation.js';
import { TranscriberMissingError, apiTranscriber, commandTranscriber, transcribeConfigSchema, whisperTranscriber } from './transcribe.js';
import type { Transcriber } from './transcribe.js';
import { assembleRecording, registerRecordingUpload } from './upload.js';

const configSchema = z.object({
  transcribe: transcribeConfigSchema.optional(),
  driveFolder: z.string().trim().min(1).max(60).optional(),
});

export interface RecordingsOptions {
  /** ~/.ax-kit/files/recordings; tests use a temp folder. */
  dir?: string;
  /** Tests inject a fake (null: none); production builds one from config, local whisper when unset. */
  transcriber?: Transcriber | null;
}

function view(store: RecordingStore): AppView {
  return {
    name: 'recordings',
    version: 1,
    async read() {
      return {
        recordings: (await store.list()).map((r) => ({
          id: r.id,
          ...(r.title !== undefined ? { title: r.title } : {}),
          startedAt: r.startedAt,
          durationSec: r.durationSec,
          status: r.status,
          ...(r.statusText !== undefined ? { statusText: r.statusText } : {}),
          ...(r.documentId !== undefined ? { documentId: r.documentId } : {}),
          ...(r.driveUrl !== undefined ? { driveUrl: r.driveUrl } : {}),
        })),
      };
    },
  };
}

/**
 * Recording → meeting notes (R14). The phone uploads the audio in chunks; this Mac transcribes it, writes structured
 * notes as a document (it shows in the document map), offers to save it to Google Drive once, and suggests each
 * buildable idea once (by idea, R15). Audio and transcripts never leave this Mac except to the transcriber the owner chose.
 */
export function recordingsSkill(options: RecordingsOptions = {}): Plugin {
  return {
    manifest: { id: 'skill.recordings', kind: 'skill', title: 'Recordings and meeting notes', needs: [Contracts.deviceApi] },
    setup(ctx) {
      const parsed = configSchema.safeParse(ctx.config);
      if (!parsed.success) ctx.log.warn('recordings: invalid config, transcription is off');
      const config = parsed.success ? parsed.data : {};
      const korean = ctx.assistant.language !== 'en';
      const texts = followupTexts(korean);
      const folder = config.driveFolder ?? (korean ? 'ax-kit 회의록' : 'ax-kit meeting notes');
      const store = new RecordingStore(ctx.kv, options.dir ?? join(homedir(), '.ax-kit', 'files', 'recordings'));
      // unset: whisper.cpp on this Mac, so recordings never leave it unless the owner picks an API
      const chosen = config.transcribe ?? transcribeConfigSchema.parse({ kind: 'whisper' });
      const transcriber =
        options.transcriber !== undefined
          ? (options.transcriber ?? undefined)
          : chosen.kind === 'api'
            ? apiTranscriber(chosen, ctx.secrets)
            : chosen.kind === 'whisper'
              ? whisperTranscriber(chosen, nodeProcessRunner, korean ? 'ko' : 'en')
              : commandTranscriber(chosen, nodeProcessRunner);

      const process = (id: string, audioPath: string): void => {
        void processRecording(ctx, { store, transcriber, id, audioPath, korean, folder, texts }).catch((error: unknown) => {
          ctx.log.warn('recordings: processing failed', { error: error instanceof Error ? error.message : 'error' });
        });
      };
      const warn = (message: string, fields: Record<string, unknown>): void => ctx.log.warn(message, fields);
      registerRecordingUpload({ api: ctx.use(Contracts.deviceApi), store, clock: ctx.clock, onComplete: process, warn });
      registerDictation({ api: ctx.use(Contracts.deviceApi), transcriber, dir: join(options.dir ?? join(homedir(), '.ax-kit', 'files', 'recordings'), '.dictation'), korean, warn, info: (message, fields) => ctx.log.info(message, fields), loudness: ffmpegLoudness(nodeProcessRunner) });
      ctx.bus.on('app.started', async () => {
        const views = ctx.tryUse(Contracts.appViews);
        views?.register(view(store));
        views?.addFeature?.('recordings');
        // the mic button shows only when speech-to-text can really run here (model and tools, not just a setting)
        if (transcriber !== undefined && (await canTranscribe(chosen))) views?.addFeature?.('dictation');
        // a restart in the middle of processing picks the recording up again
        for (const r of await store.list()) {
          if (r.status === 'transcribing' || r.status === 'summarizing') process(r.id, store.audioPath(r.id, r.format ?? 'm4a'));
          // stopped while joining the audio: finish the join (or hand it back to the phone's retry)
          if (r.status === 'assembling') await assembleRecording({ store, clock: ctx.clock, onComplete: process, warn }, r.id, true);
        }
      });
    },
  };
}

interface ProcessInput {
  store: RecordingStore;
  transcriber: Transcriber | undefined;
  id: string;
  audioPath: string;
  korean: boolean;
  folder: string;
  texts: ReturnType<typeof followupTexts>;
}

async function processRecording(ctx: PluginContext, input: ProcessInput): Promise<void> {
  const { store, id, korean } = input;
  const now = (): Date => ctx.clock.now();
  const fail = async (text: string): Promise<void> => {
    await store.update(id, { status: 'failed', statusText: text }, now());
    await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'recordings.failed', text, dedupeKey: text }).catch(() => undefined);
  };
  if (input.transcriber === undefined) {
    return await fail(korean ? '받아쓰기 도구가 연결되지 않아 회의록을 만들지 못했어요. 설정에서 받아쓰기를 연결해 주세요.' : 'No transcriber is set up, so no notes were made.');
  }
  let transcript: string;
  try {
    await store.update(id, { status: 'transcribing', statusText: korean ? '받아쓰는 중' : 'Transcribing' }, now());
    transcript = await input.transcriber.transcribe(input.audioPath);
  } catch (error) {
    if (error instanceof TranscriberMissingError) {
      return await fail(korean
        ? '이 맥에 받아쓰기 도구가 아직 없어요. 맥에서 `brew install whisper-cpp ffmpeg`를 실행하고 받아쓰기 모델(ggml-large-v3-turbo.bin)을 ~/.ax-kit/models에 넣어 주세요.'
        : 'Speech-to-text is not installed on this Mac: run `brew install whisper-cpp ffmpeg` and put ggml-large-v3-turbo.bin in ~/.ax-kit/models.');
    }
    ctx.log.warn('recordings: transcription failed', { error: error instanceof Error ? error.message : 'error' });
    return await fail(korean ? `받아쓰기를 하지 못했어요 (${error instanceof Error ? error.message : '오류'}).` : 'Transcription failed.');
  }
  if (transcript.trim() === '') return await fail(korean ? '녹음에서 말소리를 찾지 못했어요.' : 'No speech was found in the recording.');
  await store.saveText(id, 'transcript.txt', transcript);
  await store.update(id, { status: 'summarizing', statusText: korean ? '회의록 쓰는 중' : 'Writing notes' }, now());

  const recording = (await store.get(id)) as Recording;
  const notes = await summarizeMeeting(ctx.llm, transcript, korean).catch(() => undefined);
  if (notes === undefined) return await fail(korean ? '회의록을 정리하지 못했어요. 잠시 뒤 다시 해 볼게요.' : 'Could not write the notes.');
  const markdown = notesMarkdown(notes, recording.startedAt, korean);
  await store.saveText(id, 'notes.md', markdown);
  const docId = `meeting:${id}`;
  await ctx.tryUse(Contracts.docs)?.upsert({ id: docId, kind: 'meeting', scope: 'meetings', title: notes.title, body: markdown, author: { kind: 'agent', id: 'skill.recordings' } });
  await store.update(id, { status: 'done', title: notes.title, documentId: `d:${docId}` }, now());
  await ctx.tryUse(Contracts.workLog)?.add({ at: now(), title: notes.title, kind: 'recording' }).catch(() => undefined);
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'recordings.done', text: korean ? `회의록을 정리했어요: ${notes.title}` : `Meeting notes ready: ${notes.title}` }).catch(() => undefined);

  const driveUrl = await saveToDrive(ctx, { title: notes.title, markdown, folder: input.folder, texts: input.texts });
  if (driveUrl !== undefined) await store.update(id, { driveUrl }, now());
  await suggestIdeas(ctx, notes, `d:${docId}`, input.texts);
}
