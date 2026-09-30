import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { CatalogueError } from './contracts';
import { validateRequest, canonicalJson } from './validation';
import { minorToDecimal } from './money';
import { isCalendarDate } from './calendar-date';
import { allCurrencies, currencyFor } from './currency-registry';
import { APPLICATION_ID, preflight, SCHEMA_VERSION } from './migrations';
import { validateActiveGraph } from './integrity';

const FORMAT_NAME = 'archivist-sqlite-backup';
const FORMAT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const SNAPSHOT_NAME = 'catalogue.sqlite3';
const BACKUP_LINEAGE_PLACEHOLDER = 'archivist-backup-v1';
const MAX_MANIFEST_BYTES = 64 * 1024;
const SQLITE_INT64_MAX = 9223372036854775807n;
const ENTITY_TABLES: Record<string, string> = {
  work: 'works',
  edition: 'editions',
  owned_copy: 'owned_copies',
  format: 'formats',
};

export interface CatalogueBackupTotals {
  catalogueRevision: number;
  workCount: number;
  ownedWorkCount: number;
  copyCount: number;
  pricedCopyCount: number;
  unpricedCopyCount: number;
  freeCopyCount: number;
  spendByCurrency: Array<{ currency: string; amount: string; pricedCopyCount: number }>;
}

export interface CatalogueBackupManifest {
  format: typeof FORMAT_NAME;
  formatVersion: typeof FORMAT_VERSION;
  createdAt: string;
  applicationId: number;
  schemaVersion: number;
  snapshot: { file: typeof SNAPSHOT_NAME; sizeBytes: number; sha256: string };
  inclusions: {
    catalogue: true;
    changeHistory: true;
    conversations: false;
    credentials: false;
    sessions: false;
    runtimeAuthority: false;
  };
  totals: CatalogueBackupTotals;
}

export interface CatalogueRecoverySummary {
  formatVersion: number;
  createdAt: string;
  schemaVersion: number;
  totals: CatalogueBackupTotals;
  changeHistoryIncluded: true;
  conversationsIncluded: false;
}

export type RestoreFailurePoint = 'after-marker' | 'after-preserve' | 'after-install';
export interface RestoreTestOptions {
  injectFailureAt?: RestoreFailurePoint;
}

export interface CatalogueRestoreResult {
  currentBackupDirectory: string;
  manifest: CatalogueBackupManifest;
}

interface RestoreMarker {
  version: 1;
  target: string;
  staged: string;
  previous: string;
}

function asSafeInteger(value: unknown, minimum = 0): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue recovery data contains an unsupported integer.');
  }
  return result;
}

function asSafeMinorUnits(value: unknown): bigint {
  let result: bigint;
  try { result = BigInt(String(value)); } catch {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue recovery data contains an invalid amount.');
  }
  if (result < 0n || result > SQLITE_INT64_MAX) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue recovery data contains an invalid amount.');
  }
  return result;
}

function fail(code: string, message: string, retryable = false): CatalogueError {
  return new CatalogueError(code, message, retryable);
}

function currentLineage(catalogueId: string): string {
  return `desktop-local-collector:${catalogueId}`;
}

function readState(db: Database.Database): { catalogueId: string; catalogueRevision: number; schemaVersion: number } {
  const row = db.prepare('SELECT catalogue_id,schema_version,catalogue_revision FROM catalogue_state WHERE singleton_id=1').get() as Record<string, unknown> | undefined;
  if (!row || typeof row.catalogue_id !== 'string' || !row.catalogue_id) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue recovery state is invalid.');
  }
  return {
    catalogueId: row.catalogue_id,
    schemaVersion: asSafeInteger(row.schema_version, 1),
    catalogueRevision: asSafeInteger(row.catalogue_revision),
  };
}

function tableHasId(db: Database.Database, kind: string, id: string): boolean {
  const table = ENTITY_TABLES[kind];
  if (!table) return false;
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id);
}

function validateReference(db: Database.Database, reference: unknown): void {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history contains an invalid record reference.');
  }
  const value = reference as Record<string, unknown>;
  if (typeof value.type !== 'string' || typeof value.id !== 'string' || !tableHasId(db, value.type, value.id)) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history references an unavailable record.');
  }
  if (value.revision !== undefined) asSafeInteger(value.revision, 1);
}

