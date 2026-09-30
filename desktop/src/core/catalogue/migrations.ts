import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import initialSchema from './migrations/001-initial.sql?raw';
import { allCurrencies, CURRENCY_REGISTRY_VERSION } from './currency-registry';
import { CatalogueError } from './contracts';

export const SCHEMA_VERSION = 2;
export const APPLICATION_ID = 0x41524348; // ARCH
const TABLES = ['works','editions','edition_contents','content_seasons','formats','edition_formats','owned_copies','acquisitions','currencies','catalogue_state','changesets','change_items'];
type SchemaVariant = 'v1-canonical'|'v1-history-column-missing'|'v2-canonical'|'v2-history-column-appended';
export interface Preflight { exists: boolean; version: number; applicationId: number; tables: string[]; variant?:SchemaVariant; }

// One historical v1 build was emitted before the nullable provenance column was
// added to the accepted v1 baseline. Recognize only that precise SQL variant.
const OLD_CHANGESETS = '  origin_conversation_id TEXT, undo_of TEXT REFERENCES changesets(id) ON DELETE RESTRICT, origin_kind TEXT NOT NULL';
const LEGACY_V1_SCHEMA = initialSchema.replace(OLD_CHANGESETS,'  undo_of TEXT REFERENCES changesets(id) ON DELETE RESTRICT, origin_kind TEXT NOT NULL');
if(LEGACY_V1_SCHEMA===initialSchema)throw new Error('The known historical v1 schema variant is not represented by the shipped baseline.');

function schemaFingerprint(db:Database.Database){
  const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{type:string;name:string;tbl_name:string;sql:string|null}>;
  const columns=TABLES.map(table=>[table,db.prepare(`PRAGMA table_info("${table}")`).all().map((x:any)=>[Number(x.cid),x.name,x.type,Number(x.notnull),x.dflt_value,Number(x.pk)])]);
  return createHash('sha256').update(JSON.stringify({objects:objects.map(x=>[x.type,x.name,x.tbl_name,x.sql?.replace(/\s+/g,' ').trim()??null]),columns})).digest('hex');
}
function fingerprints(){
  const canonical=new Database(':memory:'),legacy=new Database(':memory:');
  try{
    canonical.exec(initialSchema);legacy.exec(LEGACY_V1_SCHEMA);
    const canonicalV1=schemaFingerprint(canonical),legacyV1=schemaFingerprint(legacy);
    legacy.exec('ALTER TABLE changesets ADD COLUMN origin_conversation_id TEXT');
    return {canonicalV1,legacyV1,canonicalV2:canonicalV1,legacyV2:schemaFingerprint(legacy)};
  }finally{canonical.close();legacy.close();}
}
let knownFingerprints:ReturnType<typeof fingerprints>|undefined;
function schemaFingerprints(){return knownFingerprints??=fingerprints();}

export function preflight(databasePath: string): Preflight {
  if (!fs.existsSync(databasePath)) return { exists: false, version: 0, applicationId: 0, tables: [] };
  let db: Database.Database;
  try { db = new Database(databasePath, { readonly: true, fileMustExist: true }); }
  catch { throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue database could not be opened for read-only preflight.'); }
  try {
    const applicationId = Number(db.pragma('application_id', { simple: true }));
    const version = Number(db.pragma('user_version', { simple: true }));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>).map((x) => x.name);
    if(!Number.isSafeInteger(applicationId)||applicationId<0||!Number.isSafeInteger(version)||version<0)throw new CatalogueError('SCHEMA_MISMATCH','Catalogue schema markers are invalid.');
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) throw new CatalogueError('SCHEMA_MISMATCH', 'File is not an Archivist catalogue.');
    if (version > SCHEMA_VERSION) throw new CatalogueError('SCHEMA_NEWER', 'Catalogue schema is newer than this application supports.');
    if(version===0&&(tables.length!==0||applicationId!==0))throw new CatalogueError('SCHEMA_MISMATCH','Catalogue schema markers or table set do not match.');
    if(version>0){
      if(applicationId!==APPLICATION_ID||tables.join('|')!==[...TABLES].sort().join('|'))throw new CatalogueError('SCHEMA_MISMATCH','Catalogue schema markers or table set do not match.');
      const states=db.prepare('SELECT schema_version FROM catalogue_state WHERE singleton_id=1').all() as Array<{schema_version:number}>;
      if(states.length!==1||Number(states[0].schema_version)!==version)throw new CatalogueError('SCHEMA_MISMATCH','Catalogue schema markers do not match.');
      const actual=schemaFingerprint(db),known=schemaFingerprints();
      let variant:SchemaVariant|undefined;
      if(version===1){if(actual===known.canonicalV1)variant='v1-canonical';else if(actual===known.legacyV1)variant='v1-history-column-missing';}
      if(version===2){if(actual===known.canonicalV2)variant='v2-canonical';else if(actual===known.legacyV2)variant='v2-history-column-appended';}
      if(!variant)throw new CatalogueError('SCHEMA_MISMATCH','Catalogue database structure does not match a supported schema.');
      return {exists:true,version,applicationId,tables,variant};
    }
    return { exists: true, version, applicationId, tables };
  } catch(error) {
    if(error instanceof CatalogueError)throw error;
    throw new CatalogueError('SCHEMA_MISMATCH','Catalogue database failed read-only preflight.');
  } finally { db.close(); }
}

