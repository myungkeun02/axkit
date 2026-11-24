import { randomUUID } from 'node:crypto';
import { fileTexts } from './locale.js';

/**
 * MacroDroid does not document its .macro JSON schema. These field names follow the export shape we could infer;
 * they MUST be confirmed by importing on a real Android device (we cannot import here). Keep every field name in
 * SHAPE so a correction is a single edit.
 */
const SHAPE = {
  notificationTrigger: {
    m_type: 'NotificationTrigger',
    m_appName: '*',
    m_notificationText: '*',
    m_ignoreOngoing: true,
  },
  intervalTrigger: {
    m_type: 'RegularIntervalTrigger',
    m_intervalMinutes: 30,
    m_triggerOnEnable: true,
  },
  batteryTrigger: {
    m_type: 'BatteryLevelTrigger',
    m_batteryLevel: 20,
    m_triggerBelow: true,
  },
  httpAction: {
    m_type: 'HttpRequestAction',
    m_enabled: true,
  },
  request: {
    requestType: 1,
    contentType: 'application/json',
  },
} as const;

const MAGIC = {
  // MacroDroid has no ISO 8601 token; the bridge parses this in the owner's time zone.
  timestamp: '[year]-[month_digit]-[dayofmonth] [hour]:[minute]:[second]',
  app: '[app_name]',
  title: '[notification_title]',
  notification: '[notification]',
  lat: '[last_loc_lat]',
  lng: '[last_loc_long]',
  battery: '[battery]',
} as const;

export interface MacroDroidOptions {
  assistantName: string;
  url: string;
  token: string;
  uuid?: () => string;
  language?: string;
}

interface HttpRequestAction {
  m_type: 'HttpRequestAction';
  m_enabled: true;
  requestConfig: {
    urlToOpen: string;
    requestType: 1;
    contentBodyText: string;
    contentType: 'application/json';
    headerParams: Array<{ paramName: 'Authorization'; paramValue: string }>;
  };
}

interface MacroDroidMacro {
  m_name: string;
  m_GUID: string;
  m_enabled: boolean;
  m_triggerList: Array<Record<string, unknown>>;
  m_actionList: HttpRequestAction[];
}

function httpAction(options: MacroDroidOptions, contentBodyText: string): HttpRequestAction {
  return {
    ...SHAPE.httpAction,
    requestConfig: {
      urlToOpen: options.url,
      ...SHAPE.request,
      contentBodyText,
      headerParams: [{ paramName: 'Authorization', paramValue: `Bearer ${options.token}` }],
    },
  };
}

function body(kind: string, fields: Readonly<Record<string, string>>): string {
  return JSON.stringify({ v: 1, ts: MAGIC.timestamp, kind, ...fields });
}

function macro(
  options: MacroDroidOptions,
  name: string,
  trigger: Record<string, unknown>,
  contentBody: string,
): MacroDroidMacro {
  return {
    m_name: name,
    m_GUID: (options.uuid ?? randomUUID)().toUpperCase(),
    m_enabled: true,
    m_triggerList: [trigger],
    m_actionList: [httpAction(options, contentBody)],
  };
}

function safeName(assistantName: string): string {
  return assistantName.replace(/[/:]/g, '').trim();
}

/** Builds a MacroDroid JSON export with notification, location and battery macros. */
export function buildMacroDroidExport(options: MacroDroidOptions): string {
  const texts = fileTexts(options.language ?? 'ko');
  const name = safeName(options.assistantName);

  // Android surfaces SMS as notifications, so the notification trigger covers texts without SMS permission.
  const notificationBody = body('notification', {
    app: MAGIC.app,
    title: MAGIC.title,
    text: MAGIC.notification,
  });
  const locationBody = body('location', { lat: MAGIC.lat, lng: MAGIC.lng });
  const batteryBody = body('battery', { level: MAGIC.battery });

  const document = {
    m_formatVersion: 1,
    m_name: name,
    m_macros: [
      macro(options, `${name} ${texts.macroLabels.notification}`, SHAPE.notificationTrigger, notificationBody),
      macro(options, `${name} ${texts.macroLabels.location}`, SHAPE.intervalTrigger, locationBody),
      macro(options, `${name} ${texts.macroLabels.battery}`, SHAPE.batteryTrigger, batteryBody),
    ],
  };
  return JSON.stringify(document, null, 2);
}
