export type SafeResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type DiagnosticStatus = {
  electron: string; node: string; chrome: string; sqlite: string; database: 'ready' | 'unavailable'; storageMessage?: string;
  credentialBackend: string; secureCredentials: boolean; lastFixture?: string; rollbackVerified: boolean; singleInstanceGuard: boolean; credentialFilePresent: boolean; foreignKeysEnabled: boolean;
};
export interface DiagnosticApi {
  status(): Promise<SafeResult<DiagnosticStatus>>;
  writeFixture(value: string): Promise<SafeResult<{ value: string }>>;
  readFixture(): Promise<SafeResult<{ value: string | null }>>;
  credentialRoundTrip(): Promise<SafeResult<{ stored: boolean; backend: string; retrievedExisting: boolean; replaced: boolean }>>;
  replaceCredentialCanary(): Promise<SafeResult<{ stored: boolean; backend: string; retrievedExisting: boolean; replaced: boolean }>>;
  runMemoryOnlyCredentialSession(): Promise<SafeResult<{ stored: boolean; backend: 'memory-only' }>>;
  deleteFixtures(): Promise<SafeResult<{ deleted: boolean }>>;
}