async function createConsistentBackup(databasePath:string,requestedPath?:string){
  const backupPath=requestedPath??`${databasePath}.pre-v2-${Date.now()}-${randomUUID()}.bak`;
  if(path.resolve(backupPath)===path.resolve(databasePath)||fs.existsSync(backupPath))throw new CatalogueError('BACKUP_FAILED','Catalogue backup could not be created; migration was not started.',true);
  let source:Database.Database|undefined;
  try{
    fs.mkdirSync(path.dirname(backupPath),{recursive:true,mode:0o700});
    source=new Database(databasePath,{readonly:true,fileMustExist:true});
    await source.backup(backupPath);
    try{fs.chmodSync(backupPath,0o600);}catch{/* platform ACL inheritance */}
  }catch{try{fs.rmSync(backupPath,{force:true});}catch{/* leave source untouched */}throw new CatalogueError('BACKUP_FAILED','Catalogue backup could not be created; migration was not started.',true);}
  finally{source?.close();}
  return backupPath;
}

export async function initialize(databasePath: string, options: { backupPath?: string; injectMigrationFailure?: boolean; afterBackupForTest?:()=>void } = {}): Promise<Database.Database> {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(databasePath), 0o700); } catch { /* platform ACL inheritance */ }
  const check = preflight(databasePath);
  if(check.exists&&check.version===2){
    const db=new Database(databasePath);db.defaultSafeIntegers(true);db.pragma('foreign_keys = ON');db.pragma('journal_mode = WAL');assertState(db);return db;
  }
  if(check.exists&&check.version===1){
    await createConsistentBackup(databasePath,options.backupPath);
    const db=new Database(databasePath);db.defaultSafeIntegers(true);db.pragma('foreign_keys = ON');
    try{
      options.afterBackupForTest?.();
      db.transaction(()=>{
        const writerAppId=Number(db.pragma('application_id',{simple:true})),writerVersion=Number(db.pragma('user_version',{simple:true}));
        const writerTables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>).map(x=>x.name);
        const writerState=db.prepare('SELECT schema_version FROM catalogue_state WHERE singleton_id=1').get() as {schema_version:number|bigint}|undefined;
        const writerFingerprint=schemaFingerprint(db);
        const expectedFingerprint=check.variant==='v1-canonical'?schemaFingerprints().canonicalV1:check.variant==='v1-history-column-missing'?schemaFingerprints().legacyV1:undefined;
        if(writerAppId!==APPLICATION_ID||writerVersion!==1||Number(writerState?.schema_version)!==1||writerTables.join('|')!==[...TABLES].sort().join('|')||!expectedFingerprint||writerFingerprint!==expectedFingerprint)throw new CatalogueError('SCHEMA_MISMATCH','Catalogue changed after read-only preflight; upgrade was not started.');
        if(check.variant==='v1-history-column-missing')db.exec('ALTER TABLE changesets ADD COLUMN origin_conversation_id TEXT');
        else if(check.variant!=='v1-canonical')throw new CatalogueError('SCHEMA_MISMATCH','Catalogue schema changed after read-only preflight.');
        db.prepare('UPDATE catalogue_state SET schema_version=? WHERE singleton_id=1').run(SCHEMA_VERSION);
        db.pragma('user_version = '+SCHEMA_VERSION);
        if(options.injectMigrationFailure)throw new Error('Injected migration failure.');
      })();
    }catch(error){db.close();if(error instanceof CatalogueError)throw error;throw new CatalogueError('MIGRATION_FAILED','Catalogue upgrade failed before commit; the original catalogue is unchanged and its backup is retained.',true);}
    try{db.pragma('journal_mode = WAL');assertState(db);return db;}
    catch{db.close();throw new CatalogueError('MIGRATION_FINALIZE_FAILED','Catalogue schema upgrade committed; the retained backup is available if the upgraded store cannot be reopened.',true);}
  }
  if (check.exists && check.tables.length) throw new CatalogueError('SCHEMA_MISMATCH', 'Existing catalogue version is not a supported migration source.');
  const db = new Database(databasePath);
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  try {
    db.transaction(() => {
      db.pragma('application_id = ' + APPLICATION_ID);
      db.exec(initialSchema);
      db.prepare('INSERT INTO catalogue_state(singleton_id,catalogue_id,schema_version,catalogue_revision) VALUES(1,?, ?, 0)')
        .run(`cat_${globalThis.crypto.randomUUID()}`, SCHEMA_VERSION);
      const insert = db.prepare('INSERT INTO currencies(code,exponent,registry_version) VALUES(?,?,?)');
      for (const currency of allCurrencies()) insert.run(currency.code, currency.exponent, CURRENCY_REGISTRY_VERSION);
      if (options.injectMigrationFailure) throw new Error('Injected migration failure.');
      db.pragma('user_version = ' + SCHEMA_VERSION);
    })();
    db.pragma('journal_mode = WAL');
    assertState(db);
    return db;
  } catch (error) { db.close(); throw error; }
}
function assertState(db: Database.Database) {
  db.pragma('foreign_keys = ON');
  const state = db.prepare('SELECT schema_version FROM catalogue_state WHERE singleton_id=1').get() as { schema_version: number | bigint } | undefined;
  if (!state || Number(state.schema_version) !== SCHEMA_VERSION || Number(db.pragma('user_version', { simple: true })) !== SCHEMA_VERSION || Number(db.pragma('application_id', { simple: true })) !== APPLICATION_ID) throw new CatalogueError('SCHEMA_MISMATCH', 'Catalogue schema markers do not match.');
}
