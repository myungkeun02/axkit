import { randomUUID } from 'node:crypto';
import type { IosShortcut } from './ios-shortcut.js';
import { fileTexts, type ShortcutKind } from './locale.js';
import { plist, renderPlist, type PlistValue } from './plist.js';
import {
  actionOutputAttachment,
  extensionInputAttachment,
  plainToken,
  textToken,
  variableToken,
  type DictionaryField,
} from './text-token.js';
import { action, currentDateField, downloadAction, field, shortcutFileName, workflow } from './workflow.js';

export interface IosImportOptions {
  assistantName: string;
  language?: string;
  uuid?: () => string;
}

interface ConnectionVariables {
  actions: PlistValue[];
  url: PlistValue;
  authorization: PlistValue;
}

/** `<ingest url>|<token>` — the value an import question asks the owner to paste. */
export function connectionString(url: string, token: string): string {
  return `${url}|${token}`;
}

function importQuestion(question: string): PlistValue {
  return plist.dict({
    ActionIndex: plist.integer(0),
    Category: plist.string('Parameter'),
    DefaultValue: plist.string(''),
    ParameterKey: plist.string('WFTextActionText'),
    Text: plist.string(question),
  });
}

/** Text action filled by the import question, split on "|" into URL and token variables. */
function connectionActions(nextUuid: () => string): ConnectionVariables {
  const textUuid = nextUuid();
  const splitUuid = nextUuid();
  const urlUuid = nextUuid();
  const tokenUuid = nextUuid();
  const fromText = variableToken(actionOutputAttachment({ uuid: textUuid, outputName: 'Text' }));
  const fromSplit = variableToken(actionOutputAttachment({ uuid: splitUuid, outputName: 'Split Text' }));
  const actions = [
    action(
      'is.workflow.actions.gettext',
      plist.dict({ UUID: plist.string(textUuid), WFTextActionText: plist.string('') }),
    ),
    action(
      'is.workflow.actions.text.split',
      plist.dict({
        UUID: plist.string(splitUuid),
        WFInput: fromText,
        WFTextSeparator: plist.string('Custom'),
        WFTextCustomSeparator: plist.string('|'),
      }),
    ),
    itemFromList(urlUuid, fromSplit, 1),
    itemFromList(tokenUuid, fromSplit, 2),
  ];
  return {
    actions,
    url: variableToken(actionOutputAttachment({ uuid: urlUuid, outputName: 'Item from List' })),
    authorization: textToken([
      'Bearer ',
      { attachment: actionOutputAttachment({ uuid: tokenUuid, outputName: 'Item from List' }) },
    ]),
  };
}

function itemFromList(uuid: string, input: PlistValue, index: number): PlistValue {
  return action(
    'is.workflow.actions.getitemfromlist',
    plist.dict({
      UUID: plist.string(uuid),
      WFInput: input,
      WFItemSpecifier: plist.string('Item At Index'),
      WFItemIndex: plist.integer(index),
    }),
  );
}

function download(variables: ConnectionVariables, fields: ReadonlyArray<DictionaryField>): PlistValue {
  return downloadAction({
    url: variables.url,
    headers: [field('Authorization', 0, variables.authorization)],
    fields,
  });
}

function locationActions(variables: ConnectionVariables, nextUuid: () => string): PlistValue[] {
  const outputUuid = nextUuid();
  return [
    action('is.workflow.actions.getcurrentlocation', plist.dict({ UUID: plist.string(outputUuid) })),
    download(variables, [
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
  variables: ConnectionVariables,
  key: 'text' | 'steps',
  itemType: 0 | 3,
): PlistValue[] {
  return [
    download(variables, [
      field('v', 3, plainToken('1')),
      currentDateField(),
      field('kind', 0, plainToken(kind)),
      field(key, itemType, variableToken(extensionInputAttachment())),
    ]),
  ];
}

function voiceMemoActions(variables: ConnectionVariables, nextUuid: () => string, sent: string): PlistValue[] {
  const outputUuid = nextUuid();
  return [
    action('is.workflow.actions.dictatetext', plist.dict({ UUID: plist.string(outputUuid) })),
    download(variables, [
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

/** Builds the four generic iOS shortcuts that ask for the connection string on import. */
export function buildIosImportTemplates(options: IosImportOptions): IosShortcut[] {
  const texts = fileTexts(options.language ?? 'ko');
  const uuid = options.uuid ?? (() => randomUUID());
  const nextUuid = (): string => uuid().toUpperCase();

  const builders: ReadonlyArray<{ kind: ShortcutKind; body: (v: ConnectionVariables) => PlistValue[] }> = [
    { kind: 'location', body: (variables) => locationActions(variables, nextUuid) },
    { kind: 'sms', body: (variables) => textInputActions('sms', variables, 'text', 0) },
    { kind: 'steps', body: (variables) => textInputActions('steps', variables, 'steps', 3) },
    { kind: 'voice_memo', body: (variables) => voiceMemoActions(variables, nextUuid, texts.sent) },
  ];

  return builders.map(({ kind, body }) => {
    const variables = connectionActions(nextUuid);
    const actions = [...variables.actions, ...body(variables)];
    return {
      kind,
      fileName: shortcutFileName(options.assistantName, texts.shortcutLabels[kind]),
      plistXml: renderPlist(
        workflow({
          actions,
          hasShortcutInput: kind === 'sms' || kind === 'steps',
          importQuestions: [importQuestion(texts.connectionQuestion)],
        }),
      ),
    };
  });
}
