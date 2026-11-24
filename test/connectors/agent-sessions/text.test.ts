import { describe, expect, it } from 'vitest';
import { clip, cleanRemote, ownerText } from '../../../src/connectors/agent-sessions/text.js';

describe('cleanRemote', () => {
  it.each([
    ['https://user:tok@github.com/a/b.git', 'github.com/a/b'],
    ['git@github.com:a/b.git', 'github.com/a/b'],
    ['ssh://git@gitlab.example.com:2222/team/app.git/', 'gitlab.example.com/team/app'],
    ['https://github.com/a/b', 'github.com/a/b'],
  ])('%s -> %s', (raw, expected) => {
    expect(cleanRemote(raw)).toBe(expected);
  });

  it('gives nothing for a local path or empty value', () => {
    expect(cleanRemote('/srv/repo.git')).toBeUndefined();
    expect(cleanRemote('  ')).toBeUndefined();
    expect(cleanRemote(undefined)).toBeUndefined();
  });
});

describe('clip', () => {
  it('keeps short text and splits long text 40/60 around an ellipsis', () => {
    expect(clip('short', 10)).toBe('short');
    const out = clip('a'.repeat(50) + 'b'.repeat(50), 23);
    expect(out).toBe(`${'a'.repeat(8)}\n…\n${'b'.repeat(12)}`);
  });
});

describe('ownerText', () => {
  it('drops wrappers, reminders and interruptions', () => {
    expect(ownerText('<local-command-stdout>ok</local-command-stdout>')).toBe('');
    expect(ownerText('[Request interrupted by user]')).toBe('');
    expect(ownerText('hi <system-reminder>x</system-reminder> there')).toBe('hi there');
    expect(ownerText('real <system-reminder>never closed')).toBe('real');
  });
});
