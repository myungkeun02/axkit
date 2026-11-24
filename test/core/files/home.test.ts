import { describe, expect, it } from 'vitest';
import { expandHome, homeDisplay, isExcludedHomePath, relativeToHome } from '../../../src/core/files/home.js';
import { watchablePath } from '../../../src/connectors/local-files/watch.js';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import { mdfindArgs } from '../../../src/skills/files/find.js';

describe('home path exclusion rules', () => {
  it('lets ordinary documents through', () => {
    for (const ok of ['Documents/report.pdf', 'Desktop/회의록.md', 'Downloads/photos/a.jpg', 'Projects/app/README.md']) {
      expect(isExcludedHomePath(ok), ok).toBe(false);
    }
  });

  it('drops app data, hidden folders, keys and secret-looking names', () => {
    for (const bad of [
      'Library/Mobile Documents/a.txt',
      'library/Keychains/login.keychain-db',
      '.ssh/id_ed25519',
      '.gnupg/pubring.kbx',
      'Documents/.env',
      'Projects/app/.env.local',
      'Documents/keychains/x.txt',
      'Documents/.hidden/notes.md',
      'Documents/passwords.txt',
      'Documents/my-secret-plan.md',
      'Documents/api_token.json',
      'Desktop/주민등록등본.pdf',
      'Desktop/여권 사본.jpg',
      'Documents/bank-statement-2026.pdf',
      'Documents/server.pem',
      'Documents/id_rsa',
      'Projects/app/node_modules/x/readme.md',
      '../etc/passwd',
      '',
    ]) {
      expect(isExcludedHomePath(bad), bad).toBe(true);
    }
  });

  it('honours extra exclusions', () => {
    expect(isExcludedHomePath('Documents/client-acme/a.md', ['acme'])).toBe(true);
  });

  it('maps paths to and from home', () => {
    expect(relativeToHome('/Users/me/Documents/a.md', '/Users/me')).toBe('Documents/a.md');
    expect(relativeToHome('/Users/me', '/Users/me')).toBeUndefined();
    expect(relativeToHome('/Users/other/a.md', '/Users/me')).toBeUndefined();
    expect(relativeToHome('Documents/a.md', '/Users/me')).toBeUndefined();
    expect(homeDisplay('/Users/me/Documents/a.md', '/Users/me')).toBe('~/Documents/a.md');
    expect(homeDisplay('/Volumes/usb/a.md', '/Users/me')).toBe('/Volumes/usb/a.md');
    expect(expandHome('~/Documents', '/Users/me')).toBe('/Users/me/Documents');
    expect(expandHome('Documents', '/Users/me')).toBeUndefined();
  });

  it('applies the same rules to watched folder events', () => {
    expect(watchablePath('notes/a.md', 'Documents', DEFAULT_FILE_RULES, false)).toBe(true);
    expect(watchablePath('.git/index', 'Documents', DEFAULT_FILE_RULES, false)).toBe(false);
    expect(watchablePath('sub/.DS_Store', 'Documents', DEFAULT_FILE_RULES, false)).toBe(false);
    expect(watchablePath('sub/.notes.md', 'Documents', DEFAULT_FILE_RULES, true)).toBe(true);
    expect(watchablePath('keys/server.pem', 'Documents', DEFAULT_FILE_RULES, true)).toBe(false);
    expect(watchablePath('비밀번호.txt', 'Documents', DEFAULT_FILE_RULES, false)).toBe(false);
    expect(watchablePath('a.md', 'Documents', { ...DEFAULT_FILE_RULES, exclude: ['a.md'] }, false)).toBe(false);
  });

  it('never lets a query reach mdfind as an option', () => {
    expect(mdfindArgs('--help', 'name', '/Users/me')).toEqual(['-onlyin', '/Users/me', '-name', 'help']);
    expect(mdfindArgs('---', 'content', '/Users/me')).toBeUndefined();
    expect(mdfindArgs('예산 계획', 'content', '/Users/me')).toEqual(['-onlyin', '/Users/me', '예산 계획']);
  });
});
