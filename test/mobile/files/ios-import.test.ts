import { describe, expect, it } from 'vitest';
import { buildIosImportTemplates, connectionString } from '../../../src/mobile/files/ios-import.js';
import type { IosShortcut } from '../../../src/mobile/files/ios-shortcut.js';
import type { ShortcutKind } from '../../../src/mobile/files/locale.js';

function uuidSource(): () => string {
  let index = 0;
  return () => `uuid-${String(index++).padStart(4, '0')}-0000-0000-0000-000000000000`;
}

function build(language?: string): IosShortcut[] {
  return buildIosImportTemplates({
    assistantName: '비서',
    uuid: uuidSource(),
    ...(language === undefined ? {} : { language }),
  });
}

function byKind(templates: ReadonlyArray<IosShortcut>, kind: ShortcutKind): IosShortcut {
  const found = templates.find((template) => template.kind === kind);
  if (found === undefined) throw new Error(`missing ${kind}`);
  return found;
}

function chunks(xml: string): string[] {
  const start = xml.indexOf('<key>WFWorkflowActions</key>');
  const end = xml.lastIndexOf('</array>');
  return xml.slice(start, end).split('<key>WFWorkflowActionIdentifier</key>').slice(1);
}

function identifier(chunk: string): string {
  return /^\s*<string>([^<]+)<\/string>/.exec(chunk)?.[1] ?? '';
}

function uuidOf(chunk: string): string | undefined {
  return /<key>UUID<\/key>\s*<string>([^<]+)<\/string>/.exec(chunk)?.[1];
}

