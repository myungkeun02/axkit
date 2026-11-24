const SOLD_OUT = [
  /품절/,
  /일시\s*품절/,
  /재고\s*없음/,
  /판매\s*종료/,
  /입고\s*예정/,
  /sold\s*out/i,
  /out\s*of\s*stock/i,
  /currently\s*unavailable/i,
  /notify\s+me\s+when\s+available/i,
];

/** A page with no sold-out wording is treated as purchasable. */
export function inStockOf(text: string): boolean {
  return !SOLD_OUT.some((pattern) => pattern.test(text));
}
