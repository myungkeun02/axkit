import { describe, expect, it } from 'vitest';
import { qrCaption, qrPageHtml } from './qr-page.js';

describe('QR page', () => {
  it('says what the QR is for', () => {
    expect(qrCaption('axkit://pair?u=x&n=y&c=1').title).toBe('앱 연결');
    expect(qrCaption('https://mac.example.ts.net/m/apk/abc').title).toBe('안드로이드 앱 받기');
  });

  it('draws the QR and escapes the link text', async () => {
    const html = await qrPageHtml('axkit://pair?u=a&n=<b>&c=1');
    expect(html).toContain('<svg');
    expect(html).toContain('n=&#60;b&#62;');
    expect(html).not.toContain('n=<b>');
  });
});
