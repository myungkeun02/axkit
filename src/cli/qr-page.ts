import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toString as qrToString } from 'qrcode';

const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** What the QR is for, in plain words, from what it holds. */
export function qrCaption(text: string): { title: string; hint: string } {
  if (text.startsWith('axkit://pair')) return { title: '앱 연결', hint: '앱에서 "QR로 연결"을 누르고 이 QR을 찍어 주세요. 10분 안에, 한 번만 쓸 수 있어요.' };
  if (text.includes('/m/apk/')) return { title: '안드로이드 앱 받기', hint: '휴대폰 카메라로 이 QR을 찍으면 앱 파일을 받아요. 30분 동안 쓸 수 있어요.' };
  return { title: 'QR', hint: '휴대폰 카메라로 이 QR을 찍어 주세요.' };
}

/** A page with the QR, big enough to scan from the screen (the terminal one is hard to read). */
export async function qrPageHtml(text: string): Promise<string> {
  const svg = await qrToString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  const { title, hint } = qrCaption(text);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ax-kit · ${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f5;font-family:-apple-system,sans-serif;color:#18181b}
main{background:#fff;border-radius:16px;padding:32px;max-width:440px;text-align:center;box-shadow:0 2px 12px #0001}
.qr svg{width:340px;height:340px}h1{font-size:22px;margin:0 0 8px}p{line-height:1.5;margin:8px 0}code{display:block;word-break:break-all;font-size:12px;color:#71717a;margin-top:16px;user-select:all}</style></head>
<body><main><h1>${title}</h1><div class="qr">${svg}</div><p>${escape(hint)}</p><code>${escape(text)}</code></main></body></html>`;
}

/** Writes the page to a private temp file and opens it in the browser; false when it could not be opened. */
export async function openQrPage(text: string, open: (path: string) => Promise<boolean>): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'ax-kit-qr-'));
  const file = join(dir, 'qr.html');
  await writeFile(file, await qrPageHtml(text), { mode: 0o600 });
  return await open(file).catch(() => false);
}
