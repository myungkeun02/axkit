import { describe, expect, it } from 'vitest';
import { plist, renderPlist } from '../../../src/mobile/files/plist.js';

describe('renderPlist', () => {
  it('escapes all five XML characters in keys and strings', () => {
    const xml = renderPlist(
      plist.dict({
        'a&b<c>d"e\'f': plist.string('x & y < z > "q" \'s\''),
      }),
    );

    expect(xml).toContain('<key>a&amp;b&lt;c&gt;d&quot;e&apos;f</key>');
    expect(xml).toContain('<string>x &amp; y &lt; z &gt; &quot;q&quot; &apos;s&apos;</string>');
  });

  it('writes a document with the Apple doctype and version', () => {
    const xml = renderPlist(plist.string('hello'));

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(xml).toContain('<plist version="1.0">');
    expect(xml.trimEnd().endsWith('</plist>')).toBe(true);
    expect(xml).toContain('<string>hello</string>');
  });

  it('renders integers, reals, booleans and nested collections', () => {
    const xml = renderPlist(
      plist.dict({
        count: plist.integer(42),
        ratio: plist.real(0.5),
        yes: plist.boolean(true),
        no: plist.boolean(false),
        list: plist.array([plist.string('a'), plist.integer(1)]),
        nested: plist.dict({ inner: plist.string('v') }),
      }),
    );

    expect(xml).toContain('<integer>42</integer>');
    expect(xml).toContain('<real>0.5</real>');
    expect(xml).toContain('<true/>');
    expect(xml).toContain('<false/>');
    expect(xml).toContain('<string>a</string>');
    expect(xml).toContain('<key>inner</key>');
    expect(xml).toContain('<string>v</string>');
  });

  it('renders empty dictionaries and arrays as self-closing tags', () => {
    const xml = renderPlist(plist.dict({ empty: plist.dict({}), items: plist.array([]) }));

    expect(xml).toContain('<dict/>');
    expect(xml).toContain('<array/>');
  });

  it('rejects non-integer and non-finite numbers', () => {
    expect(() => plist.integer(1.5)).toThrow(/integer/);
    expect(() => plist.real(Number.NaN)).toThrow(/finite/);
    expect(() => plist.real(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
