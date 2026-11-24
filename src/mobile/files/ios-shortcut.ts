import { randomUUID } from 'node:crypto';
import { fileTexts, type ShortcutKind } from './locale.js';
import { plist, renderPlist, type PlistValue } from './plist.js';
import {
  actionOutputAttachment,
  extensionInputAttachment,
  plainToken,
  variableToken,
  type DictionaryField,
} from './text-token.js';
import { action, currentDateField, downloadAction, field, shortcutFileName, workflow } from './workflow.js';

export interface IosShortcutOptions {
  assistantName: string;
  url: string;
  token: string;
  uuid?: () => string;
  language?: string;
}

export interface IosShortcut {
  kind: ShortcutKind;
  fileName: string;
  plistXml: string;
}

function download(url: string, token: string, fields: ReadonlyArray<DictionaryField>): PlistValue {
  return downloadAction({
    url: plist.string(url),
    headers: [field('Authorization', 0, plainToken(`Bearer ${token}`))],
    fields,
  });
}

function locationActions(url: string, token: string, nextUuid: () => string): PlistValue[] {
  const outputUuid = nextUuid();
  return [
    action('is.workflow.actions.getcurrentlocation', plist.dict({ UUID: plist.string(outputUuid) })),
    download(url, token, [
      field('v', 3, plainToken('1')),
      currentDateField(),
      field('kind', 0, plainToken('location')),
      field(
        'lat',
        3,
        variableToken(
          actionOutputAttachment({ uuid: outputUuid, outputName: 'Current Location', property: 'Latitude' }),
        ),
      ),
      field(
        'lng',
        3,
        variableToken(
          actionOutputAttachment({ uuid: outputUuid, outputName: 'Current Location', property: 'Longitude' }),
        ),
      ),
    ]),
  ];
}

function textInputActions(
  kind: 'sms' | 'steps',
  url: string,
  token: string,
  key: 'text' | 'steps',
  itemType: 0 | 3,
): PlistValue[] {
  return [
    download(url, token, [
      field('v', 3, plainToken('1')),
      currentDateField(),
      field('kind', 0, plainToken(kind)),
      field(key, itemType, variableToken(extensionInputAttachment())),
    ]),
  ];
}

function voiceMemoActions(url: string, token: string, nextUuid: () => string, sent: string): PlistValue[] {
  const outputUuid = nextUuid();
  return [
    action('is.workflow.actions.dictatetext', plist.dict({ UUID: plist.string(outputUuid) })),
    download(url, token, [
      field('v', 3, plainToken('1')),
      currentDateField(),
      field('kind', 0, plainToken('voice_memo')),
      field(
        'text',
        0,
        variableToken(actionOutputAttachment({ uuid: outputUuid, outputName: 'Dictated Text' })),
      ),
    ]),
    action('is.workflow.actions.notification', plist.dict({ WFNotificationActionBody: plist.string(sent) })),
  ];
}

/** Builds the four importable iOS shortcuts, one per phone signal kind. */
export function buildIosShortcuts(options: IosShortcutOptions): IosShortcut[] {
  const texts = fileTexts(options.language ?? 'ko');
  const uuid = options.uuid ?? (() => randomUUID());
  const nextUuid = (): string => uuid().toUpperCase();

  const builders: ReadonlyArray<{ kind: ShortcutKind; actions: PlistValue[]; hasInput: boolean }> = [
    { kind: 'location', actions: locationActions(options.url, options.token, nextUuid), hasInput: false },
    { kind: 'sms', actions: textInputActions('sms', options.url, options.token, 'text', 0), hasInput: true },
    { kind: 'steps', actions: textInputActions('steps', options.url, options.token, 'steps', 3), hasInput: true },
    {
      kind: 'voice_memo',
      actions: voiceMemoActions(options.url, options.token, nextUuid, texts.sent),
      hasInput: false,
    },
  ];

  return builders.map(({ kind, actions, hasInput }) => ({
    kind,
    fileName: shortcutFileName(options.assistantName, texts.shortcutLabels[kind]),
    plistXml: renderPlist(workflow({ actions, hasShortcutInput: hasInput })),
  }));
}
