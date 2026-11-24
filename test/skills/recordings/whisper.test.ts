import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { TranscriberMissingError, transcribeConfigSchema, whisperTranscriber } from '../../../src/skills/recordings/transcribe.js';

function whisperConfig(model: string, vadModel = '/nope/vad.bin') {
  const config = transcribeConfigSchema.parse({ kind: 'whisper', model, vadModel, ffmpeg: '/bin/ffmpeg', whisperCli: '/bin/whisper-cli' });
  if (config.kind !== 'whisper') throw new Error('expected whisper');
  return config;
}

describe('local whisper transcriber', () => {
  it('converts to 16 kHz wav, runs whisper-cli in the owner language and cleans up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axkit-whisper-'));
    const model = join(dir, 'model.bin');
    await writeFile(model, 'm');
    const audio = join(dir, 'audio.m4a');
    await writeFile(audio, 'a');
    const calls: string[][] = [];
    const run: ProcessRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd.endsWith('ffmpeg')) await writeFile(args[args.length - 1] ?? '', 'wav');
      else await writeFile(`${args[args.indexOf('-of') + 1] ?? ''}.txt`, ' 안녕하세요 \n');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    expect(await whisperTranscriber(whisperConfig(model), run, 'ko').transcribe(audio)).toBe('안녕하세요');
    expect(calls[0]).toEqual(expect.arrayContaining(['/bin/ffmpeg', '-i', audio, '-ar', '16000', '-ac', '1']));
    expect(calls[1]).toEqual(expect.arrayContaining(['/bin/whisper-cli', '-m', model, '-l', 'ko', '-otxt']));
    expect(calls[1]).not.toContain('--vad');
    // with the VAD model there, only the parts with speech are transcribed
    const vad = join(dir, 'vad.bin');
    await writeFile(vad, 'v');
    calls.length = 0;
    await whisperTranscriber(whisperConfig(model, vad), run, 'ko').transcribe(audio);
    expect(calls[1]).toEqual(expect.arrayContaining(['--vad', '-vm', vad]));
    expect((await readdir(dir)).sort()).toEqual(['audio.m4a', 'model.bin', 'vad.bin']);
  });

  it('says the tools are missing instead of failing with an exit code', async () => {
    const run: ProcessRunner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(whisperTranscriber(whisperConfig('/nope/model.bin'), run, 'ko').transcribe('/nope/a.m4a')).rejects.toBeInstanceOf(TranscriberMissingError);
  });
});
