import { describe, expect, it } from 'vitest';
import { validateFixture, hasExpectedArgumentCount } from '../src/contracts/validation';
import { isTrustedInvocation, canonicalizeDocumentUrl } from '../src/contracts/validation';
import { isSecureCredentialBackend } from '../src/contracts/credential-policy';
describe('diagnostic input contract', () => {
  it('accepts bounded fixture text, including harmless markup as text', () => {
    expect(validateFixture('synthetic fixture')).toBe(true);
    expect(validateFixture('<img src=x onerror=alert(1)>')).toBe(true);
    expect(validateFixture('literal\\0sequence')).toBe(true);
  });
  it('rejects malformed, oversized and NUL-containing values', () => {
    expect(validateFixture(undefined)).toBe(false);
    expect(validateFixture('')).toBe(false);
    expect(validateFixture('x'.repeat(161))).toBe(false);
    expect(validateFixture(`bad${String.fromCharCode(0)}value`)).toBe(false);
  });
});

describe('IPC sender and frame authority', () => {
  it('accepts only equivalent serialization of the exact loaded document', () => {
    expect(isTrustedInvocation(true, true, 'http://localhost:5178/', 'http://localhost:5178')).toBe(true);
    expect(isTrustedInvocation(true, true, 'file:///app/index.html', 'file:///app/index.html')).toBe(true);
    for (const other of [
      'http://localhost:5178/other',
      'http://localhost:5178/?query=1',
      'http://localhost:5178/#hash',
      'http://localhost:5179/',
      'http://127.0.0.1:5178/',
    ]) expect(isTrustedInvocation(true, true, other, 'http://localhost:5178')).toBe(false);
    expect(isTrustedInvocation(false, true, 'http://localhost:5178/', 'http://localhost:5178')).toBe(false);
    expect(isTrustedInvocation(true, false, 'http://localhost:5178/', 'http://localhost:5178')).toBe(false);
  });
  it('rejects non-local protocols and malformed URLs', () => {
    expect(canonicalizeDocumentUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeDocumentUrl('not a URL')).toBeNull();
  });
});

describe('credential provider policy', () => {
  it('accepts only named Linux secret stores and known desktop platforms', () => {
    expect(isSecureCredentialBackend('linux', 'gnome_libsecret')).toBe(true);
    expect(isSecureCredentialBackend('linux', 'kwallet6')).toBe(true);
    expect(isSecureCredentialBackend('linux', 'basic_text')).toBe(false);
    expect(isSecureCredentialBackend('linux', 'unknown')).toBe(false);
    expect(isSecureCredentialBackend('darwin', 'macOS Keychain')).toBe(true);
    expect(isSecureCredentialBackend('win32', 'Windows DPAPI')).toBe(true);
    expect(isSecureCredentialBackend('freebsd', 'unknown')).toBe(false);
  });
});

describe('operation shape validation', () => {
  it('rejects extra and non-integer IPC argument counts', () => {
    expect(hasExpectedArgumentCount(0, 0)).toBe(true);
    expect(hasExpectedArgumentCount(2, 1)).toBe(false);
    expect(hasExpectedArgumentCount(Number.NaN, 0)).toBe(false);
  });
});
