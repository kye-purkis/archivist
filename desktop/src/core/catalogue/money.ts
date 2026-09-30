import { CatalogueError } from './contracts';
import { currencyFor } from './currency-registry';

const SQLITE_INT64_MAX = 9223372036854775807n;
export function decimalToMinor(amount: unknown, currency: unknown): { amountMinor: bigint | null; currencyCode: string | null } {
  if (amount === null || amount === undefined) {
    if (currency !== null && currency !== undefined && !currencyFor(currency)) throw new CatalogueError('VALIDATION_FAILED', 'Currency is not in the supported registry.', false, [{ field: 'currency', message: 'Choose a registered currency code.' }]);
    return { amountMinor: null, currencyCode: currency == null ? null : String(currency) };
  }
  if (typeof amount !== 'string' || !/^(0|[1-9]\d*)(?:\.(\d+))?$/.test(amount)) throw new CatalogueError('VALIDATION_FAILED', 'Amount must be a nonnegative decimal string.', false, [{ field: 'amount', message: 'Enter a nonnegative decimal amount as text.' }]);
  const code = currencyFor(currency);
  if (!code) throw new CatalogueError('VALIDATION_FAILED', 'A registered currency is required for a known amount.', false, [{ field: 'currency', message: 'Choose a registered currency code.' }]);
  const [, whole, fraction = ''] = amount.match(/^(0|[1-9]\d*)(?:\.(\d+))?$/)!;
  if (fraction.length > code.exponent) throw new CatalogueError('VALIDATION_FAILED', 'Amount has more fractional digits than the currency supports.', false, [{ field: 'amount', message: `Use at most ${code.exponent} fractional digits for ${code.code}.` }]);
  const factor = 10n ** BigInt(code.exponent);
  const minor = BigInt(whole) * factor + BigInt((fraction + '0'.repeat(code.exponent)).slice(0, code.exponent) || '0');
  if (minor > SQLITE_INT64_MAX) throw new CatalogueError('VALIDATION_FAILED', 'Amount exceeds the supported range.', false, [{ field: 'amount', message: 'Amount exceeds the supported range.' }]);
  return { amountMinor: minor, currencyCode: code.code };
}
export function minorToDecimal(minor: number | bigint | null, code: string | null): string | null {
  if (minor === null) return null;
  const entry = currencyFor(code);
  if (!entry) throw new CatalogueError('SCHEMA_MISMATCH', 'Stored currency is not registered.');
  const value = BigInt(minor);
  const factor = 10n ** BigInt(entry.exponent);
  if (!entry.exponent) return value.toString();
  return `${value / factor}.${(value % factor).toString().padStart(entry.exponent, '0')}`;
}
