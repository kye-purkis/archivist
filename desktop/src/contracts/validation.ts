export function validateFixture(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !value.includes('\0');
}

export function canonicalizeDocumentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['file:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isTrustedInvocation(senderMatches: boolean, frameIsMain: boolean, actualUrl: string, expectedUrl: string) {
  const actual = canonicalizeDocumentUrl(actualUrl);
  const expected = canonicalizeDocumentUrl(expectedUrl);
  return senderMatches && frameIsMain && actual !== null && expected !== null && actual === expected;
}

export function hasExpectedArgumentCount(actual: number, expected: number) {
  return Number.isInteger(actual) && actual === expected;
}