function validateUndoRequest(
  db: Database.Database,
  request: Record<string, unknown>,
  changesetId: unknown,
  storedRequestId: unknown,
  storedUndoOf: unknown,
  expectedLineage: string,
): { contractVersion: 1; requestId: string; undoOf: string } {
  if (
    Object.keys(request).sort().join('|') !== 'contractVersion|requestId|undoOf' ||
    request.contractVersion !== 1 ||
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    request.requestId.length > 160 ||
    request.requestId !== storedRequestId ||
    typeof request.undoOf !== 'string' ||
    !request.undoOf ||
    request.undoOf !== storedUndoOf ||
    request.undoOf === changesetId
  ) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue undo history request is invalid.');
  }
  const original = db.prepare('SELECT id,principal_lineage,origin_kind FROM changesets WHERE id=?').get(request.undoOf) as Record<string, unknown> | undefined;
  if (!original || original.principal_lineage !== expectedLineage || original.origin_kind !== 'collector') {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue undo history target is invalid.');
  }
  return { contractVersion: 1, requestId: request.requestId, undoOf: request.undoOf };
}

function validateSnapshotReferences(db: Database.Database, kind: string, id: string, snapshot: Record<string, unknown>, revision: number): void {
  const record = kind === 'edition' || kind === 'owned_copy' ? snapshot.record : snapshot;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history snapshot is invalid.');
  }
  const recordValue = record as Record<string, unknown>;
  if (recordValue.id !== id || asSafeInteger(recordValue.revision, 1) !== revision) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history snapshot revisions do not match.');
  }
  if (kind === 'owned_copy') {
    if (typeof recordValue.edition_id !== 'string' || !tableHasId(db, 'edition', recordValue.edition_id)) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history snapshot references an unavailable edition.');
    }
    const acquisition = snapshot.acquisition;
    if (acquisition !== null) {
      if (!acquisition || typeof acquisition !== 'object' || Array.isArray(acquisition)) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history acquisition snapshot is invalid.');
      }
      const value = acquisition as Record<string, unknown>;
      if (value.purchase_date !== null && (typeof value.purchase_date !== 'string' || !isCalendarDate(value.purchase_date))) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history contains an invalid purchase date.');
      }
      if (value.amount_minor !== null) {
        asSafeMinorUnits(value.amount_minor);
        if (!currencyFor(value.currency_code)) {
          throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history contains an invalid purchase amount.');
        }
      }
    }
  } else if (kind === 'edition') {
    if (!Array.isArray(snapshot.contents) || !Array.isArray(snapshot.formats) || !snapshot.contents.length || !snapshot.formats.length) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history edition snapshot is incomplete.');
    }
    const contentCategories = new Set<string>();
    for (const content of snapshot.contents) {
      if (!content || typeof content !== 'object' || Array.isArray(content)) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history edition contents are invalid.');
      }
      const value = content as Record<string, unknown>;
      if (typeof value.work_id !== 'string' || !tableHasId(db, 'work', value.work_id)) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history edition references an unavailable work.');
      }
      const work = db.prepare('SELECT category FROM works WHERE id=?').get(value.work_id) as Record<string, unknown> | undefined;
      if (!work || typeof work.category !== 'string') throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history edition work is invalid.');
      const category = String(work.category);
      contentCategories.add(category);
      if (!['film', 'tv', 'music', 'game'].includes(category)) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history work category is unsupported.');
      if (!Array.isArray(value.seasons) || value.seasons.some((season) => !Number.isSafeInteger(season) || Number(season) < 0)) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history TV coverage is invalid.');
      }
      const mode = String(value.coverage_mode);
      if (
        (category === 'tv' && (mode === 'not_applicable' || (mode === 'explicit' && value.seasons.length === 0) || (mode === 'unknown' && value.seasons.length > 0))) ||
        (category !== 'tv' && (mode !== 'not_applicable' || value.seasons.length > 0)) ||
        !['not_applicable', 'unknown', 'explicit', 'complete'].includes(mode)
      ) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history TV coverage is invalid.');
      }
    }
    const formatCategories = new Set<string>();
    for (const formatId of snapshot.formats) {
      if (typeof formatId !== 'string' || !tableHasId(db, 'format', formatId)) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history edition references an unavailable format.');
      }
      const format = db.prepare('SELECT category FROM formats WHERE id=?').get(formatId) as Record<string, unknown> | undefined;
      if (!format || typeof format.category !== 'string') throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history format is invalid.');
      formatCategories.add(String(format.category));
    }
    if ([...contentCategories].some((category) => !formatCategories.has(category)) || [...formatCategories].some((category) => !contentCategories.has(category))) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue history edition formats do not match its work categories.');
    }
  }
}

function parseObjectJson(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new CatalogueError('SCHEMA_MISMATCH', `${description} is not valid JSON.`);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CatalogueError('SCHEMA_MISMATCH', `${description} is not valid JSON.`);
  }
}

