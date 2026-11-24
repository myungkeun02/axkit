import { describe, expect, it } from 'vitest';
import { parseDiscordScreen } from '../../../src/connectors/screen-chat/discord/parse.js';
import { axSnapshot } from './helpers.js';
import type { TreeNode } from './helpers.js';

function screen(title: string, roots: readonly TreeNode[] = []) {
  return parseDiscordScreen(axSnapshot([{ title, roots }]));
}

describe('parseDiscordScreen view', () => {
  it('reads a DM title', () => {
    expect(screen('@민수 - Discord').view).toEqual({ kind: 'dm', name: '민수' });
  });

  it('reads a channel title with its server', () => {
    expect(screen('#general | Example Server - Discord').view).toEqual({
      kind: 'channel',
      channel: 'general',
      server: 'Example Server',
    });
  });

  it('reads the friends view in Korean and English', () => {
    expect(screen('친구 - Discord').view).toEqual({ kind: 'home' });
    expect(screen('Friends - Discord').view).toEqual({ kind: 'home' });
  });

  it('keeps any other window title', () => {
    expect(screen('설정 - Discord').view).toEqual({ kind: 'other', title: '설정' });
  });

  it('normalizes NFC and collapses whitespace', () => {
    const decomposed = 'Café   -   Discord';
    expect(screen(decomposed).view).toEqual({ kind: 'other', title: 'Café' });
  });
});

describe('parseDiscordScreen DM list', () => {
  it('reads unread and mention prefixes in Korean and English', () => {
    const result = screen('@민수 - Discord', [
      { role: 'AXLink', label: '읽지 않음, 민수 (다이렉트 메시지)' },
      { role: 'AXLink', label: '멘션 2개, 영희 (다이렉트 메시지), 온라인' },
      { role: 'AXLink', label: 'unread, 철수 (direct message), online' },
      { role: 'AXLink', label: '3 mentions, 수진 (direct message)' },
      { role: 'AXLink', label: '일반 채널' },
    ]);

    expect(result.dms).toEqual([
      { name: '민수', unread: true, mentions: 0 },
      { name: '영희', unread: true, mentions: 2 },
      { name: '철수', unread: true, mentions: 0 },
      { name: '수진', unread: true, mentions: 3 },
    ]);
  });

  it('leaves a plain DM read with no mentions', () => {
    const result = screen('@민수 - Discord', [
      { role: 'AXLink', label: '민수 (다이렉트 메시지), 온라인' },
    ]);

    expect(result.dms).toEqual([{ name: '민수', unread: false, mentions: 0 }]);
  });
});

describe('parseDiscordScreen messages', () => {
  it('splits author, text and time, and flags bots', () => {
    const result = screen('@민수 - Discord', [
      { role: 'AXGroup', label: '민수 , 안녕하세요 , 오후 3:20' },
      { role: 'AXGroup', label: '도우미 앱 , 새 소식이 있어요 , 오후 3:21' },
      { role: 'AXGroup', label: 'Helper APP , hello , 3:22 PM' },
      { role: 'AXGroup', label: 'not a message' },
    ]);

    expect(result.messages).toEqual([
      { author: '민수', bot: false, text: '안녕하세요', time: '오후 3:20' },
      { author: '도우미', bot: true, text: '새 소식이 있어요', time: '오후 3:21' },
      { author: 'Helper', bot: true, text: 'hello', time: '3:22 PM' },
    ]);
  });

  it('drops a reply header and uses the next part as the author', () => {
    const result = screen('@민수 - Discord', [
      { role: 'AXGroup', label: '민수 님이 영희 님에게 답장 , 영희 , 답장 내용 , 오후 3:23' },
      { role: 'AXGroup', label: '민수 replying to 영희 , 영희 , reply text , 3:24 PM' },
    ]);

    expect(result.messages).toEqual([
      { author: '영희', bot: false, text: '답장 내용', time: '오후 3:23' },
      { author: '영희', bot: false, text: 'reply text', time: '3:24 PM' },
    ]);
  });
});

describe('parseDiscordScreen login state', () => {
  it('counts as logged in when a window title is known and the view is not foreign', () => {
    expect(screen('친구 - Discord').loggedIn).toBe(true);
    expect(screen('@민수 - Discord').loggedIn).toBe(true);
  });

  it('counts as logged in when DMs are visible even in another view', () => {
    const result = screen('Discord', [{ role: 'AXLink', label: '민수 (다이렉트 메시지)' }]);
    expect(result.loggedIn).toBe(false);

    const titled = screen('설정 - Discord', [{ role: 'AXLink', label: '민수 (다이렉트 메시지)' }]);
    expect(titled.loggedIn).toBe(true);
  });

  it('is not logged in without a Discord window', () => {
    expect(parseDiscordScreen(axSnapshot([])).loggedIn).toBe(false);
  });
});
