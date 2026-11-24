import type { PairingFile } from './admin.js';
import type { MobileTexts } from './locale.js';

const STYLE = [
  'body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f}',
  'main{max-width:26rem;margin:12vh auto;padding:1.5rem;background:#fff;border-radius:12px}',
  'h1{font-size:1.3rem;margin:0 0 .5rem}',
  'p{color:#555}',
  'label{display:block;margin:1rem 0 .3rem;font-weight:600}',
  'input{width:100%;box-sizing:border-box;padding:.7rem;font-size:1.4rem;letter-spacing:.4em;text-align:center;border:1px solid #ccc;border-radius:8px}',
  'button{margin-top:1rem;width:100%;padding:.75rem;font-size:1rem;border:0;border-radius:8px;background:#0071e3;color:#fff}',
  'a{display:block;padding:.6rem 0;color:#0071e3}',
  '.error{color:#b3261e}',
  'ul{padding-left:1.2rem}',
  'input.connection{font:0.85rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0;text-align:left}',
  'p.hint{font-size:.85rem}',
].join('');

// Clipboard access needs a script; the bridge CSP allows exactly this text through a hash in server.ts.
export const PAIRING_SCRIPT =
  'document.getElementById("copy").addEventListener("click",async function(){' +
  'const f=document.getElementById("connection");const b=document.getElementById("copy");' +
  'try{await navigator.clipboard.writeText(f.value);b.textContent=b.dataset.copied;}' +
  'catch(e){f.focus();f.select();}});';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function page(texts: MobileTexts, title: string, body: string): string {
  return [
    '<!doctype html>',
    `<html lang="${texts.language}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>`,
    `<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
  ].join('');
}

export function pairingFormPage(texts: MobileTexts, nonce: string, error?: string): string {
  const message = error === undefined ? '' : `<p class="error">${escapeHtml(error)}</p>`;
  const body = [
    `<p>${escapeHtml(texts.pairingHint)}</p>`,
    message,
    `<form method="post" action="/m/p/${encodeURIComponent(nonce)}">`,
    `<label for="code">${escapeHtml(texts.pairingCodeLabel)}</label>`,
    '<input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"',
    ' autocomplete="one-time-code" required autofocus>',
    `<button type="submit">${escapeHtml(texts.pairingSubmit)}</button>`,
    '</form>',
  ].join('');
  return page(texts, texts.pairingTitle, body);
}

function connectionBlock(texts: MobileTexts, connection: string): string {
  return [
    `<label for="connection">${escapeHtml(texts.pairingConnectionLabel)}</label>`,
    `<input id="connection" class="connection" type="text" readonly value="${escapeHtml(connection)}">`,
    `<button type="button" id="copy" data-copied="${escapeHtml(texts.pairingConnectionCopied)}">`,
    `${escapeHtml(texts.pairingConnectionCopy)}</button>`,
    `<p class="hint">${escapeHtml(texts.pairingConnectionHint)}</p>`,
    `<script>${PAIRING_SCRIPT}</script>`,
  ].join('');
}

export function pairingDonePage(
  texts: MobileTexts,
  nonce: string,
  files: readonly PairingFile[],
  unlockKey: string,
  connection?: string,
): string {
  const list =
    files.length === 0
      ? `<p>${escapeHtml(texts.pairingNoFiles)}</p>`
      : [
          `<p>${escapeHtml(texts.pairingDoneHint)}</p>`,
          '<ul>',
          ...files.map((file, index) => {
            const href = `/m/p/${encodeURIComponent(nonce)}/${index}?k=${encodeURIComponent(unlockKey)}`;
            return `<li><a href="${href}" download>${escapeHtml(file.name)}</a></li>`;
          }),
          '</ul>',
        ].join('');
  return page(texts, texts.pairingDoneTitle, `${list}${connection === undefined ? '' : connectionBlock(texts, connection)}`);
}

export function pairingMessagePage(texts: MobileTexts, message: string): string {
  return page(texts, texts.pairingTitle, `<p class="error">${escapeHtml(message)}</p>`);
}