function validateHistory(db: Database.Database, expectedLineage: string, catalogueRevision: number): number {
  const changesets = db.prepare(`SELECT id,request_id,input_hash,principal_lineage,origin_conversation_id,undo_of,origin_kind,
      status,request,result FROM changesets ORDER BY created_at,id`).iterate() as Iterable<Record<string, unknown>>;
  const receiptRevisions = new Set<number>();
  let changesetCount = 0;
  for (const change of changesets) {
    changesetCount++;
    if (
      change.origin_kind !== 'collector' ||
      change.status !== 'applied' ||
      change.principal_lineage !== expectedLineage ||
      change.origin_conversation_id !== null
    ) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history contains unsupported authority data.');
    }
    let request: ReturnType<typeof validateRequest> | { contractVersion: 1; requestId: string; undoOf: string };
    try {
      const parsed = parseObjectJson(change.request, 'Change request');
      request = change.undo_of === null
        ? validateRequest(parsed)
        : validateUndoRequest(db, parsed, change.id, change.request_id, change.undo_of, expectedLineage);
    } catch {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history request is invalid.');
    }
    if (request.requestId !== change.request_id) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history request identifiers do not match.');
    }
    const canonical = canonicalJson(request);
    const expectedHash = createHash('sha256').update(canonical).digest('hex');
    if (change.input_hash !== expectedHash) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history request checksums do not match.');
    }
    const result = parseObjectJson(change.result, 'Change receipt');
    if (result.requestId !== change.request_id) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change receipt identifiers do not match.');
    }
    const receiptRevision = result.catalogueRevision;
    if (typeof receiptRevision !== 'number' || !Number.isSafeInteger(receiptRevision) || receiptRevision < 1 || receiptRevision > catalogueRevision || receiptRevisions.has(receiptRevision)) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change receipt revisions are invalid.');
    }
    receiptRevisions.add(receiptRevision);
    const recordRefs = Array.isArray(result.recordRefs) ? result.recordRefs : null;
    if (!recordRefs?.length) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change receipt references are invalid.');
    for (const reference of recordRefs) validateReference(db, reference);
    if (result.affectedRecordRefs !== undefined) {
      if (!Array.isArray(result.affectedRecordRefs)) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change receipt references are invalid.');
      for (const reference of result.affectedRecordRefs) validateReference(db, reference);
    }
    const items = db.prepare(`SELECT sequence,entity_kind,entity_id,operation,before_json,after_json,
        before_revision,after_revision,dependencies_json FROM change_items WHERE changeset_id=? ORDER BY sequence`).all(change.id) as Array<Record<string, unknown>>;
    if (!items.length) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history is missing its change items.');
    items.forEach((item, index) => {
      if (asSafeInteger(item.sequence) !== index || typeof item.operation !== 'string' || !item.operation || !tableHasId(db, String(item.entity_kind), String(item.entity_id))) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history items are invalid.');
      }
      const beforeSnapshot = item.before_json === null ? null : parseObjectJson(item.before_json, 'Change snapshot');
      const afterSnapshot = item.after_json === null ? null : parseObjectJson(item.after_json, 'Change snapshot');
      if (item.before_revision !== null) asSafeInteger(item.before_revision, 1);
      if (item.after_revision !== null) asSafeInteger(item.after_revision, 1);
      if ((item.before_json === null) !== (item.before_revision === null) || (item.after_json === null) !== (item.after_revision === null)) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history revisions do not match their snapshots.');
      }
      if (beforeSnapshot) validateSnapshotReferences(db, String(item.entity_kind), String(item.entity_id), beforeSnapshot, asSafeInteger(item.before_revision, 1));
      if (afterSnapshot) validateSnapshotReferences(db, String(item.entity_kind), String(item.entity_id), afterSnapshot, asSafeInteger(item.after_revision, 1));
      let dependencies: unknown;
      try {
        dependencies = JSON.parse(String(item.dependencies_json));
      } catch {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history dependencies are invalid.');
      }
      if (!Array.isArray(dependencies)) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history dependencies are invalid.');
      for (const dependency of dependencies) {
        if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
          throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history dependencies are invalid.');
        }
        const value = dependency as Record<string, unknown>;
        if (typeof value.type !== 'string' || typeof value.id !== 'string' || !tableHasId(db, value.type, value.id)) {
          throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change history references an unavailable dependency.');
        }
      }
    });
  }
  if (changesetCount !== catalogueRevision || receiptRevisions.size !== catalogueRevision) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue revision does not match its retained change history.');
  }
  for (let revision = 1; revision <= catalogueRevision; revision++) {
    if (!receiptRevisions.has(revision)) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue change receipt revisions are incomplete.');
  }
  return changesetCount;
}

