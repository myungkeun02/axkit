export interface FxConfig {
  homeCurrency: string;
  /** Home-currency value of one unit of the keyed currency. */
  fxRates: Readonly<Record<string, number>>;
  /** Called once per unknown currency, so a config gap is visible without flooding the log. */
  warn?: (currency: string) => void;
}

export interface HomeAmount {
  amount: number;
  /** True when a configured rate was used instead of an amount the card company stated. */
  estimated: boolean;
}

const warnedByConfig = new WeakMap<object, Set<string>>();

/** Rounds the way the home currency is written: KRW to whole units, others to two decimals. */
export function roundMoney(currency: string, amount: number): number {
  return currency.toUpperCase() === 'KRW' ? Math.round(amount) : Math.round(amount * 100) / 100;
}

function rateFor(config: FxConfig, currency: string): number | undefined {
  const wanted = currency.toUpperCase();
  for (const [code, rate] of Object.entries(config.fxRates)) {
    if (code.toUpperCase() === wanted && Number.isFinite(rate) && rate > 0) return rate;
  }
  return undefined;
}

function warnUnknown(config: FxConfig, currency: string): void {
  if (config.warn === undefined) return;
  let warned = warnedByConfig.get(config);
  if (warned === undefined) {
    warned = new Set();
    warnedByConfig.set(config, warned);
  }
  if (warned.has(currency)) return;
  warned.add(currency);
  config.warn(currency);
}

/** Converts a charged amount to the owner's home currency, preferring an amount the card company stated. */
export function toHome(
  amount: number,
  currency: string,
  config: FxConfig,
  statedHomeAmount?: number,
): HomeAmount {
  const home = config.homeCurrency.toUpperCase();
  const charged = currency.toUpperCase();
  if (charged === home) return { amount, estimated: false };
  if (statedHomeAmount !== undefined && statedHomeAmount > 0) return { amount: statedHomeAmount, estimated: false };
  const rate = rateFor(config, charged);
  if (rate === undefined) {
    warnUnknown(config, charged);
    return { amount, estimated: true };
  }
  return { amount: roundMoney(home, rate * amount), estimated: true };
}
