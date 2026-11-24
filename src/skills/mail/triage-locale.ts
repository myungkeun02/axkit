export interface TriageTexts {
  readonly highLine: (who: string, subject: string, summary: string, suggestion: string) => string;
  readonly suggestReply: string;
  readonly suggestEvent: (title: string) => string;
  readonly suggestTodo: (text: string) => string;
  readonly suggestNothing: string;
  readonly digestTitle: (count: number) => string;
  readonly digestLine: (who: string, subject: string, summary: string) => string;
  readonly digestMore: (count: number) => string;
  readonly noSubject: string;
  readonly replyQuestion: (who: string) => string;
  readonly replyNote: (subject: string, body: string) => string;
  readonly eventQuestion: (title: string) => string;
  readonly todoQuestion: (text: string) => string;
  readonly fromNote: (who: string, subject: string, evidence?: string) => string;
  readonly replyYes: string;
  readonly eventYes: string;
  readonly todoYes: string;
  readonly teamYes: string;
  readonly teamDetail: string;
  readonly teamHanded: (text: string) => string;
  readonly later: string;
  readonly no: string;
  readonly sent: (who: string) => string;
  readonly draftKept: string;
  readonly eventAdded: (title: string) => string;
  readonly todoAdded: (text: string) => string;
  readonly composeLabel: string;
  readonly muteLabel: string;
  readonly digestArchive: (count: number) => string;
  readonly archiveQuestion: (count: number) => string;
  readonly archiveNote: string;
  readonly archiveYes: string;
  readonly archived: (count: number) => string;
  readonly drafted: (who: string) => string;
  readonly attachedFiles: (paths: readonly string[]) => string;
  readonly fileNotFound: (wants: string) => string;
  readonly spoofed: (who: string, subject: string, reason: 'dmarc' | 'spf-dkim' | 'display-name') => string;
  readonly checkFacts: (facts: readonly string[]) => string;
}

const KO: TriageTexts = {
  highLine: (who, subject, summary, suggestion) => `중요 메일 · ${who}: ${subject}\n${summary}\n제안: ${suggestion}`,
  suggestReply: '답장 초안을 써 두고 보낼지 물어볼게요.',
  suggestEvent: (title) => `'${title}' 일정을 캘린더에 넣을지 물어볼게요.`,
  suggestTodo: (text) => `'${text}'을(를) 할 일로 추가할지 물어볼게요.`,
  suggestNothing: '지금 따로 하실 일은 없어 보여요.',
  digestTitle: (count) => `새 메일 ${count}통 정리`,
  digestLine: (who, subject, summary) => `- ${who}: ${subject} — ${summary}`,
  digestMore: (count) => `그 밖에 ${count}통이 더 있어요.`,
  noSubject: '(제목 없음)',
  replyQuestion: (who) => `${who}님 메일에 답장 초안을 만들어 둘까요?`,
  replyNote: (subject, body) => `메일: ${subject}\n초안:\n${body}\n만든 뒤 보낼지는 한 번 더 물어볼게요.`,
  eventQuestion: (title) => `'${title}' 일정을 캘린더에 넣을까요?`,
  todoQuestion: (text) => `'${text}'을(를) 할 일에 추가할까요?`,
  fromNote: (who, subject, evidence) =>
    evidence === undefined ? `${who}님 메일 "${subject}"에서 찾았어요.` : `${who}님 메일 "${subject}"에서: "${evidence}"`,
  replyYes: '초안 만들기',
  eventYes: '캘린더에 넣기',
  todoYes: '할 일에 추가',
  teamYes: '팀에 맡기기',
  teamDetail: '맞는 팀이 계획하고 하고 검토한 뒤 알려 드려요.',
  teamHanded: (text) => `'${text}'을(를) 팀에 맡겼어요. 끝나면 알려 드릴게요.`,
  later: '나중에',
  no: '괜찮아요',
  sent: (who) => `${who}님께 답장을 보냈어요.`,
  draftKept: '답장 초안은 메일함 임시보관함에 남겨 뒀어요.',
  eventAdded: (title) => `'${title}' 일정을 캘린더에 넣었어요.`,
  todoAdded: (text) => `'${text}'을(를) 할 일에 추가했어요.`,
  composeLabel: '새 메일 초안',
  muteLabel: '메일 정리에서 빼기',
  digestArchive: (count) => `광고·알림 메일 ${count}통은 보관할지 따로 물어볼게요.`,
  archiveQuestion: (count) => `광고·알림 메일 ${count}통을 보관할까요?`,
  archiveNote: '보관하면 받은편지함에서만 빠지고 지워지지 않아요. Gmail "전체보관함"에서 언제든 다시 볼 수 있어요.',
  archiveYes: '보관하기',
  archived: (count) => `광고·알림 메일 ${count}통을 보관했어요.`,
  drafted: (who) => `${who}님 메일에 답장 초안을 써 뒀어요(임시보관함). 보낼지만 골라 주세요.`,
  attachedFiles: (paths) => `첨부: ${paths.join(', ')}`,
  fileNotFound: (wants) => `요청한 자료(${wants})는 이 맥에서 찾지 못해 첨부하지 않았어요.`,
  spoofed: (who, subject, reason) =>
    `⚠️ 위조 의심 메일 · ${who}: ${subject}\n${reason === 'display-name' ? '보낸 사람 이름에 다른 주소가 들어 있어요.' : '보낸 사람 인증(SPF·DKIM·DMARC)이 실패했어요.'} 링크·첨부를 열지 말고, 아는 연락처로 따로 확인해 주세요. 이 메일에는 초안을 쓰지 않았어요.`,
  checkFacts: (facts) => `확인 필요: 초안의 ${facts.map((fact) => `"${fact}"`).join(', ')}은(는) 메일이나 찾은 정보에 없어요.`,
};

