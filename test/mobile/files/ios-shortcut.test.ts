import { describe, expect, it } from 'vitest';
import { buildIosShortcuts, type IosShortcut } from '../../../src/mobile/files/ios-shortcut.js';
import type { ShortcutKind } from '../../../src/mobile/files/locale.js';

const URL = 'https://example.ts.net/m/v1/ingest';
const TOKEN = 'tok_test_1234567890';
const UUID = 'abcd1234-ef56-7890-abcd-ef1234567890';
const UPPER_UUID = UUID.toUpperCase();

const OPTIONS = { assistantName: '비서', url: URL, token: TOKEN, uuid: () => UUID };

function build(overrides: Partial<typeof OPTIONS> & { language?: string } = {}): IosShortcut[] {
  return buildIosShortcuts({ ...OPTIONS, ...overrides });
}

function byKind(shortcuts: ReadonlyArray<IosShortcut>, kind: ShortcutKind): IosShortcut {
  const found = shortcuts.find((shortcut) => shortcut.kind === kind);
  if (found === undefined) throw new Error(`missing ${kind}`);
  return found;
}

function actionIdentifiers(xml: string): string[] {
  return [...xml.matchAll(/<key>WFWorkflowActionIdentifier<\/key>\s*<string>([^<]+)<\/string>/g)].map(
    (match) => match[1] ?? '',
  );
}

function stringValue(xml: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match?.[1];
}

interface AttachedToken {
  text: string;
  positions: number[];
}

function attachedTokens(xml: string): AttachedToken[] {
  const pattern =
    /<key>string<\/key>\s*<string>([^<]*)<\/string>\s*<key>attachmentsByRange<\/key>\s*<dict>([\s\S]*?)<\/dict>\s*<key>WFSerializationType<\/key>/g;
  return [...xml.matchAll(pattern)].map((match) => ({
    text: match[1] ?? '',
    positions: [...(match[2] ?? '').matchAll(/<key>\{(\d+), 1\}<\/key>/g)].map((range) => Number(range[1])),
  }));
}

interface Field {
  itemType: number;
  key: string;
  value: string;
}

function jsonFields(xml: string): Field[] {
  const start = xml.indexOf('<key>WFJSONValues</key>');
  expect(start).toBeGreaterThan(-1);
  const region = xml.slice(start);
  const pattern =
    /<key>WFItemType<\/key>\s*<integer>(\d+)<\/integer>\s*<key>WFKey<\/key>[\s\S]*?<key>string<\/key>\s*<string>([^<]*)<\/string>[\s\S]*?<key>WFValue<\/key>[\s\S]*?<key>string<\/key>\s*<string>([^<]*)<\/string>/g;
  return [...region.matchAll(pattern)].map((match) => ({
    itemType: Number(match[1]),
    key: match[2] ?? '',
    value: match[3] ?? '',
  }));
}

function headerFields(xml: string): Field[] {
  const start = xml.indexOf('<key>WFHTTPHeaders</key>');
  const end = xml.indexOf('<key>WFJSONValues</key>');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const region = xml.slice(start, end);
  const pattern =
    /<key>WFItemType<\/key>\s*<integer>(\d+)<\/integer>\s*<key>WFKey<\/key>[\s\S]*?<key>string<\/key>\s*<string>([^<]*)<\/string>[\s\S]*?<key>WFValue<\/key>[\s\S]*?<key>string<\/key>\s*<string>([^<]*)<\/string>/g;
  return [...region.matchAll(pattern)].map((match) => ({
    itemType: Number(match[1]),
    key: match[2] ?? '',
    value: match[3] ?? '',
  }));
}

function expectTokenPositions(xml: string, expectedCount: number): void {
  const tokens = attachedTokens(xml);
  expect(tokens).toHaveLength(expectedCount);
  for (const token of tokens) {
    expect(token.positions.length).toBeGreaterThan(0);
    expect([...token.text].filter((char) => char === '￼')).toHaveLength(token.positions.length);
    for (const position of token.positions) {
      expect(token.text[position]).toBe('￼');
    }
  }
}

