import { plist, type PlistValue } from './plist.js';

/** Shortcuts encodes a variable in a text token as U+FFFC at the UTF-16 index where it appears. */
export const VARIABLE_PLACEHOLDER = '￼';

export type TokenSegment = string | { readonly attachment: PlistValue };

function textTokenValue(string: string, attachmentsByRange: Record<string, PlistValue>): PlistValue {
  const value: Record<string, PlistValue> = { string: plist.string(string) };
  if (Object.keys(attachmentsByRange).length > 0) {
    value.attachmentsByRange = plist.dict(attachmentsByRange);
  }
  return plist.dict({
    Value: plist.dict(value),
    WFSerializationType: plist.string('WFTextTokenString'),
  });
}

export function textToken(segments: ReadonlyArray<TokenSegment>): PlistValue {
  let string = '';
  const attachmentsByRange: Record<string, PlistValue> = {};
  for (const segment of segments) {
    if (typeof segment === 'string') {
      string += segment;
      continue;
    }
    attachmentsByRange[`{${string.length}, 1}`] = segment.attachment;
    string += VARIABLE_PLACEHOLDER;
  }
  return textTokenValue(string, attachmentsByRange);
}

export function plainToken(text: string): PlistValue {
  return textToken([text]);
}

export function variableToken(attachment: PlistValue): PlistValue {
  return textToken([{ attachment }]);
}

export function extensionInputAttachment(): PlistValue {
  return plist.dict({ Type: plist.string('ExtensionInput') });
}

export function currentDateAttachment(): PlistValue {
  return plist.dict({
    Type: plist.string('CurrentDate'),
    Aggrandizements: plist.array([
      plist.dict({
        Type: plist.string('WFDateFormatVariableAggrandizement'),
        WFDateFormatStyle: plist.string('ISO 8601'),
        WFISO8601IncludeTime: plist.boolean(true),
      }),
    ]),
  });
}

export interface ActionOutputArgs {
  readonly uuid: string;
  readonly outputName: string;
  readonly property?: string;
}

export interface DictionaryField {
  readonly key: string;
  /** 0 = text, 3 = number in a Shortcuts dictionary field. */
  readonly itemType: 0 | 3;
  readonly value: PlistValue;
}

export function dictionary(fields: ReadonlyArray<DictionaryField>): PlistValue {
  return plist.dict({
    Value: plist.dict({
      WFDictionaryFieldValueItems: plist.array(
        fields.map((field) =>
          plist.dict({
            WFItemType: plist.integer(field.itemType),
            WFKey: plainToken(field.key),
            WFValue: field.value,
          }),
        ),
      ),
    }),
    WFSerializationType: plist.string('WFDictionaryFieldValue'),
  });
}

export function actionOutputAttachment(args: ActionOutputArgs): PlistValue {
  const attachment: Record<string, PlistValue> = {
    Type: plist.string('ActionOutput'),
    OutputUUID: plist.string(args.uuid),
    OutputName: plist.string(args.outputName),
  };
  if (args.property !== undefined) {
    attachment.Aggrandizements = plist.array([
      plist.dict({
        Type: plist.string('WFPropertyVariableAggrandizement'),
        PropertyName: plist.string(args.property),
      }),
    ]);
  }
  return plist.dict(attachment);
}
