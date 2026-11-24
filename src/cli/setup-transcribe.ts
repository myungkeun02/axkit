import { join } from 'node:path';
import type { Prompter } from './prompter.js';

/**
 * R18: speech-to-text for meeting recordings, on this Mac (whisper.cpp + ffmpeg + one model file). Recordings never
 * leave the Mac. Safe to run again: whatever is already there is skipped.
 */
export const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';
export const WHISPER_MODEL_FILE = 'ggml-large-v3-turbo.bin';
/** Silero VAD for whisper.cpp (under 1MB): silence and noise are not written out as made-up words. */
export const VAD_MODEL_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin';
export const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin';

export interface TranscribeStepDeps {
  prompter: Prompter;
  home: string;
  hasCommand(name: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** Runs a program with the terminal attached (progress bars show); resolves to its exit code. */
  run(cmd: string, args: readonly string[]): Promise<number>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** `ask: false` installs without the question (the first setup installs the basics by default). */
export async function setupTranscriber(deps: TranscribeStepDeps, opts: { ask?: boolean } = {}): Promise<boolean> {
  const { prompter } = deps;
  const model = join(deps.home, 'models', WHISPER_MODEL_FILE);
  const tools = (await deps.hasCommand('whisper-cli')) && (await deps.hasCommand('ffmpeg'));
  const hasModel = await deps.exists(model);
  const vad = join(deps.home, 'models', VAD_MODEL_FILE);
  // small and optional: a failed download only means no VAD
  const ensureVad = async (): Promise<void> => {
    if (await deps.exists(vad)) return;
    await deps.mkdir(join(deps.home, 'models'));
    if ((await deps.run('curl', ['-fsSL', '--retry', '3', '-o', `${vad}.part`, VAD_MODEL_URL])) === 0) await deps.rename(`${vad}.part`, vad);
  };
  if (tools && hasModel) {
    await ensureVad();
    prompter.say('받아쓰기: 이미 준비돼 있어요 (whisper.cpp + 모델).');
    return true;
  }
  const answer =
    opts.ask === false
      ? 'install'
      : await prompter.choose(
          '회의 녹음을 글로 바꾸는 받아쓰기를 이 맥에 설치할까요? (녹음은 맥 밖으로 나가지 않아요, 모델 약 1.6GB)',
          [
            { value: 'install', label: '지금 설치' },
            { value: 'later', label: '나중에' },
          ],
          0,
        );
  if (answer !== 'install') return false;
  if (opts.ask === false) prompter.say('받아쓰기(회의 녹음 → 글)를 설치해요. 모델이 약 1.6GB라 몇 분 걸려요.');
  if (!tools) {
    if (!(await deps.hasCommand('brew'))) {
      prompter.say('Homebrew가 없어요. https://brew.sh 에서 설치한 뒤 다시 실행해 주세요.');
      return false;
    }
    prompter.say('brew install whisper-cpp ffmpeg …');
    if ((await deps.run('brew', ['install', 'whisper-cpp', 'ffmpeg'])) !== 0) {
      prompter.say('설치하지 못했어요. 터미널에서 `brew install whisper-cpp ffmpeg`를 실행해 주세요.');
      return false;
    }
  }
  if (!hasModel) {
    await deps.mkdir(join(deps.home, 'models'));
    prompter.say('받아쓰기 모델을 받는 중이에요 (약 1.6GB) …');
    const part = `${model}.part`;
    if ((await deps.run('curl', ['-fL', '--retry', '3', '-C', '-', '-o', part, WHISPER_MODEL_URL])) !== 0) {
      prompter.say('모델을 받지 못했어요. 인터넷을 확인하고 다시 실행하면 이어서 받아요.');
      return false;
    }
    await deps.rename(part, model);
  }
  await ensureVad();
  prompter.say('받아쓰기 준비 끝. 앱에서 녹음하면 맥이 회의록으로 정리해요.');
  return true;
}
