const MAX_TEXT_CHARS = 200_000;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const COMMENT = /<!--[\s\S]*?-->/g;
const DROP = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK =
  /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;
const TAG = /<[^>]*>/g;

function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return '';
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => codePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function plain(fragment: string): string {
  return decodeEntities(fragment.replace(TAG, ' '))
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

function normalize(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '');
  return lines.join('\n').trim().slice(0, MAX_TEXT_CHARS);
}

export interface HtmlText {
  title?: string;
  text: string;
}

/** Visible text of an HTML page: scripts, styles and markup gone, line breaks kept. */
export function htmlToText(html: string): HtmlText {
  const titleMatch = TITLE.exec(html);
  const title = titleMatch?.[1] === undefined ? undefined : plain(titleMatch[1]);
  const body = html.replace(COMMENT, ' ').replace(DROP, ' ').replace(BLOCK, '\n').replace(TAG, ' ');
  const text = normalize(decodeEntities(body));
  return {
    ...(title !== undefined && title !== '' ? { title } : {}),
    text,
  };
}
