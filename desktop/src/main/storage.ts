import Database from 'better-sqlite3';
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { isSecureCredentialBackend } from '../contracts/credential-policy';

const PROFILE = 'archivist-tt001-diagnostic';
let sessionCanary: string | undefined;
const CANARY = 'TT001_CANARY_NOT_A_REAL_SECRET_';
let db: Database.Database | undefined;
let profilePath = '';

export function openStorage() {
  profilePath = path.join(app.getPath('userData'), PROFILE);
  fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(profilePath, 0o700); } catch { /* Windows ACLs inherit from userData */ }
  db = new Database(path.join(profilePath, 'diagnostic.sqlite3'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS diagnostic_fixture (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS child_fixture (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES diagnostic_fixture(id))');
}
export function closeStorage() { db?.close(); db = undefined; }
export function foreignKeysEnabled() { return db?.pragma('foreign_keys', { simple: true }) === 1; }
export function credentialPresent() { return fs.existsSync(path.join(profilePath, 'credential.bin')); }
export function rollbackVerified() { return verifyRollback(); }
export function sqliteVersion() { return String((db?.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined)?.v ?? 'unknown'); }
export function readFixture(): string | null {
  if (!db) throw new Error('Database is unavailable');
  return (db.prepare('SELECT value FROM diagnostic_fixture WHERE id = 1').get() as { value: string } | undefined)?.value ?? null;
}
export function writeFixture(value: string) {
  if (!db) throw new Error('Database is unavailable');
  const tx = db.transaction((v: string) => db!.prepare('INSERT INTO diagnostic_fixture(id,value,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(v, new Date().toISOString()));
  tx(value);
}
export function verifyRollback() {
  if (!db) throw new Error('Database is unavailable');
  const before = readFixture();
  try { db.transaction(() => { db!.prepare('INSERT INTO diagnostic_fixture(id,value,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run('rollback-canary', new Date().toISOString()); throw new Error('intentional rollback'); })(); } catch { /* expected */ }
  return readFixture() === before;
}
export function deleteFixture() {
  if (!db) throw new Error('Database is unavailable');
  db.prepare('DELETE FROM child_fixture').run(); db.prepare('DELETE FROM diagnostic_fixture').run();
  sessionCanary = undefined;
  try { fs.unlinkSync(path.join(profilePath, 'credential.bin')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return readFixture() === null && !fs.existsSync(path.join(profilePath, 'credential.bin'));
}
export async function credentialStatus() {
  if (os.platform() === 'linux') {
    if (!safeStorage.isEncryptionAvailable()) return { backend: 'unavailable', secure: false };
    const backend = safeStorage.getSelectedStorageBackend();
    return { backend, secure: isSecureCredentialBackend(os.platform(), backend) };
  }
  const available = safeStorage.isEncryptionAvailable();
  const backend = os.platform() === 'darwin' ? 'macOS Keychain' : os.platform() === 'win32' ? 'Windows DPAPI' : 'unsupported platform';
  return { backend, secure: available && isSecureCredentialBackend(os.platform(), backend) };
}
export function memoryOnlyCredentialSession() {
  if (!sessionCanary) sessionCanary = CANARY + cryptoRandom();
  if (!sessionCanary.startsWith(CANARY)) throw new Error('Session-only credential check failed');
  return { stored: true, backend: 'memory-only' as const };
}
export async function credentialRoundTrip(forceReplace = false) {
  const status = await credentialStatus();
  if (!status.secure) throw new Error(`Secure credential storage unavailable (${status.backend}); persistence refused`);
  const file = path.join(profilePath, 'credential.bin');
  const existed = fs.existsSync(file);
  const replace = !existed || forceReplace;
  // Electron 41 exposes synchronous safeStorage on each supported platform.
  if (replace) {
    fs.writeFileSync(file, safeStorage.encryptString(CANARY + cryptoRandom()), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs inherit from profile */ }
  }
  const decoded = safeStorage.decryptString(fs.readFileSync(file));
  if (!decoded.startsWith(CANARY)) throw new Error('Credential verification failed');
  return { stored: true, backend: status.backend, retrievedExisting: existed && !forceReplace, replaced: existed && forceReplace };
}
function cryptoRandom() { return randomBytes(16).toString('hex'); }
