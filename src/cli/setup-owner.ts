import type { Config } from '../core/config/schema.js';
import type { Prompter } from './prompter.js';

export interface PairOwnerOptions {
  token: string;
  code: string;
  language: string;
}

export interface PairOwnerOutcome {
  userId: string;
}

export type PairOwner = (opts: PairOwnerOptions) => Promise<PairOwnerOutcome>;

export interface OwnerStepDeps {
  prompter: Prompter;
  token: string;
  language: string;
  existing?: Config;
  newPairingCode: () => string;
  pairOwner: PairOwner;
}

const DM_INSTRUCTION = '디스코드에서 봇에게 DM으로 이 6자리 코드를 보내 주세요. 10분 안에 보내면 돼요.';

function spacedCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function validateOwnerId(value: string): string | undefined {
  return /^\d{5,25}$/.test(value) ? undefined : '숫자 5~25자리로 입력해 주세요.';
}

async function askManualOwner(prompter: Prompter, existing: Config | undefined): Promise<string> {
  prompter.say('Discord 설정 > 고급 > 개발자 모드를 켠 뒤, 내 이름을 우클릭 > 사용자 ID 복사.');
  const existingId = existing?.owner.discordUserId;
  return await prompter.text('디스코드 사용자 ID', {
    validate: validateOwnerId,
    ...(existingId !== undefined ? { default: existingId } : {}),
  });
}

/** Returns the owner's Discord user id, by DM pairing or, on request, the manual id fallback. */
export async function askOwner(deps: OwnerStepDeps): Promise<string> {
  const { prompter, existing } = deps;
  const existingId = existing?.owner.discordUserId;

  if (existingId !== undefined) {
    const choice = await prompter.choose(
      '주인(나)을 다시 지정할까요?',
      [
        { value: 'keep', label: '그대로 두기 (기존 주인)' },
        { value: 'pair', label: 'DM으로 다시 지정' },
      ],
      0,
    );
    if (choice === 'keep') {
      prompter.say('기존 주인을 그대로 둘게요.');
      return existingId;
    }
  }

  for (;;) {
    const code = deps.newPairingCode();
    prompter.say(`페어링 코드: ${spacedCode(code)}`);
    prompter.say(DM_INSTRUCTION);
    try {
      const outcome = await deps.pairOwner({ token: deps.token, code, language: deps.language });
      prompter.say('주인을 확인했어요.');
      return outcome.userId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      prompter.say(`DM으로 주인을 확인하지 못했어요: ${message}`);
    }
    const choice = await prompter.choose(
      '다음에 무엇을 할까요?',
      [
        { value: 'retry', label: '다시 시도 (새 코드)' },
        { value: 'manual', label: '사용자 ID 직접 입력 (개발자 모드)' },
      ],
      0,
    );
    if (choice === 'manual') break;
  }

  return await askManualOwner(prompter, existing);
}
