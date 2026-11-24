import { z } from 'zod';

/** Where the lead coder writes the parts it hands to parallel sessions (removed before anything is committed). */
export const PLAN_FILE = '.ax-self-plan.json';
export const MAX_PIECES = 4;

export interface Piece {
  title: string;
  brief: string;
  files: string[];
}

const PieceSchema = z.object({
  title: z.string().trim().min(1).max(60),
  brief: z.string().trim().min(1).max(4000),
  files: z.array(z.string().trim().min(1)).default([]),
});
const PlanSchema = z.object({ pieces: z.array(PieceSchema).max(MAX_PIECES) });

const norm = (file: string): string => file.replace(/^\.\//, '').replace(/\/+$/, '');
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * The pieces from the plan file, or why they cannot run side by side (two pieces on the same file, too many, not
 * JSON). An empty list is a plan that keeps everything with the lead.
 */
export function parsePlan(text: string): { ok: true; pieces: Piece[] } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '나눈 계획을 읽지 못했어요 (JSON이 아니에요)' };
  }
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `나눈 계획의 모양이 맞지 않아요 (하위 작업은 ${MAX_PIECES}개까지)` };
  const pieces = parsed.data.pieces.map((piece) => ({ title: piece.title.slice(0, 30), brief: piece.brief, files: piece.files.map(norm) }));
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = i + 1; j < pieces.length; j += 1) {
      const shared = pieces[i]?.files.find((file) => pieces[j]?.files.some((other) => overlaps(file, other)));
      if (shared !== undefined) return { ok: false, reason: `두 하위 작업이 같은 파일(${shared})을 고쳐서 동시에 할 수 없어요` };
    }
  }
  return { ok: true, pieces };
}

/** What the lead may do besides coding: hand independent parts to parallel sessions, as a lead developer would. */
export const SPLIT_RULES = [
  'You are the lead of this request. Like a lead developer opening parallel sessions, you may hand parts to other coders that run at the same time, each in its own worktree:',
  `- Split only when it is clearly faster: two or more parts that touch different files and need nothing from each other. A small or tightly coupled change stays with you. Never split tests from the code they test.`,
  `- To split, do your own part here (or none), and write the other parts (at most ${MAX_PIECES}) to \`${PLAN_FILE}\` in this folder:`,
  '  {"pieces":[{"title":"짧은 한국어 제목","brief":"self-contained: what to do, which files, what done looks like","files":["src/..."]}]}',
  '- Each brief is all that coder will know: name the files and the behaviour, not "the rest". Pieces must not share files with each other or with your part.',
  '- Their work is merged into yours afterwards and everything is checked together; you do not wait for them.',
].join('\n');

/** The instructions for a piece's own coder (a parallel session): its brief only, no further splitting. */
export function pieceInstructions(request: string, piece: Piece): string {
  return [
    'You are one of several coders working at the same time on ax-kit itself (the local assistant this very process runs). The owner asked:',
    `<request>\n${request}\n</request>`,
    'The lead gave you this part; other coders do the other parts in their own folders, and the lead merges everything afterwards:',
    `<part title="${piece.title}">\n${piece.brief}\n</part>`,
    piece.files.length > 0 ? `Stay within these files where you can: ${piece.files.join(', ')}. Do not edit files outside your part.` : 'Do not edit files outside your part.',
    `Do not split further (no ${PLAN_FILE}).`,
  ].join('\n');
}

/** A follow-up the owner sent in a piece's room, on top of what was asked and done so far. */
export function followUpInstructions(base: string, done: readonly string[], message: string): string {
  return [
    base,
    done.length > 0 ? `What you did so far (already in this folder):\n${done.map((line) => `- ${line}`).join('\n')}` : '',
    `The owner now says, in this part's room:\n<message>\n${message}\n</message>`,
    'Continue the same work in this folder with that in mind.',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}
