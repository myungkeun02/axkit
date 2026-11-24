import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../../../src/connectors/web/html-text.js';

describe('decodeEntities', () => {
  it('decodes the named entities used in pages', () => {
    expect(decodeEntities('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;')).toBe('a & b < c > d "e" \'f\'');
    expect(decodeEntities('12&nbsp;900 &#8361; &#x20A9;')).toBe('12 900 ₩ ₩');
  });

  it('does not decode twice', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('htmlToText', () => {
  it('keeps the title and visible text only', () => {
    const result = htmlToText(
      '<html><head><title>카페 &amp; 차</title><style>body{color:red}</style></head>' +
        '<body><h1>Hello</h1><script>bad()</script><p>a &lt; b</p><noscript>n</noscript>' +
        '<div>12&nbsp;900</div><svg><text>hidden</text></svg></body></html>',
    );

    expect(result.title).toBe('카페 & 차');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('a < b');
    expect(result.text).toContain('12 900');
    expect(result.text).not.toContain('bad()');
    expect(result.text).not.toContain('color:red');
    expect(result.text).not.toContain('hidden');
  });

  it('turns block tags into line breaks and collapses spaces', () => {
    const result = htmlToText('<p>one   two</p><p>three</p><br><span>four</span>');
    expect(result.text).toBe('one two\nthree\nfour');
  });

  it('omits an empty title', () => {
    expect(htmlToText('<title>  </title><p>x</p>').title).toBeUndefined();
  });

  it('caps the text at 200k characters', () => {
    const result = htmlToText(`<p>${'a'.repeat(250_000)}</p>`);
    expect(result.text.length).toBe(200_000);
  });
});
