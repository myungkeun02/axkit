import { describe, expect, it, vi } from 'vitest';
import { roundMoney, toHome } from '../../../src/skills/spending/fx.js';
import type { FxConfig } from '../../../src/skills/spending/fx.js';

const KRW: FxConfig = { homeCurrency: 'KRW', fxRates: { USD: 1400, EUR: 1500, JPY: 9.5 } };

describe('toHome', () => {
  it('leaves the home currency unchanged', () => {
    expect(toHome(12_300, 'KRW', KRW)).toEqual({ amount: 12_300, estimated: false });
    expect(toHome(12_300, 'krw', KRW)).toEqual({ amount: 12_300, estimated: false });
  });

  it('prefers an amount the card company stated', () => {
    expect(toHome(12.34, 'USD', KRW, 17_276)).toEqual({ amount: 17_276, estimated: false });
  });

  it('converts with the configured rate and marks it estimated', () => {
    expect(toHome(12.34, 'USD', KRW)).toEqual({ amount: 17_276, estimated: true });
    expect(toHome(100, 'JPY', KRW)).toEqual({ amount: 950, estimated: true });
  });

  it('rounds to the home currency precision', () => {
    expect(roundMoney('KRW', 17276.4)).toBe(17276);
    expect(roundMoney('USD', 8.856)).toBe(8.86);
    const usd: FxConfig = { homeCurrency: 'USD', fxRates: { KRW: 0.00072 } };
    expect(toHome(12_300, 'KRW', usd)).toEqual({ amount: 8.86, estimated: true });
  });

  it('leaves an unknown currency unchanged and warns once per currency', () => {
    const warn = vi.fn();
    const config: FxConfig = { homeCurrency: 'KRW', fxRates: {}, warn };

    expect(toHome(10, 'CHF', config)).toEqual({ amount: 10, estimated: true });
    expect(toHome(20, 'CHF', config)).toEqual({ amount: 20, estimated: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('CHF');

    toHome(30, 'SEK', config);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
