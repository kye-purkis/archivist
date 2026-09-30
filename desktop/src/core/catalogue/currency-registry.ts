import registry from './currencies.json';

export interface Currency { code: string; exponent: number; }
const entries = (registry as { currencies: Currency[] }).currencies;
const byCode = new Map(entries.map((entry) => [entry.code, entry]));
export const CURRENCY_REGISTRY_VERSION = (registry as { version: string }).version;
export const CURRENCY_REGISTRY_SOURCE = (registry as { source: string }).source;
export function currencyFor(code: unknown): Currency | undefined { return typeof code === 'string' ? byCode.get(code) : undefined; }
export function allCurrencies(): Currency[] { return entries.map((entry) => ({ ...entry })); }
