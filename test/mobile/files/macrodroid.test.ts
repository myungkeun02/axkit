import { describe, expect, it } from 'vitest';
import { buildMacroDroidExport } from '../../../src/mobile/files/macrodroid.js';

const URL = 'https://example.ts.net/m/v1/ingest';
const TOKEN = 'tok_test_1234567890';
const UUID = 'abcd1234-ef56-7890-abcd-ef1234567890';
const TIMESTAMP = '[year]-[month_digit]-[dayofmonth] [hour]:[minute]:[second]';

interface RequestConfig {
  urlToOpen: string;
  requestType: number;
  contentBodyText: string;
  contentType: string;
  headerParams: Array<{ paramName: string; paramValue: string }>;
}

interface Macro {
  m_name: string;
  m_GUID: string;
  m_enabled: boolean;
  m_triggerList: Array<Record<string, unknown>>;
  m_actionList: Array<{ m_type: string; requestConfig: RequestConfig }>;
}

interface ExportDocument {
  m_formatVersion: number;
  m_name: string;
  m_macros: Macro[];
}

function build(overrides: { assistantName?: string; language?: string } = {}): {
  text: string;
  document: ExportDocument;
} {
  const text = buildMacroDroidExport({
    assistantName: overrides.assistantName ?? '비서',
    url: URL,
    token: TOKEN,
    uuid: () => UUID,
    ...(overrides.language !== undefined ? { language: overrides.language } : {}),
  });
  return { text, document: JSON.parse(text) as ExportDocument };
}

function bodyOf(macro: Macro): Record<string, unknown> {
  return JSON.parse(macro.m_actionList[0]?.requestConfig.contentBodyText ?? '{}') as Record<string, unknown>;
}

describe('buildMacroDroidExport', () => {
  it('produces a JSON export with three enabled macros and uppercase GUIDs', () => {
    const { text, document } = build();

    expect(text).toContain(URL);
    expect(text).toContain(`Bearer ${TOKEN}`);
    expect(document.m_formatVersion).toBe(1);
    expect(document.m_name).toBe('비서');
    expect(document.m_macros).toHaveLength(3);
    expect(document.m_macros.map((macro) => macro.m_name)).toEqual([
      '비서 알림',
      '비서 위치',
      '비서 배터리',
    ]);
    for (const macro of document.m_macros) {
      expect(macro.m_enabled).toBe(true);
      expect(macro.m_GUID).toBe(UUID.toUpperCase());
    }
  });

  it('posts notifications from any app with the notification magic text', () => {
    const notification = build().document.m_macros[0];
    if (notification === undefined) throw new Error('missing notification macro');

    const trigger = notification.m_triggerList[0];
    expect(trigger?.['m_type']).toBe('NotificationTrigger');
    expect(trigger?.['m_appName']).toBe('*');

    const request = notification.m_actionList[0]?.requestConfig;
    expect(request).toMatchObject({
      urlToOpen: URL,
      requestType: 1,
      contentType: 'application/json',
      headerParams: [{ paramName: 'Authorization', paramValue: `Bearer ${TOKEN}` }],
    });
    expect(bodyOf(notification)).toEqual({
      v: 1,
      ts: TIMESTAMP,
      kind: 'notification',
      app: '[app_name]',
      title: '[notification_title]',
      text: '[notification]',
    });
  });

  it('reports location every 30 minutes with the last location magic text', () => {
    const location = build().document.m_macros[1];
    if (location === undefined) throw new Error('missing location macro');

    expect(location.m_triggerList[0]?.['m_type']).toBe('RegularIntervalTrigger');
    expect(location.m_triggerList[0]?.['m_intervalMinutes']).toBe(30);
    expect(bodyOf(location)).toEqual({
      v: 1,
      ts: TIMESTAMP,
      kind: 'location',
      lat: '[last_loc_lat]',
      lng: '[last_loc_long]',
    });
  });

  it('reports the battery below 20 percent', () => {
    const battery = build().document.m_macros[2];
    if (battery === undefined) throw new Error('missing battery macro');

    expect(battery.m_triggerList[0]?.['m_type']).toBe('BatteryLevelTrigger');
    expect(battery.m_triggerList[0]?.['m_batteryLevel']).toBe(20);
    expect(bodyOf(battery)).toEqual({
      v: 1,
      ts: TIMESTAMP,
      kind: 'battery',
      level: '[battery]',
    });
  });

  it('uses the same request shape for every macro', () => {
    const { document } = build();

    for (const macro of document.m_macros) {
      const action = macro.m_actionList[0];
      expect(action?.m_type).toBe('HttpRequestAction');
      expect(action?.requestConfig.requestType).toBe(1);
      expect(action?.requestConfig.headerParams).toEqual([
        { paramName: 'Authorization', paramValue: `Bearer ${TOKEN}` },
      ]);
    }
  });

  it('sanitizes the assistant name and localizes macro names in English', () => {
    const { document } = build({ assistantName: 'ax/kit:봇', language: 'en' });

    expect(document.m_name).toBe('axkit봇');
    expect(document.m_macros.map((macro) => macro.m_name)).toEqual([
      'axkit봇 Notifications',
      'axkit봇 Location',
      'axkit봇 Battery',
    ]);
  });
});
