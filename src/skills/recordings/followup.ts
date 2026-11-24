import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { MeetingNotes } from './notes.js';

export const DRIVE_TOPIC = 'drive:save:meeting-notes';

interface Texts {
  driveNote: (title: string, folder: string) => string;
  driveQuestion: string;
  driveSave: (folder: string) => string;
  driveSkip: string;
  driveSaved: (title: string) => string;
  driveMissing: string;
  driveFailed: string;
  ideaNote: (meeting: string, why: string) => string;
  ideaQuestion: (title: string) => string;
  ideaBot: string;
  ideaDesign: string;
  later: string;
  no: string;
  noDevBot: (title: string) => string;
  designTask: (title: string, why: string, doc: string) => string;
  buildTask: (title: string, why: string, doc: string) => string;
}

export function followupTexts(korean: boolean): Texts {
  return korean
    ? {
        driveNote: (title, folder) => `회의록 "${title}"을 정리했어요. Google Drive의 "${folder}" 폴더에도 저장해 둘까요?`,
        driveQuestion: '회의록을 Drive에 저장할까요?',
        driveSave: (folder) => `"${folder}" 폴더에 저장`,
        driveSkip: '저장하지 않기',
        driveSaved: (title) => `회의록 "${title}"을 Google Drive에 저장했어요.`,
        driveMissing: 'Google Drive를 연결하면 회의록을 Drive에도 저장할 수 있어요. 맥에서 `ax-kit connect google`을 실행해 주세요.',
        driveFailed: '회의록을 Drive에 저장하지 못했어요. Google 연결을 다시 하면 저장할 수 있어요.',
        ideaNote: (meeting, why) => `"${meeting}" 회의에서 이런 이야기가 나왔어요: ${why}`,
        ideaQuestion: (title) => `"${title}" 개발해 볼까요?`,
        ideaBot: '개발 봇에게 맡기기',
        ideaDesign: '설계만 먼저',
        later: '나중에',
        no: '안 함',
        noDevBot: (title) => `"${title}"을 맡길 개발 봇이 아직 없어요. "개발 봇 만들어 줘"라고 말씀하시면 만들어 둘게요.`,
        designTask: (title, why, doc) => `"${title}" 설계안만 먼저 써 주세요(코드는 아직). 배경: ${why} (회의록 문서 ${doc})`,
        buildTask: (title, why, doc) => `"${title}"을 만들어 주세요. 배경: ${why} (회의록 문서 ${doc})`,
      }
    : {
        driveNote: (title, folder) => `I wrote up the meeting "${title}". Save it to the "${folder}" folder in Google Drive too?`,
        driveQuestion: 'Save meeting notes to Drive?',
        driveSave: (folder) => `Save to "${folder}"`,
        driveSkip: "Don't save",
        driveSaved: (title) => `Saved the notes "${title}" to Google Drive.`,
        driveMissing: 'Connect Google Drive to save meeting notes there too: run `ax-kit connect google` on the Mac.',
        driveFailed: 'Could not save the notes to Drive. Reconnecting Google should fix it.',
        ideaNote: (meeting, why) => `This came up in the meeting "${meeting}": ${why}`,
        ideaQuestion: (title) => `Build "${title}"?`,
        ideaBot: 'Hand it to the dev bot',
        ideaDesign: 'Design first',
        later: 'Later',
        no: 'No',
        noDevBot: (title) => `There is no dev bot for "${title}" yet. Say "make a dev bot" and I will set one up.`,
        designTask: (title, why, doc) => `Write a design for "${title}" first (no code yet). Background: ${why} (meeting doc ${doc})`,
        buildTask: (title, why, doc) => `Build "${title}". Background: ${why} (meeting doc ${doc})`,
      };
}

async function tell(ctx: PluginContext, kind: string, text: string, dedupeKey?: string): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind, text, ...(dedupeKey !== undefined ? { dedupeKey } : {}) }).catch(() => undefined);
}

/** Saves to Drive: asked once (R15 remembers the answer), then done on its own with one line. */
export async function saveToDrive(
  ctx: PluginContext,
  input: { title: string; markdown: string; folder: string; texts: Texts },
): Promise<string | undefined> {
  const drive = ctx.tryUse(Contracts.driveWrite);
  if (drive === undefined) {
    await tell(ctx, 'recordings.drive', input.texts.driveMissing, 'drive-missing');
    return undefined;
  }
  const questions = ctx.tryUse(Contracts.questions);
  if (questions === undefined) return undefined;
  const answer = await questions.ask({
    topic: DRIVE_TOPIC,
    summary: input.texts.driveQuestion,
    note: input.texts.driveNote(input.title, input.folder),
    choices: [
      { id: 'save', label: input.texts.driveSave(input.folder), tone: 'primary', means: 'approved' },
      { id: 'skip', label: input.texts.driveSkip, tone: 'danger', means: 'denied' },
    ],
    askedBy: 'skill.recordings',
  });
  if (answer.status !== 'answered' || answer.means !== 'approved') return undefined;
  try {
    const saved = await drive.saveDocument({ name: input.title, markdown: input.markdown, folderName: input.folder });
    await tell(ctx, 'recordings.drive', input.texts.driveSaved(input.title));
    return saved.url;
  } catch (error) {
    ctx.log.warn('recordings: drive save failed', { error: error instanceof Error ? error.message : 'error' });
    await tell(ctx, 'recordings.drive', input.texts.driveFailed, 'drive-failed');
    return undefined;
  }
}

/** One suggestion card per idea, keyed by the idea (not the meeting), so the same idea is never offered twice. */
export async function suggestIdeas(ctx: PluginContext, notes: MeetingNotes, documentId: string, texts: Texts): Promise<void> {
  const questions = ctx.tryUse(Contracts.questions);
  if (questions === undefined) return;
  for (const idea of notes.ideas.filter((item) => item.kind === 'dev')) {
    const answer = await questions.ask({
      topic: `dev:suggest:${idea.key}`,
      summary: texts.ideaQuestion(idea.title),
      note: texts.ideaNote(notes.title, idea.why),
      choices: [
        { id: 'bot', label: texts.ideaBot, tone: 'primary', means: 'approved' },
        { id: 'design', label: texts.ideaDesign, means: 'approved' },
        { id: 'later', label: texts.later, means: 'later' },
        { id: 'no', label: texts.no, tone: 'danger', means: 'denied' },
      ],
      askedBy: 'skill.recordings',
    });
    // an idea that was already handed over is not handed over again
    if (answer.status !== 'answered' || answer.means !== 'approved' || answer.reused) continue;
    const dev = (await ctx.tryUse(Contracts.bots)?.list().catch(() => []))?.find((bot) => bot.kind === 'dev' && bot.status !== 'off');
    if (dev === undefined) {
      await tell(ctx, 'recordings.suggest', texts.noDevBot(idea.title));
      continue;
    }
    const task = answer.choice === 'design' ? texts.designTask(idea.title, idea.why, documentId) : texts.buildTask(idea.title, idea.why, documentId);
    const outcome = await ctx.tools.execute('bots.delegate', { bot: dev.id, task: task.slice(0, 1000) });
    if (outcome.status !== 'done') ctx.log.warn('recordings: hand-off did not run', { status: outcome.status });
  }
}
