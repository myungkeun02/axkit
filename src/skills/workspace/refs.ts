const BARE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const PATH_ID = /\/(?:document|spreadsheets|file|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,200})/;

/**
 * The file id in a Google Docs/Sheets/Drive address, or the id itself. Drive search results (files.search with
 * source "drive") already carry it. Undefined for anything else, so a tool never calls Google with a made-up path.
 */
export function googleFileId(ref: string): string | undefined {
  const text = ref.trim();
  if (BARE_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) return undefined;
  const fromPath = PATH_ID.exec(url.pathname)?.[1];
  if (fromPath !== undefined) return fromPath;
  const fromQuery = url.searchParams.get('id');
  return fromQuery !== null && BARE_ID.test(fromQuery) ? fromQuery : undefined;
}

const TITLES = [
  '대표이사', '대표', '사장', '회장', '부회장', '전무', '상무', '이사', '본부장', '실장', '센터장', '팀장', '부장', '차장',
  '과장', '대리', '주임', '사원', '매니저', '프로', '책임', '선임', '수석', '원장', '교수', '박사', '선생', '변호사', '세무사',
  '회계사', '의원', '총장', '국장', '소장', '고문', 'CEO', 'CTO', 'CFO', 'COO',
].sort((left, right) => right.length - left.length);
const HONORIFIC = /(님|씨|께서|께)$/;

export interface ContactQuery {
  /** What to send to the address book search. */
  term: string;
  /** Titles the owner said ("대표"), used to rank people with that title first. */
  titles: string[];
}

/** "김 대표님" → search "김", prefer people titled 대표. Emails and phone numbers pass through untouched. */
export function contactQuery(raw: string): ContactQuery {
  const text = raw.trim();
  if (text.includes('@') || /^[+\d][\d\s-]{5,}$/.test(text)) return { term: text, titles: [] };
  const titles: string[] = [];
  const words: string[] = [];
  for (const piece of text.split(/\s+/)) {
    let word = piece.replace(HONORIFIC, '');
    const title = TITLES.find((candidate) => word.toUpperCase().endsWith(candidate.toUpperCase()));
    if (title !== undefined) {
      titles.push(title);
      word = word.slice(0, word.length - title.length).replace(HONORIFIC, '');
    }
    if (word !== '') words.push(word);
  }
  const term = words.join(' ');
  return { term: term === '' ? (titles[0] ?? text) : term, titles };
}
