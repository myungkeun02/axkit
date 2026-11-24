const SALE_LABEL = /판매가|할인가|최종가|최저가|\b(?:price|sale|now)\b/i;
const EXPLICIT =
  /(?:US\$|\$|USD)\s*([0-9](?:[0-9]|,(?=[0-9]))*(?:\.[0-9]{1,2})?)|([0-9](?:[0-9]|,(?=[0-9]))*(?:\.[0-9]{1,2})?)\s*(?:USD|dollars?)/gi;
const BARE = /(?<![\d,.:/-])([0-9](?:[0-9]|,(?=[0-9]))*(?:\.[0-9]{1,2})?)(?![\d,.:/-])/g;
const NOT_A_PRICE_SUFFIX = /[%년월일시분초개명건회차호]/;

function amountOf(raw: string): number | undefined {
  const value = Number(raw.replaceAll(',', ''));
  if (!Number.isFinite(value) || value < 1) return undefined;
  return value;
}

function explicitAmounts(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(EXPLICIT)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined) continue;
    const value = amountOf(raw);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function bareAmounts(line: string): number[] {
  const values: number[] = [];
  for (const match of line.matchAll(BARE)) {
    const raw = match[1];
    const index = match.index;
    if (raw === undefined || index === undefined) continue;
    if (!raw.includes('.') && !raw.includes(',')) {
      const whole = Number(raw);
      if (whole >= 1900 && whole <= 2100) continue;
    }
    const value = amountOf(raw);
    if (value === undefined) continue;
    const after = line.slice(index + raw.length, index + raw.length + 1);
    if (NOT_A_PRICE_SUFFIX.test(after)) continue;
    values.push(value);
  }
  return values;
}

function amountsIn(text: string): number[] {
  return [...explicitAmounts(text), ...bareAmounts(text)];
}

/** Smallest plausible price in US dollars; a price after price/sale/now wins. */
export function extractUsd(text: string): number | undefined {
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const label = SALE_LABEL.exec(line);
    if (label === null) continue;
    const after = line.slice(label.index + label[0].length);
    const inline = amountsIn(after);
    if (inline.length > 0) return inline[0];
    const next = lines[index + 1];
    if (next !== undefined) {
      const nextLine = amountsIn(next);
      if (nextLine.length > 0) return nextLine[0];
    }
  }

  const pool = lines.flatMap(amountsIn);
  return pool.length === 0 ? undefined : Math.min(...pool);
}