const EN: TriageTexts = {
  highLine: (who, subject, summary, suggestion) => `Important mail · ${who}: ${subject}\n${summary}\nSuggestion: ${suggestion}`,
  suggestReply: 'I will draft a reply and ask whether to send it.',
  suggestEvent: (title) => `I will ask whether to put "${title}" on your calendar.`,
  suggestTodo: (text) => `I will ask whether to add "${text}" to your to-dos.`,
  suggestNothing: 'Nothing to do right now.',
  digestTitle: (count) => `${count} new mails`,
  digestLine: (who, subject, summary) => `- ${who}: ${subject} — ${summary}`,
  digestMore: (count) => `${count} more.`,
  noSubject: '(no subject)',
  replyQuestion: (who) => `Draft a reply to ${who}?`,
  replyNote: (subject, body) => `Mail: ${subject}\nDraft:\n${body}\nI will ask once more before sending.`,
  eventQuestion: (title) => `Put "${title}" on your calendar?`,
  todoQuestion: (text) => `Add "${text}" to your to-dos?`,
  fromNote: (who, subject, evidence) =>
    evidence === undefined ? `From ${who}'s mail "${subject}".` : `From ${who}'s mail "${subject}": "${evidence}"`,
  replyYes: 'Draft it',
  eventYes: 'Add to calendar',
  todoYes: 'Add to-do',
  teamYes: 'Hand to a team',
  teamDetail: 'The right team plans, does and reviews it, then reports.',
  teamHanded: (text) => `Handed "${text}" to a team. You will hear when it is done.`,
  later: 'Later',
  no: 'No thanks',
  sent: (who) => `Reply sent to ${who}.`,
  draftKept: 'The reply draft stays in your Drafts.',
  eventAdded: (title) => `Added "${title}" to your calendar.`,
  todoAdded: (text) => `Added "${text}" to your to-dos.`,
  composeLabel: 'New mail draft',
  muteLabel: 'Leave out of mail triage',
  digestArchive: (count) => `I will ask separately about archiving ${count} promotional mails.`,
  archiveQuestion: (count) => `Archive ${count} promotional mails?`,
  archiveNote: 'Archiving only takes them out of the inbox; nothing is deleted. They stay in "All Mail".',
  archiveYes: 'Archive',
  archived: (count) => `Archived ${count} promotional mails.`,
  drafted: (who) => `I wrote a reply draft to ${who} (in Drafts). Just choose whether to send it.`,
  attachedFiles: (paths) => `Attached: ${paths.join(', ')}`,
  fileNotFound: (wants) => `I could not find what was asked for (${wants}) on this Mac, so nothing is attached.`,
  spoofed: (who, subject, reason) =>
    `⚠️ Possibly forged mail · ${who}: ${subject}\n${reason === 'display-name' ? 'The sender name carries a different address.' : 'Sender authentication (SPF/DKIM/DMARC) failed.'} Do not open links or attachments; check with the person another way. No draft was written.`,
  checkFacts: (facts) => `Check: ${facts.map((fact) => `"${fact}"`).join(', ')} in the draft is not in the mail or what I found.`,
};

export function triageTexts(language: string): TriageTexts {
  return language === 'en' ? EN : KO;
}

/** "Mina Kim <mina@example.com>" → "Mina Kim"; a bare address stays as it is. */
export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  const name = match?.[1]?.trim();
  if (name !== undefined && name !== '') return name;
  return from.replace(/[<>]/g, '').trim() || '?';
}