function outputUuids(chunk: string): string[] {
  return [...chunk.matchAll(/<key>OutputUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map(
    (match) => match[1] ?? '',
  );
}

function itemIndex(chunk: string): number {
  return Number(/<key>WFItemIndex<\/key>\s*<integer>(\d+)<\/integer>/.exec(chunk)?.[1] ?? '0');
}

function between(chunk: string, from: string, to: string): string {
  const start = chunk.indexOf(`<key>${from}</key>`);
  const end = chunk.indexOf(`<key>${to}</key>`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return chunk.slice(start, end);
}

function importQuestions(xml: string): string {
  const start = xml.indexOf('<key>WFWorkflowImportQuestions</key>');
  const end = xml.indexOf('<key>WFQuickActionSurfaces</key>');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return xml.slice(start, end);
}

describe('connectionString', () => {
  it('joins the ingest URL and token with a pipe', () => {
    expect(connectionString('https://box.example.ts.net/m/v1/ingest', 'tok_abc-123')).toBe(
      'https://box.example.ts.net/m/v1/ingest|tok_abc-123',
    );
  });
});

describe('buildIosImportTemplates', () => {
  it('builds the same four kinds and labels as the signed set', () => {
    const templates = build();

    expect(templates.map((template) => template.kind)).toEqual(['location', 'sms', 'steps', 'voice_memo']);
    expect(templates.map((template) => template.fileName)).toEqual([
      '비서 위치.shortcut',
      '비서 문자.shortcut',
      '비서 걸음.shortcut',
      '비서 메모.shortcut',
    ]);
    expect(templates.every((template) => template.plistXml.includes('<plist version="1.0">'))).toBe(true);
  });

  it('asks for the connection string through an import question on the Text action', () => {
    for (const template of build()) {
      const question = importQuestions(template.plistXml);
      expect(question).toMatch(/<key>ActionIndex<\/key>\s*<integer>0<\/integer>/);
      expect(question).toMatch(/<key>Category<\/key>\s*<string>Parameter<\/string>/);
      expect(question).toMatch(/<key>DefaultValue<\/key>\s*<string><\/string>/);
      expect(question).toMatch(/<key>ParameterKey<\/key>\s*<string>WFTextActionText<\/string>/);
      expect(question).toContain('연결 문자열을 붙여 넣어 주세요');
      expect(identifier(chunks(template.plistXml)[0] ?? '')).toBe('is.workflow.actions.gettext');
    }
  });

  it('localizes the question and file names in English', () => {
    const templates = build('en');

    expect(templates[0]?.fileName).toBe('비서 Location.shortcut');
    expect(templates[0]?.plistXml).toContain('Paste the connection string');
    expect(templates[0]?.plistXml).not.toContain('연결 문자열');
  });

  it('splits the pasted text on "|" and takes item 1 and item 2', () => {
    for (const template of build()) {
      const [text, split, urlItem, tokenItem] = chunks(template.plistXml);
      expect(identifier(split ?? '')).toBe('is.workflow.actions.text.split');
      expect(split ?? '').toMatch(/<key>WFTextSeparator<\/key>\s*<string>Custom<\/string>/);
      expect(split ?? '').toMatch(/<key>WFTextCustomSeparator<\/key>\s*<string>\|<\/string>/);
      expect(outputUuids(split ?? '')).toEqual([uuidOf(text ?? '')]);

      expect(identifier(urlItem ?? '')).toBe('is.workflow.actions.getitemfromlist');
      expect(identifier(tokenItem ?? '')).toBe('is.workflow.actions.getitemfromlist');
      expect(itemIndex(urlItem ?? '')).toBe(1);
      expect(itemIndex(tokenItem ?? '')).toBe(2);
      expect(outputUuids(urlItem ?? '')).toEqual([uuidOf(split ?? '')]);
      expect(outputUuids(tokenItem ?? '')).toEqual([uuidOf(split ?? '')]);
    }
  });

  it('uses the split items as the request URL and the bearer token', () => {
    for (const template of build()) {
      const view = chunks(template.plistXml);
      const urlItem = view[2] ?? '';
      const tokenItem = view[3] ?? '';
      const download = view.find((chunk) => identifier(chunk) === 'is.workflow.actions.downloadurl') ?? '';
      const url = between(download, 'WFURL', 'WFHTTPMethod');
      const headers = between(download, 'WFHTTPHeaders', 'WFJSONValues');

      expect(url).toContain(uuidOf(urlItem) ?? 'missing-url-uuid');
      expect(headers).toContain('Bearer ');
      expect(headers).toContain('￼');
      expect(headers).toContain(uuidOf(tokenItem) ?? 'missing-token-uuid');
    }
  });

  it('keeps every address and token out of the template', () => {
    for (const template of build()) {
      expect(template.plistXml).not.toMatch(/<string>https?:\/\//);
      expect(template.plistXml).not.toContain('token_');
      expect(template.plistXml).not.toContain('box.example.ts.net');
    }
  });

  it('keeps the four signal shapes, including input variables and the sent notice', () => {
    const templates = build();
    const identifiers = (kind: ShortcutKind): string[] =>
      chunks(byKind(templates, kind).plistXml).map(identifier);

    expect(identifiers('location')).toEqual([
      'is.workflow.actions.gettext',
      'is.workflow.actions.text.split',
      'is.workflow.actions.getitemfromlist',
      'is.workflow.actions.getitemfromlist',
      'is.workflow.actions.getcurrentlocation',
      'is.workflow.actions.downloadurl',
    ]);
    expect(identifiers('sms')).toEqual([
      'is.workflow.actions.gettext',
      'is.workflow.actions.text.split',
      'is.workflow.actions.getitemfromlist',
      'is.workflow.actions.getitemfromlist',
      'is.workflow.actions.downloadurl',
    ]);
    expect(identifiers('voice_memo')).toEqual([
      'is.workflow.actions.gettext',
      'is.workflow.actions.text.split',
      'is.workflow.actions.getitemfromlist',
      'is.workflow.actions.getitemfromlist',
      'is.workflow.actions.dictatetext',
      'is.workflow.actions.downloadurl',
      'is.workflow.actions.notification',
    ]);
    for (const kind of ['sms', 'steps'] as const) {
      expect(byKind(templates, kind).plistXml).toContain(
        '<key>WFWorkflowHasShortcutInputVariables</key>\n  <true/>',
      );
    }
    expect(byKind(templates, 'location').plistXml).not.toContain('WFWorkflowHasShortcutInputVariables');
    expect(byKind(templates, 'voice_memo').plistXml).toContain('<string>보냈어요</string>');
  });
});
