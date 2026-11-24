import { describe, expect, it } from 'vitest';
import { knowledgeTexts } from '../../../src/skills/knowledge/locale.js';
import {
  changelogSection,
  prependChangelog,
  renderArea,
  renderProfile,
  renderProject,
  renderReadme,
} from '../../../src/skills/knowledge/render.js';
import { stored } from './helpers.js';

const texts = knowledgeTexts('ko');
const STAMP = '2026-11-17 09:00 (Asia/Seoul)';

describe('bullets', () => {
  it('ends every line with its citation and marks owner corrections', () => {
    const text = renderProject(
      'Acme',
      [
        stored({
          area: 'project',
          topic: 'Acme',
          key: 'purpose',
          text: '출시 준비',
          sources: ['memory:chat', 'mail:1'],
          at: '2026-11-10T09:00:00+09:00',
        }),
        stored({
          area: 'project',
          topic: 'Acme',
          key: 'status',
          text: '진행 중',
          origin: 'correction',
          at: '2026-11-11T09:00:00+09:00',
        }),
        stored({ area: 'project', topic: 'Acme', key: 'memo', text: '메모', at: '2026-11-12T09:00:00+09:00' }),
      ],
      texts,
      STAMP,
    );

    expect(text).toContain('# Acme');
    expect(text).toContain('> 3줄 · 갱신 2026-11-17 09:00 (Asia/Seoul)');
    expect(text).toContain('## 목적');
    expect(text).toContain('- 출시 준비 _(출처: memory:chat, mail:1 · 2026-11-10)_');
    expect(text).toContain('## 상태');
    expect(text).toContain('- 진행 중 _(직접 고침 · 2026-11-11)_');
    expect(text).toContain('## 메모');
  });

  it('builds the English stamp line so a writer can recognise it', () => {
    const text = renderProject('Acme', [], knowledgeTexts('en'), '2026-11-17 09:00 (Asia/Seoul)');

    expect(text).toContain('> 0 lines · Updated 2026-11-17 09:00 (Asia/Seoul)');
  });
});

describe('profile sections', () => {
  it('maps unknown topics to the other section and sorts newest first inside a section', () => {
    const text = renderProfile(
      [
        stored({ area: 'profile', topic: 'role', key: 'role', text: '오래된 역할', at: '2026-11-01T09:00:00+09:00' }),
        stored({ area: 'profile', topic: 'role', key: 'role2', text: '새 역할', at: '2026-11-10T09:00:00+09:00' }),
        stored({ area: 'profile', topic: 'weird', key: 'x', text: '기타 내용', at: '2026-11-05T09:00:00+09:00' }),
      ],
      texts,
      STAMP,
    );

    expect(text).toContain('## 하는 일·역할');
    expect(text.indexOf('새 역할')).toBeLessThan(text.indexOf('오래된 역할'));
    expect(text).toContain('## 기타');
    expect(text).toContain('기타 내용');
  });
});

describe('area documents', () => {
  it('groups by topic and puts the topic with the newest line first', () => {
    const text = renderArea(
      'work',
      [
        stored({ area: 'work', topic: '회사', key: 'a', text: '오래된 회사 일', at: '2026-11-01T09:00:00+09:00' }),
        stored({ area: 'work', topic: '집', key: 'b', text: '집 일', at: '2026-11-10T09:00:00+09:00' }),
      ],
      texts,
      STAMP,
    );

    expect(text).toContain('# 일');
    expect(text.indexOf('## 집')).toBeLessThan(text.indexOf('## 회사'));
    expect(text).toContain('오래된 회사 일');
  });
});

describe('readme', () => {
  it('links the profile, projects and areas and shows a project status', () => {
    const text = renderReadme(
      {
        profileCount: 2,
        projects: [{ name: 'Acme', file: '프로젝트/Acme.md', status: '진행 중', date: '2026-11-10' }],
        areas: [{ id: 'work', file: '분야/일.md', count: 3, date: '2026-11-11' }],
      },
      texts,
      STAMP,
    );

    expect(text).toContain('> 프로필 2줄 · 프로젝트 1개 · 분야 1개 · 갱신 2026-11-17 09:00 (Asia/Seoul)');
    expect(text).toContain('- [Acme](<프로젝트/Acme.md>) — 진행 중 · 2026-11-10');
    expect(text).toContain('- [일](<분야/일.md>) — 3줄 · 2026-11-11');
  });
});

describe('changelog', () => {
  it('labels added, changed and removed lines', () => {
    const section = changelogSection(
      STAMP,
      {
        added: [{ label: '일', text: '새 일' }],
        changed: [{ label: '사람', text: '바뀐 사람' }],
        removed: [{ label: '', text: '빠진 일' }],
      },
      texts,
    );

    expect(section).toContain('## 2026-11-17 09:00 (Asia/Seoul)');
    expect(section).toContain('**추가**\n- 일: 새 일');
    expect(section).toContain('**바뀜**\n- 사람: 바뀐 사람');
    expect(section).toContain('**빠짐**\n- 빠진 일');
  });

  it('puts the newest section directly under a single fixed header', () => {
    const first = prependChangelog(
      undefined,
      changelogSection('2026-11-17 09:00', { added: [], changed: [], removed: [{ label: '', text: 'a' }] }, texts),
      texts,
    );
    const second = prependChangelog(
      first,
      changelogSection('2026-11-18 09:00', { added: [{ label: '', text: 'b' }], changed: [], removed: [] }, texts),
      texts,
    );

    expect(second.match(/# 변경 기록/g)).toHaveLength(1);
    expect(second.indexOf('## 2026-11-18')).toBeLessThan(second.indexOf('## 2026-11-17'));
  });
});