describe('buildIosShortcuts', () => {
  it('builds the four shortcut kinds in phone-signal order with localized file names', () => {
    const shortcuts = build();

    expect(shortcuts.map((shortcut) => shortcut.kind)).toEqual(['location', 'sms', 'steps', 'voice_memo']);
    expect(shortcuts.map((shortcut) => shortcut.fileName)).toEqual([
      '비서 위치.shortcut',
      '비서 문자.shortcut',
      '비서 걸음.shortcut',
      '비서 메모.shortcut',
    ]);
    expect(shortcuts.every((shortcut) => shortcut.plistXml.includes('<plist version="1.0">'))).toBe(true);
  });

  it('strips path separators from the assistant name and localizes in English', () => {
    const shortcuts = build({ assistantName: 'ax/kit:봇', language: 'en' });

    expect(shortcuts[0]?.fileName).toBe('axkit봇 Location.shortcut');
    expect(byKind(shortcuts, 'voice_memo').plistXml).toContain('<string>Sent</string>');
  });

  it('writes the workflow header the Shortcuts app expects', () => {
    const xml = byKind(build(), 'location').plistXml;

    expect(xml).toContain('<key>WFWorkflowClientVersion</key>\n  <string>2607.0.2</string>');
    expect(xml).toContain('<key>WFWorkflowMinimumClientVersion</key>\n  <integer>900</integer>');
    expect(xml).toContain('<key>WFWorkflowIconStartColor</key>\n    <integer>4282601983</integer>');
    expect(xml).toContain('<key>WFWorkflowIconGlyphNumber</key>\n    <integer>59511</integer>');
    expect(xml).toContain('<key>WFWorkflowTypes</key>\n  <array/>');
    expect(xml).toContain('<key>WFWorkflowImportQuestions</key>\n  <array/>');
    expect(xml).toContain('<key>WFQuickActionSurfaces</key>\n  <array/>');
    expect(xml).toContain('<string>WFStringContentItem</string>');
    expect(xml).toContain('<string>WFNumberContentItem</string>');
  });

  it('marks shortcut input variables only for sms and steps', () => {
    const shortcuts = build();

    for (const kind of ['sms', 'steps'] as const) {
      expect(byKind(shortcuts, kind).plistXml).toContain(
        '<key>WFWorkflowHasShortcutInputVariables</key>\n  <true/>',
      );
    }
    expect(byKind(shortcuts, 'location').plistXml).not.toContain('WFWorkflowHasShortcutInputVariables');
    expect(byKind(shortcuts, 'voice_memo').plistXml).not.toContain('WFWorkflowHasShortcutInputVariables');
  });

  it('uses only the expected actions for each kind', () => {
    const shortcuts = build();

    expect(actionIdentifiers(byKind(shortcuts, 'location').plistXml)).toEqual([
      'is.workflow.actions.getcurrentlocation',
      'is.workflow.actions.downloadurl',
    ]);
    expect(actionIdentifiers(byKind(shortcuts, 'sms').plistXml)).toEqual([
      'is.workflow.actions.downloadurl',
    ]);
    expect(actionIdentifiers(byKind(shortcuts, 'steps').plistXml)).toEqual([
      'is.workflow.actions.downloadurl',
    ]);
    expect(actionIdentifiers(byKind(shortcuts, 'voice_memo').plistXml)).toEqual([
      'is.workflow.actions.dictatetext',
      'is.workflow.actions.downloadurl',
      'is.workflow.actions.notification',
    ]);
  });

  it('posts exact JSON fields for location, with latitude and longitude aggrandizements', () => {
    const xml = byKind(build(), 'location').plistXml;

    expect(stringValue(xml, 'WFURL')).toBe(URL);
    expect(xml).toContain('<key>WFHTTPMethod</key>\n        <string>POST</string>');
    expect(xml).toContain('<key>WFHTTPBodyType</key>\n        <string>JSON</string>');
    expect(xml).toContain('<key>ShowHeaders</key>\n        <true/>');
    expect(jsonFields(xml)).toEqual([
      { itemType: 3, key: 'v', value: '1' },
      { itemType: 0, key: 'ts', value: '￼' },
      { itemType: 0, key: 'kind', value: 'location' },
      { itemType: 3, key: 'lat', value: '￼' },
      { itemType: 3, key: 'lng', value: '￼' },
    ]);
    expect(xml).toContain('WFPropertyVariableAggrandizement');
    expect(xml).toContain('<string>Latitude</string>');
    expect(xml).toContain('<string>Longitude</string>');
    expect(xml).toContain('<string>Current Location</string>');
    expectTokenPositions(xml, 3);
  });

  it('sends the shortcut input as text for sms and as a number for steps', () => {
    const shortcuts = build();
    const sms = byKind(shortcuts, 'sms').plistXml;
    const steps = byKind(shortcuts, 'steps').plistXml;

    expect(jsonFields(sms)).toEqual([
      { itemType: 3, key: 'v', value: '1' },
      { itemType: 0, key: 'ts', value: '￼' },
      { itemType: 0, key: 'kind', value: 'sms' },
      { itemType: 0, key: 'text', value: '￼' },
    ]);
    expect(jsonFields(steps)).toEqual([
      { itemType: 3, key: 'v', value: '1' },
      { itemType: 0, key: 'ts', value: '￼' },
      { itemType: 0, key: 'kind', value: 'steps' },
      { itemType: 3, key: 'steps', value: '￼' },
    ]);
    expect(sms).toContain('<string>ExtensionInput</string>');
    expect(steps).toContain('<string>ExtensionInput</string>');
    expectTokenPositions(sms, 2);
    expectTokenPositions(steps, 2);
  });

  it('dictates text, posts it and confirms with a localized notification for voice memos', () => {
    const xml = byKind(build(), 'voice_memo').plistXml;

    expect(jsonFields(xml)).toEqual([
      { itemType: 3, key: 'v', value: '1' },
      { itemType: 0, key: 'ts', value: '￼' },
      { itemType: 0, key: 'kind', value: 'voice_memo' },
      { itemType: 0, key: 'text', value: '￼' },
    ]);
    expect(xml).toContain('<string>Dictated Text</string>');
    expect(xml).toContain('<key>WFNotificationActionBody</key>\n        <string>보냈어요</string>');
    expectTokenPositions(xml, 2);
  });

  it('keeps the device token in the Authorization header only and sends the URL exactly', () => {
    for (const shortcut of build()) {
      expect(shortcut.plistXml.split(TOKEN)).toHaveLength(2);
      expect(shortcut.plistXml.split(URL)).toHaveLength(2);
      expect(headerFields(shortcut.plistXml)).toEqual([
        { itemType: 0, key: 'Authorization', value: `Bearer ${TOKEN}` },
      ]);
    }
  });

  it('formats the current date as an ISO 8601 text token', () => {
    const xml = byKind(build(), 'sms').plistXml;

    expect(xml).toContain('<string>CurrentDate</string>');
    expect(xml).toContain('<string>WFDateFormatVariableAggrandizement</string>');
    expect(xml).toContain('<string>ISO 8601</string>');
    expect(xml).toContain('<key>WFISO8601IncludeTime</key>');
    expect(xml).toContain('<true/>');
  });

  it('uppercases injected action UUIDs and reuses them in output attachments', () => {
    const location = byKind(build(), 'location').plistXml;
    const voice = byKind(build(), 'voice_memo').plistXml;

    expect(location).toContain(UPPER_UUID);
    expect(location).not.toContain(UUID);
    expect(location.split(UPPER_UUID)).toHaveLength(4);
    expect(voice).toContain(UPPER_UUID);
    expect(voice.split(UPPER_UUID)).toHaveLength(3);
  });
});