function computeTotals(db: Database.Database): CatalogueBackupTotals {
  const state = readState(db);
  const workCount = asSafeInteger((db.prepare('SELECT count(*) AS n FROM works WHERE deleted_at IS NULL').get() as Record<string, unknown>).n);
  const copyCount = asSafeInteger((db.prepare('SELECT count(*) AS n FROM owned_copies WHERE deleted_at IS NULL').get() as Record<string, unknown>).n);
  const ownedWorkCount = asSafeInteger((db.prepare(`SELECT count(DISTINCT ec.work_id) AS n FROM edition_contents ec
    JOIN editions e ON e.id=ec.edition_id JOIN owned_copies c ON c.edition_id=e.id
    WHERE e.deleted_at IS NULL AND c.deleted_at IS NULL`).get() as Record<string, unknown>).n);
  const rows = db.prepare(`SELECT a.currency_code,a.amount_minor FROM acquisitions a
    JOIN owned_copies c ON c.id=a.owned_copy_id WHERE c.deleted_at IS NULL AND a.amount_minor IS NOT NULL
    ORDER BY a.currency_code`).iterate() as Iterable<Record<string, unknown>>;
  const grouped = new Map<string, { amount: bigint; count: number; free: number }>();
  let pricedCopyCount = 0;
  for (const row of rows) {
    pricedCopyCount++;
    const currency = String(row.currency_code);
    const amount = asSafeMinorUnits(row.amount_minor);
    const total = grouped.get(currency) ?? { amount: 0n, count: 0, free: 0 };
    total.amount += amount;
    total.count++;
    if (amount === 0n) total.free++;
    grouped.set(currency, total);
  }
  const spendByCurrency = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, total]) => ({
    currency,
    amount: minorToDecimal(total.amount, currency)!,
    pricedCopyCount: total.count,
  }));
  return {
    catalogueRevision: state.catalogueRevision,
    workCount,
    ownedWorkCount,
    copyCount,
    pricedCopyCount,
    unpricedCopyCount: copyCount - pricedCopyCount,
    freeCopyCount: [...grouped.values()].reduce((sum, group) => sum + group.free, 0),
    spendByCurrency,
  };
}

function validateCurrencies(db: Database.Database): void {
  const expected = new Map(allCurrencies().map((currency) => [currency.code, currency.exponent]));
  const rows = db.prepare('SELECT code,exponent FROM currencies ORDER BY code').all() as Array<Record<string, unknown>>;
  if (rows.length !== expected.size) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue currency registry is incomplete.');
  for (const row of rows) {
    const code = String(row.code);
    const exponent = asSafeInteger(row.exponent);
    if (expected.get(code) !== exponent) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue currency registry is unsupported.');
  }
  const acquisitions = db.prepare('SELECT purchase_date,amount_minor,currency_code FROM acquisitions').iterate() as Iterable<Record<string, unknown>>;
  for (const acquisition of acquisitions) {
    if (acquisition.purchase_date !== null && (typeof acquisition.purchase_date !== 'string' || !isCalendarDate(acquisition.purchase_date))) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue contains an invalid purchase date.');
    }
    if (acquisition.amount_minor !== null) {
      asSafeMinorUnits(acquisition.amount_minor);
      if (!currencyFor(acquisition.currency_code)) {
        throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue contains an invalid purchase amount.');
      }
    }
  }
}

