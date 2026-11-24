import { describe, expect, it } from 'vitest';
import { parseKakaoList } from '../../../src/connectors/screen-chat/kakao/parse.js';
import { axSnapshot, badgeNode, rowNode, tableNode, textNode } from './helpers.js';
import type { TreeNode } from './helpers.js';

function snapshotWith(rows: readonly (readonly TreeNode[])[], listRole = 'AXTable') {
  return axSnapshot([
    {
      title: 'KakaoTalk',
      roots: [tableNode(rows.map((cells) => rowNode(cells)), listRole)],
    },
  ]);
}

describe('parseKakaoList', () => {
  it('reads title, preview and the Count Label badge', () => {
    const snapshot = snapshotWith([
      [textNode('민수'), textNode('안녕하세요'), badgeNode('3')],
      [textNode('영희'), textNode('내일 봐요'), badgeNode('999+')],
      [textNode('회사'), textNode('회의 시작'), badgeNode('1,024')],
    ]);

    expect(parseKakaoList(snapshot, 30)).toEqual([
      { title: '민수', preview: '안녕하세요', unread: 3 },
      { title: '영희', preview: '내일 봐요', unread: 999 },
      { title: '회사', preview: '회의 시작', unread: 1024 },
    ]);
  });

  it('reports null for every room when the list has no Count Label', () => {
    const snapshot = snapshotWith([
      [textNode('민수'), textNode('안녕하세요')],
      [textNode('영희'), textNode('내일 봐요')],
    ]);

    expect(parseKakaoList(snapshot, 30).map((row) => row.unread)).toEqual([null, null]);
  });

  it('uses zero for rows without a badge once some row has one', () => {
    const snapshot = snapshotWith([
      [textNode('민수'), textNode('안녕하세요'), badgeNode('2')],
      [textNode('영희'), textNode('내일 봐요')],
    ]);

    expect(parseKakaoList(snapshot, 30).map((row) => row.unread)).toEqual([2, 0]);
  });

  it('skips times and counts before the title', () => {
    const snapshot = snapshotWith([
      [textNode('오후 3:20'), textNode('민수'), textNode('안녕하세요')],
      [textNode('어제'), textNode('영희'), textNode('내일 봐요')],
      [textNode('11월 17일'), textNode('회사'), textNode('회의 시작')],
      [textNode('2026. 11. 17.'), textNode('가족'), textNode('저녁 먹자')],
      [textNode('2026-11-17'), textNode('친구'), textNode('뭐 해')],
      [textNode('3:20 PM'), textNode('동료'), textNode('확인 부탁')],
      [textNode('Monday'), textNode('스터디'), textNode('공부하자')],
      [textNode('월요일'), textNode('모임'), textNode('모여요')],
      [textNode('12'), textNode('알림'), textNode('새 소식'), badgeNode('1')],
    ]);

    expect(parseKakaoList(snapshot, 30).map((row) => row.title)).toEqual([
      '민수',
      '영희',
      '회사',
      '가족',
      '친구',
      '동료',
      '스터디',
      '모임',
      '알림',
    ]);
  });

  it('skips the self chat room', () => {
    const snapshot = snapshotWith([
      [textNode('나와의 채팅'), textNode('메모')],
      [textNode('민수'), textNode('안녕하세요')],
    ]);

    expect(parseKakaoList(snapshot, 30).map((row) => row.title)).toEqual(['민수']);
  });

  it('treats the direct children of an AXList as rows when it has no AXRow', () => {
    const snapshot = axSnapshot([
      {
        title: 'KakaoTalk',
        roots: [
          tableNode(
            [
              { role: 'AXGroup', children: [textNode('민수'), textNode('안녕하세요')] },
              { role: 'AXGroup', children: [textNode('영희'), textNode('내일 봐요')] },
            ],
            'AXList',
          ),
        ],
      },
    ]);

    expect(parseKakaoList(snapshot, 30)).toEqual([
      { title: '민수', preview: '안녕하세요', unread: null },
      { title: '영희', preview: '내일 봐요', unread: null },
    ]);
  });

  it('stops after the first window that yields rows', () => {
    const snapshot = axSnapshot([
      { title: 'side', roots: [tableNode([])] },
      { title: 'main', roots: [tableNode([rowNode([textNode('민수'), textNode('안녕하세요')])])] },
      { title: 'other', roots: [tableNode([rowNode([textNode('영희'), textNode('내일 봐요')])])] },
    ]);

    expect(parseKakaoList(snapshot, 30).map((row) => row.title)).toEqual(['민수']);
  });

  it('honours the row limit', () => {
    const snapshot = snapshotWith([
      [textNode('민수'), textNode('하나')],
      [textNode('영희'), textNode('둘')],
      [textNode('회사'), textNode('셋')],
    ]);

    expect(parseKakaoList(snapshot, 2)).toHaveLength(2);
  });

  it('returns nothing when the app is not running', () => {
    const snapshot = snapshotWith([[textNode('민수'), textNode('안녕하세요')]]);
    expect(parseKakaoList({ ...snapshot, running: false }, 30)).toEqual([]);
  });
});
