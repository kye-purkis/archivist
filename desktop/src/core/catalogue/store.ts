import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { decimalToMinor, minorToDecimal } from './money';
import { isCalendarDate } from './calendar-date';
import { canonicalJson, validateRequest } from './validation';
import { CatalogueError, type AppliedReceipt, type CatalogueDetail, type CatalogueSearchRequest, type CatalogueSearchResult, type CatalogueSummary, type EditionProjection, type Operation, type StoreOptions, type TrustedCaller, type Category, type CopyPageRequest, type PickerRequest, type FormatLookupRequest, type ChangeHistoryDetail, type ChangeHistoryProjection } from './contracts';
import { initialize } from './migrations';
import { allCurrencies } from './currency-registry';
import { createCatalogueBackup, previewCatalogueBackup, recoverInterruptedRestore, restoreCatalogueBackup, type CatalogueRecoverySummary, type RestoreTestOptions } from './recovery';
import { validateActiveGraph } from './integrity';

const TABLE_BY_KIND = { work:'works', edition:'editions', owned_copy:'owned_copies', format:'formats' } as const;
const BUILTINS:Record<Category,Array<{code:string;label:string}>>={film:[{code:'dvd',label:'DVD'},{code:'bluray',label:'Blu-ray'},{code:'uhd',label:'4K UHD'},{code:'vhs',label:'VHS'}],tv:[{code:'dvd',label:'DVD'},{code:'bluray',label:'Blu-ray'},{code:'uhd',label:'4K UHD'},{code:'vhs',label:'VHS'}],music:[{code:'cd',label:'CD'},{code:'vinyl',label:'Vinyl'},{code:'cassette',label:'Cassette'}],game:[{code:'disc',label:'Disc'},{code:'cartridge',label:'Cartridge'}]};
type EntityKind = keyof typeof TABLE_BY_KIND;
type Row = Record<string, unknown>;
type Item = {kind:EntityKind;id:string;operation:string;before:unknown|null;after:unknown|null;beforeRevision:number|null;afterRevision:number|null;dependencies:unknown[]};
export class CatalogueStore {
  private constructor(private db: Database.Database, private options: StoreOptions) {}
  private maintenance = false;
  static async open(options: StoreOptions): Promise<CatalogueStore> {
    recoverInterruptedRestore(options.databasePath);
    return new CatalogueStore(await initialize(options.databasePath, { backupPath: options.backupPath, injectMigrationFailure: options.injectMigrationFailure }), options);
  }
  close() { if (this.db.open) this.db.close(); }
  private assertAvailable() {
    if (this.maintenance || !this.db.open) throw new CatalogueError('APP_UNAVAILABLE', 'Catalogue recovery is in progress or unavailable.', true);
  }
  get catalogueId(): string { this.assertAvailable(); return String((this.db.prepare('SELECT catalogue_id FROM catalogue_state WHERE singleton_id=1').get() as Row).catalogue_id); }
  get revision(): number { this.assertAvailable(); return asNumber((this.db.prepare('SELECT catalogue_revision FROM catalogue_state WHERE singleton_id=1').get() as Row).catalogue_revision); }
  createBackup(destinationDirectory: string) {
    this.assertAvailable();
    return createCatalogueBackup(this.db, this.options.databasePath, destinationDirectory);
  }
  previewBackup(sourceDirectory: string): Promise<CatalogueRecoverySummary> {
    this.assertAvailable();
    return previewCatalogueBackup(sourceDirectory);
  }
  async restoreBackup(sourceDirectory: string, testOptions?: RestoreTestOptions) {
    this.assertAvailable();
    this.maintenance = true;
    try {
      return await restoreCatalogueBackup({
        database: this.db,
        databasePath: this.options.databasePath,
        sourceDirectory,
        closeCurrent: () => this.db.close(),
        reopenCurrent: async () => initialize(this.options.databasePath, {
          backupPath: this.options.backupPath,
          injectMigrationFailure: this.options.injectMigrationFailure,
        }),
        setCurrent: (database) => { this.db = database; },
        ...(testOptions ? { testOptions } : {}),
      });
    } finally {
      if (this.db.open) this.maintenance = false;
    }
  }