function validateDatabase(databasePath: string, expectedLineage: string, expectedTotals?: CatalogueBackupTotals): CatalogueBackupTotals {
  const preflightResult = preflight(databasePath);
  if (
    !preflightResult.exists ||
    preflightResult.version !== SCHEMA_VERSION ||
    preflightResult.applicationId !== APPLICATION_ID ||
    !['v2-canonical', 'v2-history-column-appended'].includes(String(preflightResult.variant))
  ) {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Backup schema is not supported by this application.');
  }
  let db: Database.Database;
  try { db = new Database(databasePath, { readonly: true, fileMustExist: true }); } catch {
    throw new CatalogueError('SCHEMA_MISMATCH', 'Backup database could not be opened for validation.');
  }
  try {
    db.defaultSafeIntegers(true);
    const integrity = db.pragma('integrity_check') as Array<Record<string, unknown>>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Backup database integrity check failed.');
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Backup database contains broken references.');
    }
    db.pragma('foreign_keys = ON');
    const state = readState(db);
    if (state.schemaVersion !== SCHEMA_VERSION) throw new CatalogueError('SCHEMA_MISMATCH', 'Backup schema markers do not match.');
    for (const table of Object.values(ENTITY_TABLES)) {
      const rows = db.prepare(`SELECT revision FROM ${table}`).iterate() as Iterable<Record<string, unknown>>;
      for (const row of rows) asSafeInteger(row.revision, 1);
    }
    validateCurrencies(db);
    validateActiveGraph(db);
    validateHistory(db, expectedLineage, state.catalogueRevision);
    const totals = computeTotals(db);
    if (expectedTotals && canonicalJson(totals) !== canonicalJson(expectedTotals)) {
      throw new CatalogueError('SCHEMA_MISMATCH', 'Backup catalogue totals do not match its manifest.');
    }
    return totals;
  } catch (error) {
    if (error instanceof CatalogueError) throw error;
    throw new CatalogueError('SCHEMA_MISMATCH', 'Backup database could not be validated.');
  } finally {
    db.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sanitizeSnapshot(filePath: string): void {
  const db = new Database(filePath);
  db.defaultSafeIntegers(true);
  try {
    const unsupported = db.prepare(`SELECT 1 FROM changesets
      WHERE origin_kind<>'collector' OR status<>'applied' LIMIT 1`).get();
    if (unsupported) throw new CatalogueError('SCHEMA_MISMATCH', 'Backup contains unsupported non-collector history.');
    const catalogueId = `cat_${randomUUID().replaceAll('-', '')}`;
    db.transaction(() => {
      db.prepare('UPDATE catalogue_state SET catalogue_id=? WHERE singleton_id=1').run(catalogueId);
      db.prepare(`UPDATE changesets SET principal_lineage=?,origin_conversation_id=NULL`).run(BACKUP_LINEAGE_PLACEHOLDER);
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  removeSqliteSidecars(filePath);
}

function removeSqliteSidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const filePath = `${databasePath}${suffix}`;
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('SCHEMA_MISMATCH', 'Catalogue snapshot contains unsupported sidecar files.');
    fs.rmSync(filePath, { force: true });
  }
}

function validateBundleManifest(value: unknown): CatalogueBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('RESTORE_INVALID', 'Backup manifest is invalid.');
  const manifest = value as Record<string, unknown>;
  const exactKeys = ['format', 'formatVersion', 'createdAt', 'applicationId', 'schemaVersion', 'snapshot', 'inclusions', 'totals'];
  if (Object.keys(manifest).sort().join('|') !== exactKeys.sort().join('|')) throw fail('RESTORE_INVALID', 'Backup manifest is invalid.');
  if (
    manifest.format !== FORMAT_NAME ||
    manifest.formatVersion !== FORMAT_VERSION ||
    manifest.applicationId !== APPLICATION_ID ||
    manifest.schemaVersion !== SCHEMA_VERSION ||
    typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) {
    throw fail('RESTORE_INVALID', 'Backup manifest version or metadata is unsupported.');
  }
  const snapshot = manifest.snapshot as Record<string, unknown> | null;
  const inclusions = manifest.inclusions as Record<string, unknown> | null;
  if (
    !snapshot ||
    Object.keys(snapshot).sort().join('|') !== 'file|sha256|sizeBytes' ||
    snapshot.file !== SNAPSHOT_NAME ||
    !Number.isSafeInteger(snapshot.sizeBytes) ||
    Number(snapshot.sizeBytes) < 1 ||
    typeof snapshot.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(snapshot.sha256) ||
    !inclusions ||
    Object.keys(inclusions).sort().join('|') !== 'catalogue|changeHistory|conversations|credentials|runtimeAuthority|sessions' ||
    inclusions.catalogue !== true ||
    inclusions.changeHistory !== true ||
    inclusions.conversations !== false ||
    inclusions.credentials !== false ||
    inclusions.sessions !== false ||
    inclusions.runtimeAuthority !== false
  ) {
    throw fail('RESTORE_INVALID', 'Backup manifest contents are unsupported.');
  }
  if (!manifest.totals || typeof manifest.totals !== 'object' || Array.isArray(manifest.totals)) {
    throw fail('RESTORE_INVALID', 'Backup totals are invalid.');
  }
  return manifest as unknown as CatalogueBackupManifest;
}

function assertRegularFile(filePath: string, description: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw fail('RESTORE_INVALID', `${description} is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('RESTORE_INVALID', `${description} is not a regular file.`);
  return stat;
}

async function readBackupBundle(directoryPath: string): Promise<{ manifest: CatalogueBackupManifest; snapshotPath: string }> {
  let resolved: string;
  try {
    const directory = fs.lstatSync(directoryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('not a directory');
    resolved = fs.realpathSync(directoryPath);
  } catch {
    throw fail('RESTORE_INVALID', 'Backup location is unavailable.');
  }
  let entries: string[];
  try { entries = fs.readdirSync(resolved).sort(); } catch {
    throw fail('RESTORE_INVALID', 'Backup contents are unavailable.');
  }
  if (entries.join('|') !== [MANIFEST_NAME, SNAPSHOT_NAME].sort().join('|')) {
    throw fail('RESTORE_INVALID', 'Backup contains unexpected files.');
  }
  const manifestPath = path.join(resolved, MANIFEST_NAME);
  const manifestStat = assertRegularFile(manifestPath, 'Backup manifest');
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw fail('RESTORE_INVALID', 'Backup manifest is too large.');
  const snapshotPath = path.join(resolved, SNAPSHOT_NAME);
  const snapshotStat = assertRegularFile(snapshotPath, 'Backup snapshot');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw fail('RESTORE_INVALID', 'Backup manifest is not valid JSON.');
  }
  const manifest = validateBundleManifest(raw);
  if (snapshotStat.size !== manifest.snapshot.sizeBytes) throw fail('RESTORE_INVALID', 'Backup snapshot size does not match its manifest.');
  let checksum: string;
  try { checksum = await sha256File(snapshotPath); } catch {
    throw fail('RESTORE_INVALID', 'Backup snapshot could not be read.');
  }
  if (checksum !== manifest.snapshot.sha256) throw fail('RESTORE_INVALID', 'Backup snapshot checksum does not match its manifest.');
  return { manifest, snapshotPath };
}

export async function previewCatalogueBackup(directoryPath: string): Promise<CatalogueRecoverySummary> {
  const { manifest, snapshotPath } = await readBackupBundle(directoryPath);
  const totals = validateDatabase(snapshotPath, BACKUP_LINEAGE_PLACEHOLDER, manifest.totals);
  return {
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    schemaVersion: manifest.schemaVersion,
    totals,
    changeHistoryIncluded: true,
    conversationsIncluded: false,
  };
}

export async function createCatalogueBackup(
  source: Database.Database,
  databasePath: string,
  destinationDirectory: string,
): Promise<CatalogueBackupManifest> {
  if (!source.open || typeof destinationDirectory !== 'string' || !destinationDirectory.trim()) {
    throw fail('BACKUP_FAILED', 'Backup could not be created.', true);
  }
  let destination = path.resolve(destinationDirectory);
  if (destination === path.resolve(databasePath)) throw fail('BACKUP_FAILED', 'Backup destination is not available.');
  let parent = path.dirname(destination);
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    parent = fs.realpathSync(parent);
    destination = path.join(parent, path.basename(destination));
  } catch {
    throw fail('BACKUP_FAILED', 'Backup destination is not available.', true);
  }
  if (fs.existsSync(destination)) throw fail('BACKUP_FAILED', 'Backup destination already exists.');
  const staging = path.join(parent, `.${path.basename(destination)}.creating-${randomUUID()}`);
  const snapshotPath = path.join(staging, SNAPSHOT_NAME);
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    await source.backup(snapshotPath);
    try { fs.chmodSync(snapshotPath, 0o600); } catch { /* platform ACL inheritance */ }
    sanitizeSnapshot(snapshotPath);
    const totals = validateDatabase(snapshotPath, BACKUP_LINEAGE_PLACEHOLDER);
    const stat = assertRegularFile(snapshotPath, 'Backup snapshot');
    const manifest: CatalogueBackupManifest = {
      format: FORMAT_NAME,
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      applicationId: APPLICATION_ID,
      schemaVersion: SCHEMA_VERSION,
      snapshot: { file: SNAPSHOT_NAME, sizeBytes: stat.size, sha256: await sha256File(snapshotPath) },
      inclusions: { catalogue: true, changeHistory: true, conversations: false, credentials: false, sessions: false, runtimeAuthority: false },
      totals,
    };
    fs.writeFileSync(path.join(staging, MANIFEST_NAME), JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(staging, 0o700); } catch { /* platform ACL inheritance */ }
    if (fs.existsSync(destination)) throw fail('BACKUP_FAILED', 'Backup destination already exists.');
    fs.renameSync(staging, destination);
    return manifest;
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* leave incomplete bundle untrusted */ }
    if (error instanceof CatalogueError) throw error;
    throw fail('BACKUP_FAILED', 'Backup could not be created.', true);
  }
}

function safeSibling(databasePath: string, filename: unknown, kind: 'stage' | 'previous'): string {
  if (typeof filename !== 'string') throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
  const base = path.basename(databasePath);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expected = new RegExp(`^${escaped}\\.restore-${kind}-[0-9a-f-]{36}\\.sqlite3$`);
  if (!expected.test(filename)) throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
  return path.join(path.dirname(databasePath), filename);
}

function readRestoreMarker(databasePath: string): { markerPath: string; marker: RestoreMarker } | undefined {
  const markerPath = `${databasePath}.restore-marker.json`;
  let stat: fs.Stats;
  try { stat = fs.lstatSync(markerPath); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
  if (stat.size > 4096) throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
  let marker: unknown;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
  const value = marker as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('|') !== 'previous|staged|target|version' ||
    value.version !== 1 ||
    value.target !== path.basename(databasePath)
  ) {
    throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
  }
  safeSibling(databasePath, value.staged, 'stage');
  safeSibling(databasePath, value.previous, 'previous');
  return { markerPath, marker: value as unknown as RestoreMarker };
}

function removeDatabaseAndSidecars(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const filename = `${databasePath}${suffix}`;
    try {
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw fail('RECOVERY_FAILED', 'Interrupted recovery files are invalid.');
      }
      fs.rmSync(filename, { force: true });
    } catch (error) {
      if (error instanceof CatalogueError) throw error;
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw fail('RECOVERY_FAILED', 'Interrupted recovery files are invalid.');
      }
    }
  }
}

function cleanupOrphanRecoveryFiles(databasePath: string): void {
  const directory = path.dirname(databasePath);
  if (!fs.existsSync(directory)) return;
  const base = path.basename(databasePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const generated = new RegExp(`^${base}\\.restore-(?:stage|previous)-[0-9a-f-]{36}\\.sqlite3$`);
  const markerWrite = new RegExp(`^${base}\\.restore-marker\\.json\\.[0-9a-f-]{36}\\.writing$`);
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    if (generated.test(name)) {
      removeDatabaseAndSidecars(filename);
    } else if (markerWrite.test(name)) {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(filename); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('RECOVERY_FAILED', 'Interrupted recovery marker is invalid.');
      fs.rmSync(filename, { force: true });
    }
  }
}

export function recoverInterruptedRestore(databasePath: string): void {
  const found = readRestoreMarker(databasePath);
  if (!found) {
    cleanupOrphanRecoveryFiles(databasePath);
    return;
  }
  const stagedPath = safeSibling(databasePath, found.marker.staged, 'stage');
  const previousPath = safeSibling(databasePath, found.marker.previous, 'previous');
  const hasEntry = (filename: string) => {
    try { fs.lstatSync(filename); return true; } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw fail('RECOVERY_FAILED', 'Interrupted recovery files are unavailable.');
    }
  };
  const previousExists = hasEntry(previousPath);
  const targetExists = hasEntry(databasePath);
  if (!previousExists && !targetExists) {
    throw fail('RECOVERY_FAILED', 'Interrupted restore left no recoverable catalogue.');
  }
  try {
    if (previousExists) {
      const previousStat = fs.lstatSync(previousPath);
      if (!previousStat.isFile() || previousStat.isSymbolicLink()) throw fail('RECOVERY_FAILED', 'Interrupted recovery files are invalid.');
      if (targetExists) removeDatabaseAndSidecars(databasePath);
      fs.renameSync(previousPath, databasePath);
    } else if (targetExists) {
      const targetStat = fs.lstatSync(databasePath);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw fail('RECOVERY_FAILED', 'Interrupted recovery files are invalid.');
    }
    removeDatabaseAndSidecars(stagedPath);
    fs.rmSync(found.markerPath, { force: true });
    cleanupOrphanRecoveryFiles(databasePath);
  } catch {
    throw fail('RECOVERY_FAILED', 'Interrupted restore could not recover the preserved catalogue.', true);
  }
}

function writeRestoreMarker(databasePath: string, marker: RestoreMarker): void {
  const markerPath = `${databasePath}.restore-marker.json`;
  try { fs.lstatSync(markerPath); throw fail('RESTORE_FAILED', 'Another catalogue recovery is pending.', true); } catch (error) {
    if (error instanceof CatalogueError) throw error;
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw fail('RESTORE_FAILED', 'Another catalogue recovery is pending.', true);
    }
  }
  const writingPath = `${markerPath}.${randomUUID()}.writing`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(writingPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(marker), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(writingPath, markerPath);
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(writingPath, { force: true }); } catch { /* incomplete marker is never trusted */ }
    throw fail('RESTORE_FAILED', 'Restore could not prepare its recovery marker.', true);
  }
}

function rebindRestoredSnapshot(filePath: string): string {
  const db = new Database(filePath);
  db.defaultSafeIntegers(true);
  try {
    const unsupported = db.prepare(`SELECT 1 FROM changesets
      WHERE origin_kind<>'collector' OR status<>'applied' OR principal_lineage<>? OR origin_conversation_id IS NOT NULL LIMIT 1`).get(BACKUP_LINEAGE_PLACEHOLDER);
    if (unsupported) throw fail('RESTORE_INVALID', 'Backup contains unsupported authority data.');
    const catalogueId = `cat_${randomUUID().replaceAll('-', '')}`;
    const lineage = currentLineage(catalogueId);
    db.transaction(() => {
      db.prepare('UPDATE catalogue_state SET catalogue_id=? WHERE singleton_id=1').run(catalogueId);
      db.prepare('UPDATE changesets SET principal_lineage=?').run(lineage);
    })();
    return lineage;
  } finally {
    db.close();
  }
}

export async function restoreCatalogueBackup(options: {
  database: Database.Database;
  databasePath: string;
  sourceDirectory: string;
  closeCurrent: () => void;
  reopenCurrent: () => Promise<Database.Database>;
  setCurrent: (database: Database.Database) => void;
  testOptions?: RestoreTestOptions;
}): Promise<CatalogueRestoreResult> {
  if (!options.database.open) throw fail('RESTORE_FAILED', 'Catalogue is unavailable for restore.', true);
  const { manifest, snapshotPath } = await readBackupBundle(options.sourceDirectory);
  validateDatabase(snapshotPath, BACKUP_LINEAGE_PLACEHOLDER, manifest.totals);
  const databasePath = path.resolve(options.databasePath);
  const parent = path.dirname(databasePath);
  const id = randomUUID();
  const stageName = `${path.basename(databasePath)}.restore-stage-${id}.sqlite3`;
  const previousName = `${path.basename(databasePath)}.restore-previous-${id}.sqlite3`;
  const stagedPath = path.join(parent, stageName);
  const previousPath = path.join(parent, previousName);
  const marker: RestoreMarker = { version: 1, target: path.basename(databasePath), staged: stageName, previous: previousName };
  const currentBackupDirectory = `${databasePath}.pre-restore-${id}.backup`;
  let markerWritten = false;
  let currentDatabase = options.database;
  let stagedDb: Database.Database | undefined;
  try {
    const backupSource = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      await backupSource.backup(stagedPath);
    } finally {
      backupSource.close();
    }
    removeSqliteSidecars(stagedPath);
    try { fs.chmodSync(stagedPath, 0o600); } catch { /* platform ACL inheritance */ }
    const lineage = rebindRestoredSnapshot(stagedPath);
    validateDatabase(stagedPath, lineage, manifest.totals);
    await createCatalogueBackup(currentDatabase, databasePath, currentBackupDirectory);
    const checkpoint = currentDatabase.pragma('wal_checkpoint(TRUNCATE)') as Array<Record<string, unknown>>;
    if (checkpoint.some((row) => Number(row.busy) !== 0)) throw fail('RESTORE_FAILED', 'Catalogue is busy; restore was not started.', true);
    options.closeCurrent();
    writeRestoreMarker(databasePath, marker);
    markerWritten = true;
    if (options.testOptions?.injectFailureAt === 'after-marker') {
      throw fail('RESTORE_INTERRUPTED', 'Restore was interrupted; the original catalogue will be recovered on next open.', true);
    }
    fs.renameSync(databasePath, previousPath);
    if (options.testOptions?.injectFailureAt === 'after-preserve') {
      throw fail('RESTORE_INTERRUPTED', 'Restore was interrupted; the original catalogue will be recovered on next open.', true);
    }
    fs.renameSync(stagedPath, databasePath);
    if (options.testOptions?.injectFailureAt === 'after-install') {
      throw fail('RESTORE_INTERRUPTED', 'Restore was interrupted; the original catalogue will be recovered on next open.', true);
    }
    stagedDb = await options.reopenCurrent();
    currentDatabase = stagedDb;
    options.setCurrent(stagedDb);
    const restoredState = readState(stagedDb);
    validateDatabase(databasePath, currentLineage(restoredState.catalogueId), manifest.totals);
    fs.rmSync(`${databasePath}.restore-marker.json`, { force: true });
    markerWritten = false;
    try { removeDatabaseAndSidecars(previousPath); } catch { /* the committed restore remains valid; startup removes orphaned files */ }
    return { currentBackupDirectory, manifest };
  } catch (error) {
    if (error instanceof CatalogueError && error.code === 'RESTORE_INTERRUPTED') {
      throw error;
    }
    if (stagedDb?.open) stagedDb.close();
    if (markerWritten) {
      try {
        recoverInterruptedRestore(databasePath);
        const recovered = await options.reopenCurrent();
        currentDatabase = recovered;
        options.setCurrent(recovered);
      } catch {
        throw fail('RECOVERY_FAILED', 'Restore failed and the preserved catalogue could not be reopened.', true);
      }
    } else {
      try { removeDatabaseAndSidecars(stagedPath); } catch { /* retain unexpected files for diagnosis */ }
      if (!currentDatabase.open) {
        try {
          const reopened = await options.reopenCurrent();
          currentDatabase = reopened;
          options.setCurrent(reopened);
        } catch {
          throw fail('RESTORE_FAILED', 'Restore failed and the current catalogue could not be reopened.', true);
        }
      }
    }
    if (error instanceof CatalogueError) throw error;
    throw fail('RESTORE_FAILED', 'Restore failed; the existing catalogue was recovered.', true);
  } finally {
    if (stagedDb?.open && stagedDb !== currentDatabase) stagedDb.close();
  }
}

export function validateBackupFile(databasePath: string, expectedLineage: string): CatalogueBackupTotals {
  return validateDatabase(databasePath, expectedLineage);
}
