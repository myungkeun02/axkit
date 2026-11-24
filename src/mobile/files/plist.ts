/** A minimal XML property list value. Shortcut files are plists; we only need these six node types. */
export type PlistValue =
  | { readonly type: 'dict'; readonly entries: ReadonlyArray<readonly [string, PlistValue]> }
  | { readonly type: 'array'; readonly items: ReadonlyArray<PlistValue> }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'integer'; readonly value: number }
  | { readonly type: 'real'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean };

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function renderValue(value: PlistValue, depth: number): string {
  switch (value.type) {
    case 'dict':
      if (value.entries.length === 0) return `${indent(depth)}<dict/>`;
      return [
        `${indent(depth)}<dict>`,
        ...value.entries.map(([key, item]) => `${indent(depth + 1)}<key>${escapeXml(key)}</key>\n${renderValue(item, depth + 1)}`),
        `${indent(depth)}</dict>`,
      ].join('\n');
    case 'array':
      if (value.items.length === 0) return `${indent(depth)}<array/>`;
      return [
        `${indent(depth)}<array>`,
        ...value.items.map((item) => renderValue(item, depth + 1)),
        `${indent(depth)}</array>`,
      ].join('\n');
    case 'string':
      return `${indent(depth)}<string>${escapeXml(value.value)}</string>`;
    case 'integer':
      return `${indent(depth)}<integer>${value.value}</integer>`;
    case 'real':
      return `${indent(depth)}<real>${value.value}</real>`;
    case 'boolean':
      return `${indent(depth)}${value.value ? '<true/>' : '<false/>'}`;
  }
}

function finite(value: number, kind: string): number {
  if (!Number.isFinite(value)) throw new Error(`${kind} plist value must be finite`);
  return value;
}

export const plist = {
  dict(entries: Readonly<Record<string, PlistValue>>): PlistValue {
    return { type: 'dict', entries: Object.entries(entries) };
  },
  array(items: ReadonlyArray<PlistValue>): PlistValue {
    return { type: 'array', items };
  },
  string(value: string): PlistValue {
    return { type: 'string', value };
  },
  integer(value: number): PlistValue {
    if (!Number.isInteger(value)) throw new Error('integer plist value must be an integer');
    return { type: 'integer', value };
  },
  real(value: number): PlistValue {
    return { type: 'real', value: finite(value, 'real') };
  },
  boolean(value: boolean): PlistValue {
    return { type: 'boolean', value };
  },
};

/** Renders a full XML plist document, including the Apple doctype. */
export function renderPlist(root: PlistValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderValue(root, 0),
    '</plist>',
    '',
  ].join('\n');
}
