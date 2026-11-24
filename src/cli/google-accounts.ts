import { KeychainSecretStore, configPath, loadConfig } from '../core/index.js';
import { accountLabel } from '../connectors/google/accounts.js';
import { addGoogleAccount, listAccounts, removeGoogleAccount } from '../connectors/google/connect-account.js';

const say = (line: string): void => {
  console.log(line);
};

/** `ax-kit connect google add | accounts | remove <주소>`: more than one Google account (§33). */
export async function googleAccountsCommand(action: string, arg: string | undefined, home: string, openUrl: (url: string) => void | Promise<void>): Promise<number> {
  const secrets = new KeychainSecretStore();
  if (action === 'accounts') {
    const accounts = await listAccounts({ secrets });
    if (accounts.length === 0) {
      say('연결된 구글 계정이 없어요. ax-kit connect google 로 연결해 주세요.');
      return 1;
    }
    accounts.forEach((account, index) => say(`${index + 1}. ${accountLabel(account)}${index === 0 ? ' (기본: 새 메일·새 일정·문서는 이 계정으로)' : ''}`));
    say('메일·일정·드라이브는 모든 계정에서 모아 보고, 답장은 그 메일이 온 계정에서 보내요.');
    return 0;
  }
  if (action === 'remove') {
    if (arg === undefined) {
      say('뺄 계정 주소를 적어 주세요: ax-kit connect google remove <주소>');
      return 2;
    }
    const removed = await removeGoogleAccount({ secrets }, arg);
    say(removed.ok ? `${arg} 연결을 뺐어요. 1분 안에 비서에도 반영돼요.` : (removed.reason ?? '빼지 못했어요.'));
    return removed.ok ? 0 : 1;
  }
  const config = await loadConfig(configPath(home)).catch(() => undefined);
  const organize = config?.plugins['connector.gmail']?.['organize'] === true;
  say('브라우저가 열리면 추가할 구글 계정을 골라 로그인해 주세요 (목록에 없으면 "다른 계정 사용").');
  const added = await addGoogleAccount({ secrets, openUrl, organize });
  if (!added.ok) {
    say(added.reason);
    return 1;
  }
  say(added.again ? `${accountLabel(added.account)}은(는) 이미 연결돼 있어서 로그인만 새로 했어요.` : `✓ ${accountLabel(added.account)}을(를) 연결했어요. 1분 안에 비서가 이 계정의 메일·일정·드라이브도 봐요.`);
  if (!added.again) say('드라이브 파일은 비서를 한 번 다시 켜면 찾기 시작해요: ax-kit service install');
  return 0;
}