  apply(trusted: TrustedCaller, rawRequest: unknown): AppliedReceipt {
    this.assertAvailable();
    const request = validateRequest(rawRequest);
    assertCaller(trusted);
    const canonical = canonicalJson(request); const hash = createHash('sha256').update(canonical).digest('hex');
    const run = this.db.transaction(() => {
      const prior = this.db.prepare('SELECT id,input_hash,principal_lineage,result FROM changesets WHERE request_id=?').get(request.requestId) as Row | undefined;
      if (prior) {
        if (prior.principal_lineage !== trusted.lineage || prior.input_hash !== hash) throw new CatalogueError('IDEMPOTENCY_CONFLICT', 'Request ID cannot be reused.');
        const receipt = JSON.parse(String(prior.result)) as AppliedReceipt;
        return { ...receipt, replayed: true };
      }
      // Trusted collector authority is read again at the start of every synchronous write transaction.
      assertCaller(trusted);
      this.checkExpectedReleaseRevisions(request.operations);
      const refs = new Map<string,string>();
      for (const op of request.operations) if ('ref' in op) refs.set(op.ref, this.newId(prefixFor(op)));
      const operations = request.operations.map((op) => resolveOperation(op, refs));
      const items: Item[] = [];
      for (let i=0;i<operations.length;i++) {
        const item = this.applyOperation(operations[i], i, operations, refs);
        if (item) items.push(item);
        if (this.options.injectFailureAfterWrite === i + 1) throw new Error('Injected write failure.');
      }
      this.validateFinalGraph();
      for(const item of items)item.dependencies=[...this.dependencies(item.kind,item.id)];
      const nextRevision = this.revision + 1;
      const now = this.now();
      const changesetId = this.newId('chg');
      const referenced = new Map<string,{type:EntityKind;id:string;revision:number}>();
      for (const item of items) {
        const revision = item.afterRevision ?? this.readRevision(item.kind,item.id);
        referenced.set(`${item.kind}:${item.id}`, { type:item.kind,id:item.id,revision });
      }
      const affected=new Map<string,{type:EntityKind;id:string;revision:number}>();
      for(const item of items)if(item.operation==='update'||item.operation==='undo'){
        if(item.kind==='edition')for(const dep of item.dependencies as Array<{type:string;id:string}>){if(dep.type==='owned_copy')affected.set(dep.id,{type:'owned_copy',id:dep.id,revision:this.readRevision('owned_copy',dep.id)});}
        if(item.kind==='format')for(const dep of item.dependencies as Array<{type:string;id:string}>){if(dep.type==='edition')for(const copy of this.activeCopiesOfEdition(String(dep.id))){const copyId=String(copy.id);affected.set(copyId,{type:'owned_copy',id:copyId,revision:asNumber(copy.revision)});}}
      }
      const receipt: AppliedReceipt = { contractVersion:1, changesetId, requestId:request.requestId, catalogueRevision:nextRevision, recordRefs:[...referenced.values()], ...(affected.size?{affectedRecordRefs:[...affected.values()]}:{}), replayed:false };
      this.db.prepare('UPDATE catalogue_state SET catalogue_revision=? WHERE singleton_id=1').run(nextRevision);
      this.db.prepare(`INSERT INTO changesets(id,request_id,input_hash,principal_lineage,origin_conversation_id,origin_kind,status,request,result,created_at,applied_at) VALUES(?,?,?,?,NULL,'collector','applied',?,?,?,?)`)
        .run(changesetId,request.requestId,hash,trusted.lineage,canonical,JSON.stringify(receipt),now,now);
      const insertItem = this.db.prepare(`INSERT INTO change_items(changeset_id,sequence,entity_kind,entity_id,operation,before_json,after_json,before_revision,after_revision,dependencies_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      items.forEach((item,i)=>insertItem.run(changesetId,i,item.kind,item.id,item.operation,item.before===null?null:JSON.stringify(item.before),item.after===null?null:JSON.stringify(item.after),item.beforeRevision,item.afterRevision,JSON.stringify(item.dependencies)));
      return receipt;
    });
    try { return run(); } catch (error) { throw transactionError(error); }
  }

  undo(trusted: TrustedCaller, changesetId: string, requestId: string): AppliedReceipt {
    this.assertAvailable();
    assertCaller(trusted);
    if (!changesetId || !requestId || requestId.length > 160) throw new CatalogueError('VALIDATION_FAILED','Undo request is invalid.');
    const undoRequest={contractVersion:1,requestId,undoOf:changesetId};
    const canonical=canonicalJson(undoRequest);const hash=createHash('sha256').update(canonical).digest('hex');
    try{return this.db.transaction(()=>{
      const replay=this.db.prepare('SELECT id,input_hash,principal_lineage,result FROM changesets WHERE request_id=?').get(requestId) as Row|undefined;
      if(replay){if(replay.input_hash!==hash||replay.principal_lineage!==trusted.lineage)throw new CatalogueError('IDEMPOTENCY_CONFLICT','Request ID cannot be reused.');return {...JSON.parse(String(replay.result)) as AppliedReceipt,replayed:true};}
      assertCaller(trusted);
      const original=this.db.prepare('SELECT * FROM changesets WHERE id=?').get(changesetId) as Row|undefined;
      if(!original||original.principal_lineage!==trusted.lineage||original.status!=='applied')throw new CatalogueError('NOT_FOUND','Change is unavailable.');
      const rows=this.db.prepare('SELECT * FROM change_items WHERE changeset_id=? ORDER BY sequence DESC').all(changesetId) as Row[];
      if(!rows.length)throw new CatalogueError('CONFLICT','Change cannot be undone.');
      for(const row of rows){
        const expected=JSON.parse(String(row.dependencies_json??'[]'));
        if(canonicalJson(this.dependencies(row.entity_kind as EntityKind,String(row.entity_id)))!==canonicalJson(expected))throw new CatalogueError('CONFLICT','A later record or dependency prevents undo.',true);
      }
      const items:Item[]=[];
      const grouped=new Map<string,{kind:EntityKind;id:string;expectedAfter:unknown;expectedRevision:number;before:unknown}>();
      for(const row of rows){
        const kind=row.entity_kind as EntityKind;const id=String(row.entity_id);const key=`${kind}:${id}`;
        const group=grouped.get(key);
        if(!group)grouped.set(key,{kind,id,expectedAfter:JSON.parse(String(row.after_json)),expectedRevision:asNumber(row.after_revision),before:JSON.parse(String(row.before_json??'null'))});
        else group.before=JSON.parse(String(row.before_json??'null')); // rows are descending, so the last value is the pre-batch snapshot
      }
      for(const group of grouped.values()){
        const {kind,id,expectedAfter,expectedRevision}=group;const current=this.snapshot(kind,id);const rev=this.readRevision(kind,id);
        if(!current||rev!==expectedRevision)throw conflict(kind,id,rev);
        if(canonicalJson(current)!==canonicalJson(expectedAfter))throw new CatalogueError('CONFLICT','A changed record or dependency prevents undo.',true);
        const before=group.before;
        this.restoreSnapshot(kind,id,before);
        const after=this.snapshot(kind,id);
        items.push({kind,id,operation:'undo',before:current,after,beforeRevision:rev,afterRevision:this.readRevision(kind,id),dependencies:[...this.dependencies(kind,id)]});
      }
      try{this.validateFinalGraph();}catch(error){if(error instanceof CatalogueError&&error.code==='VALIDATION_FAILED')throw new CatalogueError('CONFLICT','A later record or dependency prevents undo.',true);throw error;}
      // Capture the dependency graph after every inverse has been applied. A
      // record restored earlier in the loop may still depend on a record that
      // a later inverse in this same group tombstones.
      for(const item of items)item.dependencies=[...this.dependencies(item.kind,item.id)];
      const nextRevision=this.revision+1,now=this.now(),id=this.newId('chg');
      const refs=items.map(x=>({type:x.kind,id:x.id,revision:x.afterRevision??0}));
      const affected=new Map<string,{type:EntityKind;id:string;revision:number}>();
      for(const item of items){
        if(item.kind==='edition')for(const dep of item.dependencies as Array<{type:string;id:string}>){if(dep.type==='owned_copy')affected.set(dep.id,{type:'owned_copy',id:dep.id,revision:this.readRevision('owned_copy',dep.id)});}
        if(item.kind==='format')for(const dep of item.dependencies as Array<{type:string;id:string}>){if(dep.type==='edition')for(const copy of this.activeCopiesOfEdition(String(dep.id))){const copyId=String(copy.id);affected.set(copyId,{type:'owned_copy',id:copyId,revision:asNumber(copy.revision)});}}
      }
      const receipt:AppliedReceipt={contractVersion:1,changesetId:id,requestId,catalogueRevision:nextRevision,recordRefs:refs,...(affected.size?{affectedRecordRefs:[...affected.values()]}:{}),replayed:false};
      this.db.prepare('UPDATE catalogue_state SET catalogue_revision=? WHERE singleton_id=1').run(nextRevision);
      this.db.prepare(`INSERT INTO changesets(id,request_id,input_hash,principal_lineage,origin_conversation_id,undo_of,origin_kind,status,request,result,created_at,applied_at) VALUES(?,?,?, ?,NULL,?,'collector','applied',?,?,?,?)`).run(id,requestId,hash,trusted.lineage,changesetId,canonical,JSON.stringify(receipt),now,now);
      const insert=this.db.prepare(`INSERT INTO change_items(changeset_id,sequence,entity_kind,entity_id,operation,before_json,after_json,before_revision,after_revision,dependencies_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      items.forEach((x,i)=>insert.run(id,i,x.kind,x.id,x.operation,JSON.stringify(x.before),JSON.stringify(x.after),x.beforeRevision,x.afterRevision,JSON.stringify(x.dependencies)));
      return receipt;
    })();}catch(error){throw transactionError(error);}
  }

  private applyOperation(op: Operation, sequence: number, all: Operation[], refs: Map<string,string>): Item | null {
    const now=this.now();
    if (op.kind==='createWork') {
      const id=refs.get(op.ref)!; this.db.prepare('INSERT INTO works(id,category,title,normalized_title,artist,manual_metadata,created_at,updated_at,revision,deleted_at) VALUES(?,?,?,?,?,?,?,?,1,NULL)')
        .run(id,op.category,op.title,normalize(op.title),op.artist??null,canonicalJson(op.metadata??{}),now,now);
      return this.item('work',id,'create',null);
    }
    if (op.kind==='createFormat') {
      const normalized=normalize(op.label);
      const builtin=op.builtinCode?BUILTINS[op.category].find(x=>x.code===op.builtinCode):undefined;
      if(op.builtinCode&&(!builtin||builtin.label!==op.label))throw new CatalogueError('VALIDATION_FAILED','Built-in format does not match the canonical category choice.');
      if(!op.builtinCode&&BUILTINS[op.category].some(x=>normalize(x.label)===normalized))throw new CatalogueError('VALIDATION_FAILED','Choose the canonical built-in format entry.');
      const existing=this.db.prepare('SELECT id FROM formats WHERE category=? AND normalized_label=? AND deleted_at IS NULL').get(op.category,normalized) as Row|undefined;
      if(existing)throw new CatalogueError('CONFLICT','That format choice is already available; refresh choices and select it.',true);
      const id=refs.get(op.ref)!;
      try{this.db.prepare('INSERT INTO formats(id,category,label,normalized_label,builtin_code,created_at,updated_at,revision,deleted_at) VALUES(?,?,?,?,?,?,?,1,NULL)')
        .run(id,op.category,op.label,normalized,op.builtinCode??null,now,now);}catch(error){if(error&&typeof error==='object'&&'code' in error&&String((error as {code:unknown}).code).startsWith('SQLITE_CONSTRAINT_UNIQUE'))throw new CatalogueError('CONFLICT','That format choice was added elsewhere; refresh choices and select it.',true);throw error;}
      return this.item('format',id,'create',null);
    }
    if (op.kind==='createEdition') {
      const id=refs.get(op.ref)!; this.db.prepare('INSERT INTO editions(id,label,region,platform,created_at,updated_at,revision,deleted_at) VALUES(?,?,?,?,?,?,1,NULL)').run(id,op.label??null,op.region??null,op.platform??null,now,now);
      const content=this.db.prepare('INSERT INTO edition_contents(id,edition_id,work_id,coverage_mode) VALUES(?,?,?,?)');
      const season=this.db.prepare('INSERT INTO content_seasons(content_id,season_number) VALUES(?,?)');
      for (const c of op.contents) { const cid=this.newId('cnt'); content.run(cid,id,c.work,c.coverage); for(const n of c.seasons??[]) season.run(cid,n); }
      const format=this.db.prepare('INSERT INTO edition_formats(edition_id,format_id) VALUES(?,?)'); for(const f of op.formats) format.run(id,f);
      return this.item('edition',id,'create',null);
    }
    if (op.kind==='createCopy') {
      const id=refs.get(op.ref)!; this.db.prepare('INSERT INTO owned_copies(id,edition_id,label,condition,media_notes,packaging_notes,notes,shelf,created_at,updated_at,revision,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,NULL)')
        .run(id,op.edition,op.label??null,op.condition,op.mediaNotes??null,op.packagingNotes??null,op.notes??null,op.shelf??null,now,now);
      if(op.acquisition) this.writeAcquisition(id,op.acquisition);
      return this.item('owned_copy',id,'create',null);
    }
    const kind=kindForOperation(op); const id=op.id;
    const before=this.snapshot(kind,id);
    const row=this.currentRow(kind,id);
    if (!row || row.deleted_at!==null) throw new CatalogueError('NOT_FOUND','Record is unavailable.');
    const currentRev=asNumber(row.revision);
    if(currentRev!==op.expectedRevision) throw conflict(kind,id,currentRev);
    if(op.kind==='deleteCopy'||op.kind==='deleteEdition'||op.kind==='deleteWork'||op.kind==='deleteFormat') {
      this.db.prepare(`UPDATE ${TABLE_BY_KIND[kind]} SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?`).run(now,now,id);
      return this.item(kind,id,'delete',before,[...this.dependencies(kind,id)]);
    }
    if(op.kind==='updateWork') {
      const p=op.patch; const title=p.title??String(row.title);
      this.db.prepare('UPDATE works SET title=?,normalized_title=?,artist=?,manual_metadata=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(title,normalize(title),p.artist===undefined?row.artist:p.artist,p.metadata===undefined?row.manual_metadata:canonicalJson(p.metadata),now,id);
    } else if(op.kind==='updateEdition') {
      const p=op.patch;
      this.db.prepare('UPDATE editions SET label=?,region=?,platform=?,updated_at=?,revision=revision+1 WHERE id=?').run(p.label===undefined?row.label:p.label,p.region===undefined?row.region:p.region,p.platform===undefined?row.platform:p.platform,now,id);
      if(p.contents) this.replaceContents(id,p.contents);
      if(p.formats) this.replaceFormats(id,p.formats);
    } else if(op.kind==='updateCopy') {
      const p=op.patch;
      this.db.prepare('UPDATE owned_copies SET edition_id=?,condition=?,label=?,media_notes=?,packaging_notes=?,notes=?,shelf=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(p.edition===undefined?row.edition_id:p.edition,p.condition??row.condition,p.label===undefined?row.label:p.label,p.mediaNotes===undefined?row.media_notes:p.mediaNotes,p.packagingNotes===undefined?row.packaging_notes:p.packagingNotes,p.notes===undefined?row.notes:p.notes,p.shelf===undefined?row.shelf:p.shelf,now,id);
      if(p.acquisition) {
        const existing=this.db.prepare('SELECT purchase_date,amount_minor,currency_code,retailer FROM acquisitions WHERE owned_copy_id=?').get(id) as Row|undefined;
        this.writeAcquisition(id,{date:p.acquisition.date===undefined?(existing?.purchase_date as string|null|undefined):p.acquisition.date,amount:p.acquisition.amount===undefined?(existing?.amount_minor==null?null:minorToDecimal(existing.amount_minor as bigint,String(existing.currency_code))):p.acquisition.amount,currency:p.acquisition.currency===undefined?(existing?.currency_code as string|null|undefined):p.acquisition.currency,retailer:p.acquisition.retailer===undefined?(existing?.retailer as string|null|undefined):p.acquisition.retailer});
      }
    } else if(op.kind==='updateFormat') {
      if(row.builtin_code!==null)throw new CatalogueError('VALIDATION_FAILED','Built-in format labels are fixed.');
      if(BUILTINS[row.category as Category].some(x=>normalize(x.label)===normalize(op.patch.label)))throw new CatalogueError('VALIDATION_FAILED','Choose the canonical built-in format entry.');
      const collision=this.db.prepare('SELECT id FROM formats WHERE category=? AND normalized_label=? AND deleted_at IS NULL AND id<>?').get(row.category,normalize(op.patch.label),id);
      if(collision)throw new CatalogueError('CONFLICT','That format label already exists; refresh choices before editing.',true);
      this.db.prepare('UPDATE formats SET label=?,normalized_label=?,updated_at=?,revision=revision+1 WHERE id=?').run(op.patch.label,normalize(op.patch.label),now,id);
    }
    const after=this.snapshot(kind,id);
    if (semanticJson(before)===semanticJson(after)) {
      this.db.prepare(`UPDATE ${TABLE_BY_KIND[kind]} SET revision=?,updated_at=? WHERE id=?`).run(currentRev,row.updated_at,id);
    }
    const stableAfter=this.snapshot(kind,id);
    return {kind,id,operation:'update',before,after:stableAfter,beforeRevision:currentRev,afterRevision:this.readRevision(kind,id),dependencies:[...this.dependencies(kind,id)]};
  }
  private item(kind:EntityKind,id:string,operation:string,before:unknown|null,dependencies:unknown[]=[]):Item {
    const after=this.snapshot(kind,id); return {kind,id,operation,before,after,beforeRevision:before===null?null:this.readRevision(kind,id)-1,afterRevision:this.readRevision(kind,id),dependencies};
  }
  private snapshot(kind:EntityKind,id:string): unknown {
    const row=this.currentRow(kind,id); if(!row)return null;
    if(kind==='edition') {
      const contents=this.db.prepare('SELECT id,work_id,coverage_mode FROM edition_contents WHERE edition_id=? ORDER BY id').all(id) as Row[];
      const expanded=contents.map((c)=>({...c,seasons:(this.db.prepare('SELECT season_number FROM content_seasons WHERE content_id=? ORDER BY season_number').all(c.id) as Row[]).map(x=>asNumber(x.season_number))}));
      const formats=(this.db.prepare('SELECT format_id FROM edition_formats WHERE edition_id=? ORDER BY format_id').all(id) as Row[]).map(x=>x.format_id);
      return jsonSafe({record:row,contents:expanded,formats});
    }
    if(kind==='owned_copy') return jsonSafe({record:row,acquisition:this.db.prepare('SELECT purchase_date,amount_minor,currency_code,retailer FROM acquisitions WHERE owned_copy_id=?').get(id)??null});
    return jsonSafe(row);
  }
  private currentRow(kind:EntityKind,id:string): Row|undefined { return this.db.prepare(`SELECT * FROM ${TABLE_BY_KIND[kind]} WHERE id=?`).get(id) as Row|undefined; }
  private readRevision(kind:EntityKind,id:string): number { const r=this.currentRow(kind,id); return r?asNumber(r.revision):0; }
  private dependencies(kind:EntityKind,id:string): unknown[] {
    if(kind==='edition') return (this.db.prepare('SELECT id FROM owned_copies WHERE edition_id=? AND deleted_at IS NULL ORDER BY id').all(id) as Row[]).map(x=>({type:'owned_copy',id:x.id}));
    if(kind==='work') return (this.db.prepare('SELECT ec.edition_id FROM edition_contents ec JOIN editions e ON e.id=ec.edition_id WHERE ec.work_id=? AND e.deleted_at IS NULL ORDER BY ec.edition_id').all(id) as Row[]).map(x=>({type:'edition',id:x.edition_id}));
    if(kind==='format') return (this.db.prepare('SELECT ef.edition_id FROM edition_formats ef JOIN editions e ON e.id=ef.edition_id WHERE ef.format_id=? AND e.deleted_at IS NULL ORDER BY ef.edition_id').all(id) as Row[]).map(x=>({type:'edition',id:x.edition_id}));
    return [{type:'edition',id:(this.currentRow(kind,id)??{}).edition_id}];
  }
  private writeAcquisition(copyId:string,p:NonNullable<Extract<Operation,{kind:'createCopy'}>['acquisition']>) {
    if(p.date!=null&&!isCalendarDate(p.date)) throw new CatalogueError('VALIDATION_FAILED','Invalid calendar date.');
    const parsed=decimalToMinor(p.amount,p.currency);
    this.db.prepare(`INSERT INTO acquisitions(owned_copy_id,purchase_date,amount_minor,currency_code,retailer) VALUES(?,?,?,?,?) ON CONFLICT(owned_copy_id) DO UPDATE SET purchase_date=excluded.purchase_date,amount_minor=excluded.amount_minor,currency_code=excluded.currency_code,retailer=excluded.retailer`)
      .run(copyId,p.date??null,parsed.amountMinor,parsed.currencyCode,p.retailer??null);
  }
  private replaceContents(editionId:string,contents:Extract<Operation,{kind:'createEdition'}>['contents']) {
    const existing=this.db.prepare('SELECT id,work_id,coverage_mode FROM edition_contents WHERE edition_id=?').all(editionId) as Row[];
    const byWork=new Map(existing.map(x=>[String(x.work_id),{id:String(x.id),coverage:String(x.coverage_mode)}]));
    const wanted=new Set(contents.map(x=>x.work));
    for(const row of existing)if(!wanted.has(String(row.work_id))){this.db.prepare('DELETE FROM content_seasons WHERE content_id=?').run(row.id);this.db.prepare('DELETE FROM edition_contents WHERE id=?').run(row.id);}
    const add=this.db.prepare('INSERT INTO edition_contents(id,edition_id,work_id,coverage_mode) VALUES(?,?,?,?)');
    const update=this.db.prepare('UPDATE edition_contents SET coverage_mode=? WHERE id=?');
    const season=this.db.prepare('INSERT INTO content_seasons(content_id,season_number) VALUES(?,?)');
    for(const c of contents){const old=byWork.get(c.work);const id=old?.id??this.newId('cnt');if(old)update.run(c.coverage,id);else add.run(id,editionId,c.work,c.coverage);this.db.prepare('DELETE FROM content_seasons WHERE content_id=?').run(id);for(const n of c.seasons??[])season.run(id,n);}
  }
  private replaceFormats(editionId:string,formats:string[]) { this.db.prepare('DELETE FROM edition_formats WHERE edition_id=?').run(editionId); const s=this.db.prepare('INSERT INTO edition_formats(edition_id,format_id) VALUES(?,?)');for(const id of formats)s.run(editionId,id); }
  private activeCopiesOfEdition(editionId:string){return this.db.prepare('SELECT id,revision FROM owned_copies WHERE edition_id=? AND deleted_at IS NULL ORDER BY id').all(editionId) as Row[];}
  private restoreSnapshot(kind:EntityKind,id:string,snapshot:unknown) {
    const now=this.now();
    if(snapshot===null){
      this.db.prepare(`UPDATE ${TABLE_BY_KIND[kind]} SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?`).run(now,now,id);return;
    }
    const data=snapshot as {record:Row;contents?:Array<Row & {seasons:number[]}>;formats?:string[];acquisition?:Row|null};
    const row=(kind==='edition'||kind==='owned_copy')?data.record:snapshot as Row;
    const deletedAt=row.deleted_at??null;
    if(kind==='work')this.db.prepare('UPDATE works SET category=?,title=?,normalized_title=?,artist=?,manual_metadata=?,deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(row.category,row.title,row.normalized_title,row.artist,row.manual_metadata,deletedAt,now,id);
    else if(kind==='format')this.db.prepare('UPDATE formats SET category=?,label=?,normalized_label=?,builtin_code=?,deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(row.category,row.label,row.normalized_label,row.builtin_code,deletedAt,now,id);
    else if(kind==='owned_copy'){
      this.db.prepare('UPDATE owned_copies SET edition_id=?,label=?,condition=?,media_notes=?,packaging_notes=?,notes=?,shelf=?,deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(row.edition_id,row.label,row.condition,row.media_notes,row.packaging_notes,row.notes,row.shelf,deletedAt,now,id);
      this.db.prepare('DELETE FROM acquisitions WHERE owned_copy_id=?').run(id);
      if(data.acquisition){const a=data.acquisition;this.db.prepare('INSERT INTO acquisitions(owned_copy_id,purchase_date,amount_minor,currency_code,retailer) VALUES(?,?,?,?,?)').run(id,a.purchase_date,a.amount_minor==null?null:BigInt(String(a.amount_minor)),a.currency_code,a.retailer);}
    } else {
      this.db.prepare('UPDATE editions SET label=?,region=?,platform=?,deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(row.label,row.region,row.platform,deletedAt,now,id);
      this.db.prepare('DELETE FROM content_seasons WHERE content_id IN (SELECT id FROM edition_contents WHERE edition_id=?)').run(id);
      this.db.prepare('DELETE FROM edition_contents WHERE edition_id=?').run(id);
      this.db.prepare('DELETE FROM edition_formats WHERE edition_id=?').run(id);
      for(const c of data.contents??[]){this.db.prepare('INSERT INTO edition_contents(id,edition_id,work_id,coverage_mode) VALUES(?,?,?,?)').run(c.id,id,c.work_id,c.coverage_mode);for(const season of c.seasons??[])this.db.prepare('INSERT INTO content_seasons(content_id,season_number) VALUES(?,?)').run(c.id,season);}
      for(const formatId of data.formats??[])this.db.prepare('INSERT INTO edition_formats(edition_id,format_id) VALUES(?,?)').run(id,formatId);
    }
  }
  private validateFinalGraph() {
    validateActiveGraph(this.db, 'VALIDATION_FAILED');
  }
  private now(){return (this.options.clock?.()??new Date()).toISOString();}
  private newId(prefix:string){return `${prefix}_${(this.options.id?.()??globalThis.crypto.randomUUID()).replaceAll('-','')}`;}

  private checkExpectedReleaseRevisions(operations:Operation[]){
    for(const op of operations){
      if(op.kind==='createCopy'&&!op.edition.startsWith('$'))this.assertEditionRevision(op.edition,op.expectedEditionRevision!);
      if(op.kind==='updateCopy'&&op.patch.edition!==undefined){
        const copy=this.currentRow('owned_copy',op.id);
        if(!copy||copy.deleted_at!==null)throw new CatalogueError('NOT_FOUND','Record is unavailable.');
        this.assertEditionRevision(String(copy.edition_id),op.expectedSourceEditionRevision!);
        if(!op.patch.edition.startsWith('$'))this.assertEditionRevision(op.patch.edition,op.expectedTargetEditionRevision!);
      }
    }
  }
  private assertEditionRevision(id:string,expected:number){
    const row=this.currentRow('edition',id);
    if(!row||row.deleted_at!==null)throw new CatalogueError('NOT_FOUND','Edition is unavailable.');
    const current=asNumber(row.revision);if(current!==expected)throw conflict('edition',id,current);
  }

  detail(kind:EntityKind,id:string):CatalogueDetail {
    this.assertAvailable();
    if(!Object.hasOwn(TABLE_BY_KIND,kind)||typeof id!=='string'||!id.length||id.length>160)throw new CatalogueError('VALIDATION_FAILED','Detail request is invalid.');
    const row=this.currentRow(kind,id);if(!row||row.deleted_at!==null)throw new CatalogueError('NOT_FOUND','Record is unavailable.');
    const snapshot=this.snapshot(kind,id) as any;
    if(kind==='work'){
      const editions=this.db.prepare('SELECT DISTINCT e.id,e.revision FROM edition_contents ec JOIN editions e ON e.id=ec.edition_id WHERE ec.work_id=? AND e.deleted_at IS NULL ORDER BY e.id').all(id) as Row[];
      const copies=this.db.prepare('SELECT DISTINCT c.id,c.revision FROM edition_contents ec JOIN owned_copies c ON c.edition_id=ec.edition_id WHERE ec.work_id=? AND c.deleted_at IS NULL ORDER BY c.id').all(id) as Row[];
      return {type:'work',id:String(row.id),category:row.category as any,title:String(row.title),artist:row.artist===null?null:String(row.artist),metadata:JSON.parse(String(row.manual_metadata??'{}')),createdAt:String(row.created_at),updatedAt:String(row.updated_at),revision:asNumber(row.revision),editionRefs:editions.map(x=>({id:String(x.id),revision:asNumber(x.revision)})),ownedCopyRefs:copies.map(x=>({id:String(x.id),revision:asNumber(x.revision)}))};
    }
    if(kind==='owned_copy'){
      const acquisition=snapshot.acquisition;
      const r=snapshot.record as Row;
      return {type:'owned_copy',record:{id:String(r.id),editionId:String(r.edition_id),label:r.label===null?null:String(r.label),condition:r.condition as any,mediaNotes:r.media_notes===null?null:String(r.media_notes),packagingNotes:r.packaging_notes===null?null:String(r.packaging_notes),notes:r.notes===null?null:String(r.notes),shelf:r.shelf===null?null:String(r.shelf),createdAt:String(r.created_at),updatedAt:String(r.updated_at),revision:asNumber(r.revision)},edition:this.editionProjection(String(r.edition_id)),acquisition:acquisition?{date:acquisition.purchase_date===null?null:String(acquisition.purchase_date),amount:minorToDecimal(acquisition.amount_minor===null?null:BigInt(String(acquisition.amount_minor)),acquisition.currency_code===null?null:String(acquisition.currency_code)),currency:acquisition.currency_code===null?null:String(acquisition.currency_code),retailer:acquisition.retailer===null?null:String(acquisition.retailer)}:null};
    }
    if(kind==='edition'){
      const copies=this.db.prepare('SELECT id,revision FROM owned_copies WHERE edition_id=? AND deleted_at IS NULL ORDER BY id').all(id) as Row[];
      const projection=this.editionProjection(id)!;
      return {...projection,type:'edition',ownedCopyRefs:copies.map(x=>({id:String(x.id),revision:asNumber(x.revision)}))};
    }
    const editionRefs=(this.dependencies('format',id) as Array<{type:string;id:string}>).map(x=>({id:x.id,revision:this.readRevision('edition',x.id)}));
    return {type:'format',id:String(row.id),category:row.category as any,label:String(row.label),builtinCode:row.builtin_code===null?null:String(row.builtin_code),createdAt:String(row.created_at),updatedAt:String(row.updated_at),revision:asNumber(row.revision),editionRefs};
  }
  private editionProjection(id:string):EditionProjection|null {
    const row=this.currentRow('edition',id);if(!row||row.deleted_at!==null)return null;
    const snapshot=this.snapshot('edition',id) as any;
    const r=snapshot.record as Row;
    const contents=(snapshot.contents as Array<Row & {seasons:number[]}>).map((content)=>{const work=this.db.prepare('SELECT id,category,title,revision FROM works WHERE id=? AND deleted_at IS NULL').get(content.work_id) as Row|undefined;return {id:String(content.id),workId:String(content.work_id),coverageMode:content.coverage_mode as any,seasons:content.seasons,work:work?{id:String(work.id),category:work.category as any,title:String(work.title),revision:asNumber(work.revision)}:null};});
    const formats=(snapshot.formats as string[]).map((formatId)=>this.db.prepare('SELECT id,category,label,builtin_code,revision FROM formats WHERE id=? AND deleted_at IS NULL').get(formatId) as Row|undefined).filter((x):x is Row=>!!x).map(x=>({id:String(x.id),category:x.category as any,label:String(x.label),builtinCode:x.builtin_code===null?null:String(x.builtin_code),revision:asNumber(x.revision)}));
    return {record:{id:String(r.id),label:r.label===null?null:String(r.label),region:r.region===null?null:String(r.region),platform:r.platform===null?null:String(r.platform),createdAt:String(r.created_at),updatedAt:String(r.updated_at),revision:asNumber(r.revision)},contents,formats};
  }
  private pageCursor(cursor:string|undefined,qhash:string,position:string):string {
    if(!cursor)return '';
    try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString()) as {revision:number;query:string;position:string};if(c.revision!==this.revision)throw new CatalogueError('STALE_CURSOR','Catalogue changed; restart this list.');if(c.query!==qhash||typeof c.position!=='string')throw new CatalogueError('INVALID_CURSOR','List cursor is invalid.');return c.position;}catch(e){if(e instanceof CatalogueError)throw e;throw new CatalogueError('INVALID_CURSOR','List cursor is invalid.');}
  }
  private nextPageCursor(qhash:string,position:string|null,more:boolean):string|null{return more&&position?Buffer.from(JSON.stringify({revision:this.revision,query:qhash,position})).toString('base64url'):null;}
  copies(input:CopyPageRequest){
    this.assertAvailable();
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['workId','limit','cursor'].includes(k))||typeof input.workId!=='string'||input.workId.length<1||input.workId.length>160||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1)||input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length>2048))throw new CatalogueError('VALIDATION_FAILED','Copy page request is invalid.');
    const limit=Math.min(input.limit??50,100),query=canonicalJson({workId:input.workId}),qhash=createHash('sha256').update(query).digest('hex'),after=this.pageCursor(input.cursor,qhash,'');
    const exists=this.db.prepare('SELECT id FROM works WHERE id=? AND deleted_at IS NULL').get(input.workId);if(!exists)throw new CatalogueError('NOT_FOUND','Work is unavailable.');
    const rows=this.db.prepare(`SELECT c.id,c.revision,c.edition_id,c.condition,c.shelf,a.purchase_date,w.title,w.category FROM owned_copies c JOIN editions e ON e.id=c.edition_id JOIN edition_contents ec ON ec.edition_id=e.id JOIN works w ON w.id=ec.work_id LEFT JOIN acquisitions a ON a.owned_copy_id=c.id WHERE ec.work_id=? AND c.deleted_at IS NULL AND e.deleted_at IS NULL AND (?='' OR c.id>?) ORDER BY c.id LIMIT ?`).all(input.workId,after,after,limit+1) as Row[];
    const more=rows.length>limit,page=rows.slice(0,limit),tail=page.at(-1);
    return {contractVersion:1 as const,catalogueRevision:this.revision,items:page.map(x=>({id:String(x.id),revision:asNumber(x.revision),editionId:String(x.edition_id),title:String(x.title),category:x.category as Category,shelf:x.shelf===null?null:String(x.shelf),condition:x.condition as any,purchaseDate:x.purchase_date===null?null:String(x.purchase_date)})),nextCursor:this.nextPageCursor(qhash,tail?String(tail.id):null,more)};
  }
  picker(input:PickerRequest){
    this.assertAvailable();
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['kind','query','category','limit','cursor'].includes(k))||!['work','edition'].includes(input.kind)||input.query!==undefined&&(typeof input.query!=='string'||input.query.length>500)||input.category!==undefined&&!['film','tv','music','game'].includes(input.category)||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1)||input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length>2048))throw new CatalogueError('VALIDATION_FAILED','Picker request is invalid.');
    const limit=Math.min(input.limit??50,100),q=(input.query??'').trim().toLowerCase(),query=canonicalJson({kind:input.kind,q,category:input.category??null}),qhash=createHash('sha256').update(query).digest('hex'),after=this.pageCursor(input.cursor,qhash,'');
    const position=decodeTuplePosition(after,'Picker');
    let rows:Row[],sortValue:(row:Row)=>string;
    if(input.kind==='work'){
      rows=this.db.prepare(`SELECT id,revision,title,category,normalized_title sort_value FROM works WHERE deleted_at IS NULL AND (? IS NULL OR category=?) AND (?='' OR normalized_title LIKE '%'||?||'%') AND (?='' OR normalized_title>? OR (normalized_title=? AND id>?)) ORDER BY normalized_title,id LIMIT ?`).all(input.category??null,input.category??null,q,q,position[0],position[0],position[0],position[1],limit+1) as Row[];
      sortValue=row=>String(row.sort_value);
    }else{
      rows=this.db.prepare(`WITH releases AS (SELECT e.id,e.revision,COALESCE(e.label,'') label,(SELECT group_concat(w.title,', ') FROM edition_contents ec JOIN works w ON w.id=ec.work_id WHERE ec.edition_id=e.id AND w.deleted_at IS NULL) title,(SELECT count(*) FROM edition_contents ec WHERE ec.edition_id=e.id) work_count,(SELECT group_concat(f.label,', ') FROM edition_formats ef JOIN formats f ON f.id=ef.format_id WHERE ef.edition_id=e.id) format_labels FROM editions e WHERE e.deleted_at IS NULL) SELECT *,lower(COALESCE(title,'')) sort_value FROM releases WHERE (?='' OR lower(label||' '||COALESCE(title,'')) LIKE '%'||?||'%') AND (?='' OR sort_value>? OR (sort_value=? AND id>?)) ORDER BY sort_value,id LIMIT ?`).all(q,q,position[0],position[0],position[0],position[1],limit+1) as Row[];
      sortValue=row=>String(row.sort_value);
    }
    const more=rows.length>limit,page=rows.slice(0,limit),tail=page.at(-1);
    return {contractVersion:1 as const,catalogueRevision:this.revision,items:page.map(x=>input.kind==='work'?{id:String(x.id),revision:asNumber(x.revision),title:String(x.title),category:x.category as Category}:{id:String(x.id),revision:asNumber(x.revision),title:String(x.title??'Untitled release'),label:String(x.label)||null,workCount:asNumber(x.work_count),formatLabels:String(x.format_labels??'').split(', ').filter(Boolean)}),nextCursor:this.nextPageCursor(qhash,tail?JSON.stringify([sortValue(tail),String(tail.id)]):null,more)};
  }
  formats(input:FormatLookupRequest){
    this.assertAvailable();
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['category','query','exactLabel','limit','cursor'].includes(k))||!['film','tv','music','game'].includes(input.category)||input.query!==undefined&&(typeof input.query!=='string'||input.query.length>500)||input.exactLabel!==undefined&&(typeof input.exactLabel!=='string'||input.exactLabel.trim().length===0||input.exactLabel.length>200)||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1)||input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length>2048))throw new CatalogueError('VALIDATION_FAILED','Format lookup request is invalid.');
    const limit=Math.min(input.limit??50,100),q=(input.query??'').trim().toLowerCase(),exact=input.exactLabel===undefined?null:normalize(input.exactLabel),query=canonicalJson({category:input.category,q,exact}),qhash=createHash('sha256').update(query).digest('hex'),after=this.pageCursor(input.cursor,qhash,'');
    const position=decodeTuplePosition(after,'Format');
    const builtinLabels=BUILTINS[input.category].map(x=>normalize(x.label));
    const builtins=BUILTINS[input.category].filter(x=>(!q||x.label.toLowerCase().includes(q))&&(!exact||normalize(x.label)===exact)).map(x=>{const row=this.db.prepare('SELECT id,revision,label,builtin_code FROM formats WHERE category=? AND (builtin_code=? OR normalized_label=?) AND deleted_at IS NULL ORDER BY CASE WHEN builtin_code=? THEN 0 ELSE 1 END LIMIT 1').get(input.category,x.code,normalize(x.label),x.code) as Row|undefined;const label=row?String(row.label):x.label;return {id:row?String(row.id):null,revision:row?asNumber(row.revision):null,category:input.category,label,builtinCode:x.code,builtin:true,sortValue:normalize(label),sortId:row?String(row.id):`!builtin:${x.code}`};});
    const custom=this.db.prepare(`SELECT id,revision,category,label,builtin_code,normalized_label sort_value FROM formats WHERE category=? AND deleted_at IS NULL AND (?='' OR normalized_label LIKE '%'||?||'%') AND (? IS NULL OR normalized_label=?) AND builtin_code IS NULL AND normalized_label NOT IN (${builtinLabels.map(()=>'?').join(',')}) AND (?='' OR normalized_label>? OR (normalized_label=? AND id>?)) ORDER BY normalized_label,id LIMIT ?`).all(input.category,q,q,exact,exact,...builtinLabels,position[0],position[0],position[0],position[1],limit+1) as Row[];
    const candidates=[...builtins.filter(x=>compareTuple([x.sortValue,x.sortId],position)>0).map(x=>({...x,id:x.id,revision:x.revision,category:input.category,builtinCode:x.builtinCode,builtin:true})),...custom.map(x=>({id:String(x.id),revision:asNumber(x.revision),category:x.category as Category,label:String(x.label),builtinCode:null as string|null,builtin:false,sortValue:String(x.sort_value),sortId:String(x.id)}))].sort((a,b)=>compareTuple([a.sortValue,a.sortId], [b.sortValue,b.sortId]));
    const page=candidates.slice(0,limit),tail=page.at(-1),items=page.map(({sortValue:_sv,sortId:_si,...item})=>item);
    return {contractVersion:1 as const,catalogueRevision:this.revision,items,nextCursor:this.nextPageCursor(qhash,tail?JSON.stringify([tail.sortValue,tail.sortId]):null,candidates.length>limit)};
  }
  lookups(){
    this.assertAvailable();
    const genres=this.db.prepare(`SELECT min(genre) AS genre FROM (
      SELECT trim(g.value) AS genre FROM works w,json_each(w.manual_metadata,'$.genres') g
      WHERE w.deleted_at IS NULL AND json_type(w.manual_metadata,'$.genres')='array' AND typeof(g.value)='text'
      UNION ALL
      SELECT trim(json_extract(w.manual_metadata,'$.genre')) AS genre FROM works w
      WHERE w.deleted_at IS NULL AND json_type(w.manual_metadata,'$.genre')='text'
    ) WHERE genre<>'' GROUP BY lower(genre) ORDER BY lower(min(genre)),min(genre)`).all() as Row[];
    return {currencies:allCurrencies(),conditionOptions:['unknown','new','like_new','very_good','good','acceptable'] as const,tvCoverageOptions:['unknown','explicit','complete'] as const,genres:genres.map(x=>String(x.genre))};
  }
  statistics(){
    this.assertAvailable();
    const summary=this.summary();
    const categories=this.db.prepare(`SELECT w.category,count(DISTINCT c.id) n FROM owned_copies c JOIN editions e ON e.id=c.edition_id JOIN edition_contents ec ON ec.edition_id=e.id JOIN works w ON w.id=ec.work_id WHERE c.deleted_at IS NULL AND e.deleted_at IS NULL AND w.deleted_at IS NULL GROUP BY w.category ORDER BY w.category`).all() as Row[];
    const formats=this.db.prepare(`SELECT f.normalized_label,min(f.label) label,count(DISTINCT c.id) n FROM owned_copies c JOIN editions e ON e.id=c.edition_id JOIN edition_formats ef ON ef.edition_id=e.id JOIN formats f ON f.id=ef.format_id WHERE c.deleted_at IS NULL AND e.deleted_at IS NULL AND f.deleted_at IS NULL GROUP BY f.normalized_label ORDER BY f.normalized_label`).all() as Row[];
    return {...summary,categoryMemberships:categories.map(x=>({category:x.category as Category,copyCount:asNumber(x.n)})),formatMemberships:formats.map(x=>({label:String(x.label),copyCount:asNumber(x.n)}))};
  }
  historyList(input:{limit?:number;cursor?:string},caller:TrustedCaller){
    this.assertAvailable();
    assertCaller(caller);if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['limit','cursor'].includes(k))||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1)||input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length>2048))throw new CatalogueError('VALIDATION_FAILED','History request is invalid.');
    const limit=Math.min(input.limit??30,100);let before='';if(input.cursor){try{const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString()) as {id:string};if(typeof c.id!=='string')throw new Error();before=c.id;}catch{throw new CatalogueError('INVALID_CURSOR','History cursor is invalid.');}}
    const rows=this.db.prepare(`SELECT id,created_at,status,undo_of,(SELECT count(*) FROM change_items ci WHERE ci.changeset_id=c.id) change_count FROM changesets c WHERE origin_kind='collector' AND principal_lineage=? AND (?='' OR created_at||id<?) ORDER BY created_at DESC,id DESC LIMIT ?`).all(caller.lineage,before,before,limit+1) as Row[];
    const more=rows.length>limit,page=rows.slice(0,limit),tail=page.at(-1);
    return {contractVersion:1 as const,items:page.map(x=>{const kinds=(this.db.prepare('SELECT DISTINCT entity_kind,operation FROM change_items WHERE changeset_id=? ORDER BY entity_kind,operation').all(x.id) as Row[]).map(y=>`${String(y.operation)} ${String(y.entity_kind)}`);return {id:String(x.id),createdAt:String(x.created_at),status:this.historyStatus(String(x.id),caller.lineage),undoOf:x.undo_of===null?null:String(x.undo_of),changeCount:asNumber(x.change_count),operations:kinds};}),nextCursor:more&&tail?Buffer.from(JSON.stringify({id:`${String(tail.created_at)}${String(tail.id)}`})).toString('base64url'):null};
  }
  historyGet(id:string,input:{limit?:number;cursor?:string},caller:TrustedCaller):ChangeHistoryDetail{
    this.assertAvailable();
    assertCaller(caller);if(typeof id!=='string'||!id.trim()||id.length>160)throw new CatalogueError('VALIDATION_FAILED','History item request is invalid.');
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['limit','cursor'].includes(k))||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1)||input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length>2048))throw new CatalogueError('VALIDATION_FAILED','History detail request is invalid.');
    const row=this.db.prepare(`SELECT id,created_at,status,undo_of FROM changesets WHERE id=? AND origin_kind='collector' AND principal_lineage=?`).get(id,caller.lineage) as Row|undefined;if(!row)throw new CatalogueError('NOT_FOUND','Change is unavailable.');
    const limit=Math.min(input.limit??50,100),query=canonicalJson({changesetId:id}),qhash=createHash('sha256').update(query).digest('hex'),after=input.cursor?this.pageCursor(input.cursor,qhash,'-1'):'-1';
    if(!/^-?\d+$/.test(after))throw new CatalogueError('INVALID_CURSOR','History detail cursor is invalid.');
    const rows=this.db.prepare('SELECT sequence,entity_kind,entity_id,operation,before_json,after_json,before_revision,after_revision FROM change_items WHERE changeset_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id,Number(after),limit+1) as Row[];
    const more=rows.length>limit,changes=rows.slice(0,limit),tail=changes.at(-1);
    return {id:String(row.id),createdAt:String(row.created_at),status:this.historyStatus(String(row.id),caller.lineage),undoOf:row.undo_of===null?null:String(row.undo_of),changes:changes.map(x=>{const kind=String(x.entity_kind) as EntityKind;return {kind,id:String(x.entity_id),operation:String(x.operation),before:this.historyProjection(kind,x.before_json),after:this.historyProjection(kind,x.after_json),beforeRevision:x.before_revision===null?null:asNumber(x.before_revision),afterRevision:x.after_revision===null?null:asNumber(x.after_revision)};}),nextCursor:this.nextPageCursor(qhash,tail?String(Number(tail.sequence)):null,more)};
  }
  private historyStatus(id:string,lineage:string):'applied'|'undone'{
    const result=this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM changesets WHERE undo_of=? AND origin_kind='collector' AND principal_lineage=?
      UNION ALL
      SELECT child.id FROM changesets child JOIN descendants parent ON child.undo_of=parent.id
      WHERE child.origin_kind='collector' AND child.principal_lineage=?
    ) SELECT count(*) n FROM descendants`).get(id,lineage,lineage) as Row;
    return asNumber(result.n)%2===1?'undone':'applied';
  }
  private historyProjection(kind:EntityKind,json:unknown):ChangeHistoryProjection|null{
    if(json===null)return null;const value=JSON.parse(String(json)) as Row;const snapshot=(kind==='edition'||kind==='owned_copy')?(value as Row):{record:value};const r=(snapshot.record??{}) as Row;
    const deleted=r.deleted_at!==null&&r.deleted_at!==undefined,nullable=(value:unknown):string|null=>value===null||value===undefined?null:String(value);
    if(kind==='work')return {deleted,title:String(r.title),category:r.category as Category,artist:nullable(r.artist),metadata:JSON.parse(String(r.manual_metadata??'{}')) as Record<string,unknown>};
    if(kind==='format')return {deleted,category:r.category as Category,label:String(r.label),builtinCode:nullable(r.builtin_code)};
    if(kind==='edition')return {deleted,label:nullable(r.label),region:nullable(r.region),platform:nullable(r.platform),contents:(snapshot.contents as Row[]??[]).map(c=>({workId:String(c.work_id),coverage:String(c.coverage_mode) as any,seasons:c.seasons as number[]})),formats:snapshot.formats as string[]};
    const a=snapshot.acquisition as Row|null|undefined,currency=nullable(a?.currency_code);return {deleted,editionId:String(r.edition_id),condition:r.condition as any,shelf:nullable(r.shelf),label:nullable(r.label),notes:nullable(r.notes),mediaNotes:nullable(r.media_notes),packagingNotes:nullable(r.packaging_notes),acquisition:a?{date:nullable(a.purchase_date),amount:minorToDecimal(a.amount_minor===null?null:BigInt(String(a.amount_minor)),currency),currency,retailer:nullable(a.retailer)}:null};
  }
  search(input:CatalogueSearchRequest={}):CatalogueSearchResult {
    this.assertAvailable();
    const allowed=['query','category','formatId','genre','purchaseDateFrom','purchaseDateTo','limit','cursor'];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).some(x=>!allowed.includes(x)))throw new CatalogueError('VALIDATION_FAILED','Search request is invalid.');
    for(const field of ['query','category','formatId','genre','purchaseDateFrom','purchaseDateTo','cursor'] as const)if(input[field]!==undefined&&input[field]!==null&&typeof input[field]!=='string')throw new CatalogueError('VALIDATION_FAILED','Search request is invalid.');
    const query={query:input.query?.trim().toLowerCase()??'',category:input.category??null,formatId:input.formatId??null,genre:input.genre?.trim().toLowerCase()??null,purchaseDateFrom:input.purchaseDateFrom??null,purchaseDateTo:input.purchaseDateTo??null};
    if(query.query.length>500||query.genre&&query.genre.length>120||query.formatId&&query.formatId.length>160||input.cursor&&input.cursor.length>2048)throw new CatalogueError('VALIDATION_FAILED','Search request is too large.');
    if(input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1))throw new CatalogueError('VALIDATION_FAILED','Search page size is invalid.');
    if(query.category&&!['film','tv','music','game'].includes(query.category))throw new CatalogueError('VALIDATION_FAILED','Category filter is invalid.');
    for(const d of [query.purchaseDateFrom,query.purchaseDateTo])if(d&&!isCalendarDate(d))throw new CatalogueError('VALIDATION_FAILED','Purchase date filter is invalid.');
    const limit=Math.min(Math.max(input.limit??50,1),100);const rev=this.revision;const qhash=createHash('sha256').update(canonicalJson(query)).digest('hex');
    let last:{title:string;id:string}|undefined;
    if(input.cursor){try{const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString()) as {rev:number;qhash:string;title:string;id:string};if(!c||!Number.isSafeInteger(c.rev)||typeof c.qhash!=='string'||typeof c.title!=='string'||typeof c.id!=='string')throw new CatalogueError('INVALID_CURSOR','Search cursor is invalid.');if(c.rev!==rev)throw new CatalogueError('STALE_CURSOR','Catalogue changed; restart the search.');if(c.qhash!==qhash)throw new CatalogueError('INVALID_CURSOR','Cursor belongs to another search.');last={title:c.title,id:c.id};}catch(e){if(e instanceof CatalogueError)throw e;throw new CatalogueError('INVALID_CURSOR','Search cursor is invalid.');}}
    const rows=this.db.prepare(`SELECT w.id,w.category,w.title,w.normalized_title,w.revision,
      (SELECT count(*) FROM edition_contents ec JOIN editions e ON e.id=ec.edition_id WHERE ec.work_id=w.id AND e.deleted_at IS NULL) AS edition_count,
      (SELECT count(DISTINCT c.id) FROM edition_contents ec JOIN owned_copies c ON c.edition_id=ec.edition_id WHERE ec.work_id=w.id AND c.deleted_at IS NULL) AS copy_count
      FROM works w WHERE w.deleted_at IS NULL AND (? IS NULL OR w.category=?) AND (?='' OR w.normalized_title LIKE '%'||?||'%')
      AND (? IS NULL OR EXISTS(SELECT 1 FROM edition_contents ec JOIN edition_formats ef ON ef.edition_id=ec.edition_id JOIN editions e ON e.id=ec.edition_id WHERE ec.work_id=w.id AND ef.format_id=? AND e.deleted_at IS NULL))
      AND (? IS NULL OR lower(COALESCE(json_extract(w.manual_metadata,'$.genre'),'')) LIKE '%'||?||'%' OR lower(COALESCE(json_extract(w.manual_metadata,'$.genres'),'')) LIKE '%'||?||'%')
      AND ((? IS NULL AND ? IS NULL) OR EXISTS(SELECT 1 FROM edition_contents ec JOIN owned_copies c ON c.edition_id=ec.edition_id JOIN acquisitions a ON a.owned_copy_id=c.id WHERE ec.work_id=w.id AND c.deleted_at IS NULL AND (? IS NULL OR a.purchase_date>=?) AND (? IS NULL OR a.purchase_date<=?)))
      AND (? IS NULL OR w.normalized_title>? OR (w.normalized_title=? AND w.id>?))
      ORDER BY w.normalized_title,w.id LIMIT ?`).all(query.category,query.category,query.query,query.query,query.formatId,query.formatId,query.genre,query.genre,query.genre,query.purchaseDateFrom,query.purchaseDateTo,query.purchaseDateFrom,query.purchaseDateFrom,query.purchaseDateTo,query.purchaseDateTo,last?.title??null,last?.title??'',last?.title??'',last?.id??'',limit+1) as Row[];
    const more=rows.length>limit;const page=rows.slice(0,limit);const tail=page.at(-1);const cursor=more&&tail?Buffer.from(JSON.stringify({rev,qhash,title:tail.normalized_title,id:tail.id})).toString('base64url'):null;
    return {contractVersion:1 as const,catalogueRevision:rev,items:page.map(x=>({type:'work' as const,id:String(x.id),category:x.category as any,title:String(x.title),revision:asNumber(x.revision),editionCount:asNumber(x.edition_count),copyCount:asNumber(x.copy_count)})),nextCursor:cursor};
  }
  summary():CatalogueSummary {
    this.assertAvailable();
    const works=asNumber((this.db.prepare('SELECT count(*) n FROM works WHERE deleted_at IS NULL').get() as Row).n);
    const copies=asNumber((this.db.prepare('SELECT count(*) n FROM owned_copies WHERE deleted_at IS NULL').get() as Row).n);
    const ownedWorks=asNumber((this.db.prepare('SELECT count(DISTINCT ec.work_id) n FROM edition_contents ec JOIN editions e ON e.id=ec.edition_id JOIN owned_copies c ON c.edition_id=e.id WHERE e.deleted_at IS NULL AND c.deleted_at IS NULL').get() as Row).n);
    const spend=this.db.prepare(`SELECT a.currency_code,a.amount_minor FROM acquisitions a JOIN owned_copies c ON c.id=a.owned_copy_id WHERE c.deleted_at IS NULL AND a.amount_minor IS NOT NULL ORDER BY a.currency_code`).all() as Row[];
    const priced=asNumber((this.db.prepare('SELECT count(*) n FROM acquisitions a JOIN owned_copies c ON c.id=a.owned_copy_id WHERE c.deleted_at IS NULL AND amount_minor IS NOT NULL').get() as Row).n);
    const totals=new Map<string,{amount:bigint;count:number;free:number}>();
    for(const row of spend){const currency=String(row.currency_code);const total=totals.get(currency)??{amount:0n,count:0,free:0};const amount=BigInt(String(row.amount_minor));total.amount+=amount;total.count++;if(amount===0n)total.free++;totals.set(currency,total);}
    const grouped=[...totals.entries()].sort(([a],[b])=>a.localeCompare(b));
    return {contractVersion:1 as const,catalogueRevision:this.revision,workCount:works,ownedWorkCount:ownedWorks,copyCount:copies,pricedCopyCount:priced,unpricedCopyCount:copies-priced,freeCopyCount:grouped.reduce((n,[,x])=>n+x.free,0),spendByCurrency:grouped.map(([currency,x])=>({currency,amount:minorToDecimal(x.amount,currency)!,pricedCopyCount:x.count}))};
  }
}
function asNumber(v:unknown):number { const n=Number(v); if(!Number.isSafeInteger(n))throw new CatalogueError('SCHEMA_MISMATCH','Stored integer is outside the supported range.');return n; }
function jsonSafe<T>(value:T):T { return JSON.parse(JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v)) as T; }
function semanticJson(value:unknown):string {
  const clone=(v:unknown):unknown=>{
    if(Array.isArray(v))return v.map(clone);
    if(v&&typeof v==='object'){const out:Record<string,unknown>={};for(const [k,x] of Object.entries(v as Record<string,unknown>))if(!['created_at','updated_at','revision'].includes(k))out[k]=clone(x);return out;}
    return v;
  };
  return canonicalJson(clone(value));
}
function normalize(s:string){return s.normalize('NFKC').trim().toLowerCase();}
function assertCaller(caller:TrustedCaller){if(!caller||caller.origin!=='collector'||typeof caller.lineage!=='string'||caller.lineage.trim().length<1||caller.lineage.length>160)throw new CatalogueError('ACCESS_DENIED','Caller is unavailable.');}
function decodeTuplePosition(position:string,kind:string):[string,string]{if(!position)return['',''];try{const value=JSON.parse(position);if(Array.isArray(value)&&value.length===2&&value.every(x=>typeof x==='string'))return value as [string,string];}catch{/* invalid cursor */}throw new CatalogueError('INVALID_CURSOR',`${kind} cursor is invalid.`);}
function compareTuple(a:[string,string],b:[string,string]){return a[0]===b[0]?(a[1]<b[1]?-1:a[1]>b[1]?1:0):a[0]<b[0]?-1:1;}
function transactionError(error:unknown):CatalogueError {
  if(error instanceof CatalogueError)return error;
  const code=error&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):'';
  if(code.startsWith('SQLITE_CONSTRAINT'))return new CatalogueError('VALIDATION_FAILED','The requested catalogue change violates a uniqueness or relationship rule.');
  if(code==='SQLITE_BUSY'||code==='SQLITE_LOCKED')return new CatalogueError('APP_UNAVAILABLE','Catalogue is busy; retry with the same request ID.',true);
  return new CatalogueError('APP_UNAVAILABLE','Catalogue transaction failed and was rolled back.',true);
}
function conflict(kind:EntityKind,id:string,revision:number){return new CatalogueError('CONFLICT','Record changed; reload it and try again.',true,[{field:'expectedRevision',message:`Current ${kind} revision is ${revision}.`}],[{type:kind,id,revision}]);}
function kindForOperation(op:Operation):EntityKind { if(op.kind.endsWith('Work'))return 'work';if(op.kind.endsWith('Edition'))return 'edition';if(op.kind.endsWith('Copy'))return 'owned_copy';return 'format'; }
function prefixFor(op:Operation){if(op.kind==='createWork')return 'wrk';if(op.kind==='createEdition')return 'edn';if(op.kind==='createCopy')return 'cpy';return 'fmt';}
function resolveOperation(op:Operation,refs:Map<string,string>):Operation {
  const resolve=(value:string)=>value.startsWith('$')?refs.get(value)??(()=>{throw new CatalogueError('VALIDATION_FAILED','Temporary reference is unavailable.');})():value;
  if(op.kind==='createEdition')return {...op,contents:op.contents.map(c=>({...c,work:resolve(c.work)})),formats:op.formats.map(resolve)};
  if(op.kind==='createCopy')return {...op,edition:resolve(op.edition)};
  if(op.kind==='updateEdition')return {...op,patch:{...op.patch,...(op.patch.contents?{contents:op.patch.contents.map(c=>({...c,work:resolve(c.work)}))}:{}),...(op.patch.formats?{formats:op.patch.formats.map(resolve)}:{})}};
  if(op.kind==='updateCopy')return {...op,id:resolve(op.id),patch:{...op.patch,...(op.patch.edition?{edition:resolve(op.patch.edition)}:{})}};
  if(op.kind==='updateWork'||op.kind==='updateFormat'||op.kind==='deleteWork'||op.kind==='deleteEdition'||op.kind==='deleteCopy'||op.kind==='deleteFormat')return {...op,id:resolve(op.id)};
  return op;
}
