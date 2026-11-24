import { plist, type PlistValue } from './plist.js';
import { currentDateAttachment, dictionary, variableToken, type DictionaryField } from './text-token.js';

const CLIENT_VERSION = '2607.0.2';
const MINIMUM_CLIENT_VERSION = 900;
const ICON_START_COLOR = 4282601983;
const ICON_GLYPH_NUMBER = 59511;
const INPUT_CONTENT_ITEM_CLASSES = ['WFStringContentItem', 'WFNumberContentItem'];

/** One Shortcuts action: identifier plus its parameter dictionary. */
export function action(identifier: string, parameters: PlistValue): PlistValue {
  return plist.dict({
    WFWorkflowActionIdentifier: plist.string(identifier),
    WFWorkflowActionParameters: parameters,
  });
}

export function field(key: string, itemType: 0 | 3, value: PlistValue): DictionaryField {
  return { key, itemType, value };
}

export function currentDateField(): DictionaryField {
  return field('ts', 0, variableToken(currentDateAttachment()));
}

export interface DownloadActionInput {
  url: PlistValue;
  headers: ReadonlyArray<DictionaryField>;
  fields: ReadonlyArray<DictionaryField>;
}

export function downloadAction(input: DownloadActionInput): PlistValue {
  return action(
    'is.workflow.actions.downloadurl',
    plist.dict({
      WFURL: input.url,
      WFHTTPMethod: plist.string('POST'),
      WFHTTPBodyType: plist.string('JSON'),
      ShowHeaders: plist.boolean(true),
      WFHTTPHeaders: dictionary(input.headers),
      WFJSONValues: dictionary(input.fields),
    }),
  );
}

export interface WorkflowParts {
  actions: ReadonlyArray<PlistValue>;
  hasShortcutInput?: boolean;
  importQuestions?: ReadonlyArray<PlistValue>;
}

export function workflow(parts: WorkflowParts): PlistValue {
  const entries: Record<string, PlistValue> = {
    WFWorkflowClientVersion: plist.string(CLIENT_VERSION),
    WFWorkflowMinimumClientVersion: plist.integer(MINIMUM_CLIENT_VERSION),
    WFWorkflowIcon: plist.dict({
      WFWorkflowIconStartColor: plist.integer(ICON_START_COLOR),
      WFWorkflowIconGlyphNumber: plist.integer(ICON_GLYPH_NUMBER),
    }),
    WFWorkflowTypes: plist.array([]),
    WFWorkflowImportQuestions: plist.array(parts.importQuestions ?? []),
    WFQuickActionSurfaces: plist.array([]),
    WFWorkflowInputContentItemClasses: plist.array(
      INPUT_CONTENT_ITEM_CLASSES.map((name) => plist.string(name)),
    ),
  };
  if (parts.hasShortcutInput === true) {
    entries.WFWorkflowHasShortcutInputVariables = plist.boolean(true);
  }
  entries.WFWorkflowActions = plist.array(parts.actions);
  return plist.dict(entries);
}

export function shortcutFileName(assistantName: string, label: string): string {
  const safeName = assistantName.replace(/[/:]/g, '').trim();
  return `${safeName} ${label}.shortcut`;
}
