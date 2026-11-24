import type { Config } from '../core/config/schema.js';
import { fileTexts } from '../mobile/files/index.js';
import type { ShortcutKind } from '../mobile/files/index.js';

const IOS_GUIDE = 'docs/guides/phone-ios.md';
const ICLOUD_PREFIX = 'https://www.icloud.com/shortcuts/';
const SHORTCUT_KINDS: readonly ShortcutKind[] = ['location', 'sms', 'steps', 'voice_memo'];

interface Sayer {
  say(line: string): void;
}

interface IcloudLink { kind: ShortcutKind; url: string; }

/** Only well-formed iCloud shortcut links are offered; anything else could send the owner elsewhere. */
function icloudLinks(config: Config): IcloudLink[] {
  const raw = config.plugins['bridge.mobile']?.icloudLinks;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  return SHORTCUT_KINDS.flatMap((kind) => {
    const value = record[kind];
    if (typeof value !== 'string' || !value.startsWith(ICLOUD_PREFIX)) return [];
    return value.length > ICLOUD_PREFIX.length ? [{ kind, url: value }] : [];
  });
}

export function printUnsignedGuide(deps: Sayer, config: Config): void {
  const labels = fileTexts(config.assistant.language).shortcutLabels;
  deps.say('단축어 서명에 실패했어요. 아래 순서대로 해 보세요.');
  deps.say('1) 이 Mac이 iCloud에 로그인되어 있고 인터넷이 되는지 확인한 뒤 `ax-kit phone pair`를 다시 실행해요.');
  const links = icloudLinks(config);
  if (links.length > 0) {
    deps.say('2) iCloud 링크로 설치해요. iPhone에서 아래 링크를 열고 "단축어 추가"를 누른 뒤, 연결 문자열을 붙여 넣어 주세요.');
    for (const link of links) deps.say(`   - ${labels[link.kind]}: ${link.url}`);
    deps.say('   연결 문자열은 휴대폰 연결 페이지에서 6자리 코드를 넣은 뒤에 보여요. 터미널에는 표시하지 않아요.');
  } else {
    deps.say('2) 아직 iCloud 링크가 없어요. 서명할 수 있는 Mac에서 한 번만 링크를 만들어 두면 다음부터 안내해 드려요.');
    deps.say('   `ax-kit phone template --out <폴더>`로 서명 없는 템플릿 4개를 만들고, 서명할 수 있는 Mac의 단축어 앱에서 열어 추가한 뒤 공유 → iCloud 링크를 복사해요.');
    deps.say('   링크를 설정 파일의 plugins["bridge.mobile"].icloudLinks에 종류별로 넣어 주세요.');
  }
  deps.say(`   안내: ${IOS_GUIDE}`);
}

