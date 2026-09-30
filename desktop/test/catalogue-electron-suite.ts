import { app } from 'electron';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { CatalogueStore } from '../src/core/catalogue/store';
import { CatalogueError } from '../src/core/catalogue/contracts';
import { preflight, initialize, SCHEMA_VERSION, APPLICATION_ID } from '../src/core/catalogue/migrations';
import { MAX_OPERATIONS, MAX_REQUEST_BYTES } from '../src/core/catalogue/contracts';
import { canonicalJson, validateRequest } from '../src/core/catalogue/validation';
import { isCalendarDate } from '../src/core/catalogue/calendar-date';
import { decimalToMinor } from '../src/core/catalogue/money';
import { registerCatalogueIpc } from '../src/main/catalogue-ipc';
import { CatalogueRuntime } from '../src/main/catalogue-runtime';

const caller={lineage:'synthetic-collector',origin:'collector'} as const;
const root=path.join(process.cwd(),`.synthetic-catalogue-harness-${process.pid}-${randomUUID()}`);
fs.mkdirSync(root,{recursive:true});
const production=path.join(root,'production','catalogue.sqlite3');
const diagnostic=path.join(root,'archivist-tt001-diagnostic');
let checks=0;
let seedElapsed=0;
let phase='bootstrap';
let diagnosticDb:Database.Database|undefined;
const measurements:Record<string,number>={};
function check(ok:boolean,name:string){assert.ok(ok,name);checks++;}
function expectCode(fn:()=>unknown,code:string){try{fn();}catch(e){assert.ok(e instanceof CatalogueError);assert.equal((e as CatalogueError).code,code);checks++;return;}throw new Error(`Expected ${code}`);}
async function expectCodeAsync(fn:()=>Promise<unknown>,code:string){try{await fn();}catch(e){assert.ok(e instanceof CatalogueError);assert.equal((e as CatalogueError).code,code);checks++;return;}throw new Error(`Expected ${code}`);}
function captureCode(fn:()=>unknown,code:string){try{fn();}catch(e){assert.ok(e instanceof CatalogueError);assert.equal((e as CatalogueError).code,code);checks++;return e as CatalogueError;}throw new Error(`Expected ${code}`);}
function req(requestId:string,operations:unknown[]){return {contractVersion:1,requestId,operations};}
function op(operationId:string,kind:string,values:Record<string,unknown>){const codes:Record<string,Record<string,string>>={film:{DVD:'dvd','Blu-ray':'bluray','4K UHD':'uhd',VHS:'vhs'},tv:{DVD:'dvd','Blu-ray':'bluray','4K UHD':'uhd',VHS:'vhs'},music:{CD:'cd',Vinyl:'vinyl',Cassette:'cassette'},game:{Disc:'disc',Cartridge:'cartridge'}};const builtinCode=kind==='createFormat'&&!values.builtinCode?codes[String(values.category)]?.[String(values.label)]:undefined;return {operationId,kind,...values,...(builtinCode?{builtinCode}:{})};}
function ref(receipt:Awaited<ReturnType<typeof CatalogueStore.open>> extends never?never:any,type:string,index=0){const refs=receipt.recordRefs.filter((x:any)=>x.type===type);assert.ok(refs[index]);return refs[index];}
function makeV1Fixture(databasePath:string,legacy:boolean){
  fs.mkdirSync(path.dirname(databasePath),{recursive:true});
  const source=fs.readFileSync(path.join(process.cwd(),'src/core/catalogue/migrations/001-initial.sql'),'utf8');
  const old='  origin_conversation_id TEXT, undo_of TEXT REFERENCES changesets(id) ON DELETE RESTRICT, origin_kind TEXT NOT NULL';
  const oldSchema=source.replace(old,'  undo_of TEXT REFERENCES changesets(id) ON DELETE RESTRICT, origin_kind TEXT NOT NULL');
  if(legacy&&oldSchema===source)throw new Error('Historical fixture SQL did not match its pinned form.');
  const db=new Database(databasePath);db.pragma(`application_id=${APPLICATION_ID}`);db.exec(legacy?oldSchema:source);
  db.prepare('INSERT INTO catalogue_state(singleton_id,catalogue_id,schema_version,catalogue_revision) VALUES(1,?,1,1)').run(legacy?'cat-legacy-synthetic':'cat-canonical-synthetic');
  db.prepare('INSERT INTO currencies(code,exponent,registry_version) VALUES(?,?,?)').run('GBP',2,'synthetic-registry');
  db.prepare(`INSERT INTO works(id,category,title,normalized_title,artist,manual_metadata,created_at,updated_at,revision,deleted_at) VALUES('w-synthetic','film','Synthetic legacy title','synthetic legacy title',NULL,'{}','2024-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z',1,NULL)`).run();
  db.prepare(`INSERT INTO editions(id,label,region,platform,created_at,updated_at,revision,deleted_at) VALUES('e-synthetic','Synthetic edition',NULL,NULL,'2024-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z',1,NULL)`).run();
  db.prepare(`INSERT INTO formats(id,category,label,normalized_label,builtin_code,created_at,updated_at,revision,deleted_at) VALUES('f-synthetic','film','DVD','dvd','dvd','2024-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z',1,NULL)`).run();
  db.prepare(`INSERT INTO edition_contents(id,edition_id,work_id,coverage_mode) VALUES('ec-synthetic','e-synthetic','w-synthetic','not_applicable')`).run();
  db.prepare(`INSERT INTO edition_formats(edition_id,format_id) VALUES('e-synthetic','f-synthetic')`).run();
  db.prepare(`INSERT INTO owned_copies(id,edition_id,label,condition,media_notes,packaging_notes,notes,shelf,created_at,updated_at,revision,deleted_at) VALUES('c-synthetic','e-synthetic',NULL,'good',NULL,NULL,'Synthetic receipt note','Shelf A','2024-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z',1,NULL)`).run();
  db.prepare(`INSERT INTO acquisitions(owned_copy_id,purchase_date,amount_minor,currency_code,retailer) VALUES('c-synthetic','2024-01-01',1250,'GBP','Synthetic shop')`).run();
  db.prepare(`INSERT INTO owned_copies(id,edition_id,label,condition,media_notes,packaging_notes,notes,shelf,created_at,updated_at,revision,deleted_at) VALUES('c-deleted-synthetic','e-synthetic',NULL,'very_good',NULL,NULL,'Synthetic deleted copy','Shelf B','2024-01-01T00:00:00.000Z','2024-01-02T00:00:00.000Z',2,'2024-01-02T00:00:00.000Z')`).run();
  const legacyRequest=req('legacy-receipt-request',[{operationId:'legacy-work',kind:'createWork',ref:'$work',category:'film',title:'Synthetic legacy title'}]);
  const request=canonicalJson(validateRequest(legacyRequest)),hash=createHash('sha256').update(request).digest('hex');
  const result=JSON.stringify({contractVersion:1,changesetId:'chg-synthetic',requestId:'legacy-receipt-request',catalogueRevision:1,recordRefs:[{type:'work',id:'w-synthetic',revision:1}],replayed:false});
  if(legacy)db.prepare(`INSERT INTO changesets(id,request_id,input_hash,principal_lineage,undo_of,origin_kind,status,request,result,created_at,applied_at) VALUES('chg-synthetic','legacy-receipt-request',?,'synthetic-collector',NULL,'collector','applied',?,?,?,?)`).run(hash,request,result,'2024-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z');
  else db.prepare(`INSERT INTO changesets(id,request_id,input_hash,principal_lineage,origin_conversation_id,undo_of,origin_kind,status,request,result,created_at,applied_at) VALUES('chg-synthetic','legacy-receipt-request',?,'synthetic-collector',NULL,NULL,'collector','applied',?,?,?,?)`).run(hash,request,result,'2024-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z');
  const after=JSON.stringify({id:'w-synthetic',category:'film',title:'Synthetic legacy title',normalized_title:'synthetic legacy title',artist:null,manual_metadata:'{}',created_at:'2024-01-01T00:00:00.000Z',updated_at:'2024-01-01T00:00:00.000Z',revision:1,deleted_at:null});
  db.prepare(`INSERT INTO change_items(changeset_id,sequence,entity_kind,entity_id,operation,before_json,after_json,before_revision,after_revision,dependencies_json) VALUES('chg-synthetic',0,'work','w-synthetic','create',NULL,?,NULL,1,'[]')`).run(after);
  const beforeDelete={record:{id:'c-deleted-synthetic',edition_id:'e-synthetic',label:null,condition:'very_good',media_notes:null,packaging_notes:null,notes:'Synthetic deleted copy',shelf:'Shelf B',created_at:'2024-01-01T00:00:00.000Z',updated_at:'2024-01-01T00:00:00.000Z',revision:'1',deleted_at:null},acquisition:null};
  const afterDelete={record:{...beforeDelete.record,updated_at:'2024-01-02T00:00:00.000Z',revision:'2',deleted_at:'2024-01-02T00:00:00.000Z'},acquisition:null};
  const deleteRequest=canonicalJson(validateRequest(req('legacy-delete-request',[{operationId:'delete-copy',kind:'deleteCopy',id:'c-deleted-synthetic',expectedRevision:1}]))),deleteHash=createHash('sha256').update(deleteRequest).digest('hex');
  const deleteResult=JSON.stringify({contractVersion:1,changesetId:'chg-delete-synthetic',requestId:'legacy-delete-request',catalogueRevision:1,recordRefs:[{type:'owned_copy',id:'c-deleted-synthetic',revision:2}],replayed:false});
  if(legacy)db.prepare(`INSERT INTO changesets(id,request_id,input_hash,principal_lineage,undo_of,origin_kind,status,request,result,created_at,applied_at) VALUES('chg-delete-synthetic','legacy-delete-request',?,'synthetic-collector',NULL,'collector','applied',?,?,?,?)`).run(deleteHash,deleteRequest,deleteResult,'2024-01-02T00:00:00.000Z','2024-01-02T00:00:00.000Z');
  else db.prepare(`INSERT INTO changesets(id,request_id,input_hash,principal_lineage,origin_conversation_id,undo_of,origin_kind,status,request,result,created_at,applied_at) VALUES('chg-delete-synthetic','legacy-delete-request',?,'synthetic-collector',NULL,NULL,'collector','applied',?,?,?,?)`).run(deleteHash,deleteRequest,deleteResult,'2024-01-02T00:00:00.000Z','2024-01-02T00:00:00.000Z');
  db.prepare(`INSERT INTO change_items(changeset_id,sequence,entity_kind,entity_id,operation,before_json,after_json,before_revision,after_revision,dependencies_json) VALUES('chg-delete-synthetic',0,'owned_copy','c-deleted-synthetic','delete',?,?,1,2,'[{"type":"edition","id":"e-synthetic"}]')`).run(JSON.stringify(beforeDelete),JSON.stringify(afterDelete));
  db.pragma('user_version=1');db.close();
}

async function reviewRegressionStores(base:string){
  const graph=await CatalogueStore.open({databasePath:path.join(base,'review-graph','catalogue.sqlite3')});
  try{
    const seed=graph.apply(caller,req('review-graph-seed',[
      op('work-one','createWork',{ref:'$work-one',category:'film',title:'Synthetic Graph One'}),op('work-two','createWork',{ref:'$work-two',category:'film',title:'Synthetic Graph Two'}),
      op('film-one','createFormat',{ref:'$film-one',category:'film',label:'Synthetic Film One'}),op('film-two','createFormat',{ref:'$film-two',category:'film',label:'Synthetic Film Two'}),op('tv-only','createFormat',{ref:'$tv-only',category:'tv',label:'Synthetic TV Only'}),
      op('edition','createEdition',{ref:'$edition',contents:[{work:'$work-one',coverage:'not_applicable'},{work:'$work-two',coverage:'not_applicable'}],formats:['$film-one','$film-two']})
    ]));
    const w1=ref(seed,'work',0),w2=ref(seed,'work',1),f1=ref(seed,'format',0),edition=ref(seed,'edition');
    expectCode(()=>graph.apply(caller,req('delete-one-linked-work',[op('delete-work','deleteWork',{id:w1.id,expectedRevision:1})])),'VALIDATION_FAILED');
    expectCode(()=>graph.apply(caller,req('delete-one-linked-format',[op('delete-format','deleteFormat',{id:f1.id,expectedRevision:1})])),'VALIDATION_FAILED');
    expectCode(()=>graph.apply(caller,req('add-unrelated-format',[op('bad-edition','createEdition',{ref:'$bad-edition',contents:[{work:w1.id,coverage:'not_applicable'}],formats:[ref(seed,'format',0).id,ref(seed,'format',2).id]})])),'VALIDATION_FAILED');
    const unlink=graph.apply(caller,req('unlink-before-delete',[op('unlink','updateEdition',{id:edition.id,expectedRevision:1,patch:{contents:[{work:w2.id,coverage:'not_applicable'}]}}),op('delete-unlinked','deleteWork',{id:w1.id,expectedRevision:1})]));
    check(unlink.recordRefs.length===2&&(graph.detail('edition',edition.id) as any).contents.length===1,'same-batch unlink permits deleting the formerly referenced work');
  }finally{graph.close();}

  const ranges=await CatalogueStore.open({databasePath:path.join(base,'review-range-money','catalogue.sqlite3')});
  try{
    ranges.apply(caller,req('range-money-seed',[
      op('work','createWork',{ref:'$work',category:'film',title:'Synthetic Range Work'}),op('format','createFormat',{ref:'$format',category:'film',label:'Synthetic Range Format'}),
      op('edition','createEdition',{ref:'$edition',contents:[{work:'$work',coverage:'not_applicable'}],formats:['$format']}),
      op('before','createCopy',{ref:'$before',edition:'$edition',condition:'good',acquisition:{date:'2025-01-01',amount:'92233720368547758.07',currency:'USD'}}),
      op('after','createCopy',{ref:'$after',edition:'$edition',condition:'good',acquisition:{date:'2027-01-01',amount:'92233720368547758.07',currency:'USD'}})
    ]));
    check(ranges.search({purchaseDateFrom:'2026-01-01',purchaseDateTo:'2026-12-31'}).items.length===0,'purchase date range requires one acquisition within both bounds');
    check(ranges.summary().spendByCurrency.find(x=>x.currency==='USD')?.amount==='184467440737095516.14','currency spend uses exact BigInt accumulation beyond SQLite int64');
  }finally{ranges.close();}

  const releases=await CatalogueStore.open({databasePath:path.join(base,'review-releases','catalogue.sqlite3')});
  try{
    const seed=releases.apply(caller,req('release-seed',[
      op('work','createWork',{ref:'$work',category:'film',title:'Synthetic Release Revision'}),op('format-a','createFormat',{ref:'$format-a',category:'film',label:'Synthetic Release A'}),op('format-b','createFormat',{ref:'$format-b',category:'film',label:'Synthetic Release B'}),
      op('edition-a','createEdition',{ref:'$edition-a',contents:[{work:'$work',coverage:'not_applicable'}],formats:['$format-a']}),op('edition-b','createEdition',{ref:'$edition-b',contents:[{work:'$work',coverage:'not_applicable'}],formats:['$format-b']}),
      op('copy','createCopy',{ref:'$copy',edition:'$edition-a',condition:'good'})
    ]));
    const ea=ref(seed,'edition',0),eb=ref(seed,'edition',1),copy=ref(seed,'owned_copy');
    expectCode(()=>releases.apply(caller,req('stale-existing-release-create',[op('copy','createCopy',{ref:'$copy-stale',edition:ea.id,expectedEditionRevision:2,condition:'good'})])),'CONFLICT');
    expectCode(()=>releases.apply(caller,req('stale-source-release-move',[op('move','updateCopy',{id:copy.id,expectedRevision:1,expectedSourceEditionRevision:2,expectedTargetEditionRevision:1,patch:{edition:eb.id}})])),'CONFLICT');
    expectCode(()=>releases.apply(caller,req('stale-target-release-move',[op('move','updateCopy',{id:copy.id,expectedRevision:1,expectedSourceEditionRevision:1,expectedTargetEditionRevision:2,patch:{edition:eb.id}})])),'CONFLICT');
    const moved=releases.apply(caller,req('same-batch-new-release-move',[
      op('edition-c','createEdition',{ref:'$edition-c',contents:[{work:ref(seed,'work').id,coverage:'not_applicable'}],formats:[ref(seed,'format',0).id]}),
      op('move-copy','updateCopy',{id:copy.id,expectedRevision:1,expectedSourceEditionRevision:1,patch:{edition:'$edition-c'}})
    ]));
    const movedCopy=releases.detail('owned_copy',copy.id) as any;
    check(movedCopy.record.editionId===ref(moved,'edition').id&&movedCopy.record.revision===2,'copy reassignment to a same-batch edition checks source revision and advances copy revision');
    releases.apply(caller,req('revise-source-release',[op('revise','updateEdition',{id:ea.id,expectedRevision:1,patch:{label:'Revised release A'}})]));
    expectCode(()=>releases.apply(caller,req('stale-after-release-edit',[op('copy','createCopy',{ref:'$copy-stale-after',edition:ea.id,expectedEditionRevision:1,condition:'good'})])),'CONFLICT');
  }finally{releases.close();}

  const undo=await CatalogueStore.open({databasePath:path.join(base,'review-undo-dependencies','catalogue.sqlite3')});
  try{
    const seed=undo.apply(caller,req('undo-dependency-seed',[
      op('work','createWork',{ref:'$work',category:'film',title:'Synthetic Undo Dependency'}),op('format','createFormat',{ref:'$format',category:'film',label:'Synthetic Undo Dependency Format'}),op('edition','createEdition',{ref:'$edition',contents:[{work:'$work',coverage:'not_applicable'}],formats:['$format']})
    ]));
    const edition=ref(seed,'edition'),format=ref(seed,'format'),work=ref(seed,'work');
    const staleEdition=captureCode(()=>undo.apply(caller,req('stale-edition-reference',[op('copy','createCopy',{ref:'$stale-copy',edition:edition.id,expectedEditionRevision:2,condition:'good'})])),'CONFLICT');
    check(JSON.stringify(staleEdition.toJSON().recordRefs)===JSON.stringify([{type:'edition',id:edition.id,revision:1}]),'stale existing-edition conflict includes its opaque reference and current numeric revision');
    const seededCopy=undo.apply(caller,req('copy-for-stale-revision',[op('copy','createCopy',{ref:'$stale-revision-copy',edition:edition.id,expectedEditionRevision:1,condition:'good'})]));
    const staleCopyId=ref(seededCopy,'owned_copy').id;
    const staleCopy=captureCode(()=>undo.apply(caller,req('stale-copy-reference',[op('move','updateCopy',{id:staleCopyId,expectedRevision:2,patch:{shelf:'Shelf'}})])),'CONFLICT');
    check(JSON.stringify(staleCopy.toJSON().recordRefs)===JSON.stringify([{type:'owned_copy',id:staleCopyId,revision:1}]),'stale copy conflict includes its opaque reference and current numeric revision');
    const editionEdit=undo.apply(caller,req('edition-label-edit',[op('edit','updateEdition',{id:edition.id,expectedRevision:1,patch:{label:'Edited release'}})]));
    undo.apply(caller,req('copy-created-after-edition-edit',[op('copy','createCopy',{ref:'$copy-after-edit',edition:edition.id,expectedEditionRevision:2,condition:'good'})]));
    let epoch=undo.revision;let receipts=Number((undo as any).db.prepare('SELECT count(*) n FROM changesets').get().n);
    expectCode(()=>undo.undo(caller,editionEdit.changesetId,'undo-edition-after-dependent-copy'),'CONFLICT');
    check(undo.revision===epoch&&Number((undo as any).db.prepare('SELECT count(*) n FROM changesets').get().n)===receipts,'blocked edition undo leaves epoch and receipt count unchanged');
    const formatEdit=undo.apply(caller,req('format-label-edit',[op('edit-format','updateFormat',{id:format.id,expectedRevision:1,patch:{label:'Edited format'}})]));
    undo.apply(caller,req('edition-created-after-format-edit',[op('new-edition','createEdition',{ref:'$new-edition',contents:[{work:work.id,coverage:'not_applicable'}],formats:[format.id]})]));
    epoch=undo.revision;receipts=Number((undo as any).db.prepare('SELECT count(*) n FROM changesets').get().n);
    expectCode(()=>undo.undo(caller,formatEdit.changesetId,'undo-format-after-dependent-edition'),'CONFLICT');
    check(undo.revision===epoch&&Number((undo as any).db.prepare('SELECT count(*) n FROM changesets').get().n)===receipts,'blocked format undo leaves epoch and receipt count unchanged');
  }finally{undo.close();}

  const groupedUndo=await CatalogueStore.open({databasePath:path.join(base,'review-grouped-undo-replay','catalogue.sqlite3')});
  let initialUndo:ReturnType<CatalogueStore['undo']>;
  try{
    const seed=groupedUndo.apply(caller,req('grouped-undo-sequence-seed',[
      op('work','createWork',{ref:'$work',category:'film',title:'Synthetic Grouped Undo Sequence'}),op('format','createFormat',{ref:'$format',category:'film',label:'Synthetic Sequence Format'}),op('edition','createEdition',{ref:'$edition',contents:[{work:'$work',coverage:'not_applicable'}],formats:['$format']})
    ]));
    const edition=ref(seed,'edition');
    const batch=groupedUndo.apply(caller,req('grouped-create-copy-then-edit-edition',[
      op('copy','createCopy',{ref:'$copy',edition:edition.id,expectedEditionRevision:1,condition:'good'}),
      op('edit-edition','updateEdition',{id:edition.id,expectedRevision:1,patch:{label:'Synthetic edited edition'}})
    ]));
    initialUndo=groupedUndo.undo(caller,batch.changesetId,'grouped-undo-inverse');
    const editionUndoDependencies=JSON.parse(String((groupedUndo as any).db.prepare("SELECT dependencies_json FROM change_items WHERE changeset_id=? AND entity_kind='edition'").get(initialUndo.changesetId).dependencies_json));
    check(editionUndoDependencies.length===0,'grouped undo persists edition dependencies from the final inverse graph');
  }finally{groupedUndo.close();}
  const reopenedUndo=await CatalogueStore.open({databasePath:path.join(base,'review-grouped-undo-replay','catalogue.sqlite3')});
  try{
    const reapplied=reopenedUndo.undo(caller,initialUndo!.changesetId,'redo-grouped-inverse');
    check(reopenedUndo.summary().copyCount===1&&(reopenedUndo.detail('edition',initialUndo!.recordRefs.find(x=>x.type==='edition')!.id) as any).record.label==='Synthetic edited edition','reopened inverse replay restores the grouped applied state');
    reopenedUndo.close();
    const finalReopen=await CatalogueStore.open({databasePath:path.join(base,'review-grouped-undo-replay','catalogue.sqlite3')});
    try{
      const replay=finalReopen.undo(caller,initialUndo!.changesetId,'redo-grouped-inverse');
      check(replay.replayed&&replay.changesetId===reapplied.changesetId,'same inverse request replays its original receipt after another reopen');
    }finally{finalReopen.close();}
  }finally{reopenedUndo.close();}
}

async function catalogueIpcEnvelopeCases(){
  const handlers=new Map<string,(event:any,...args:unknown[])=>Promise<any>>();
  let trusted=true;let runtime:any=undefined;let startupError:any=undefined;
  registerCatalogueIpc({handle:(channel,handler)=>handlers.set(channel,handler)},()=>trusted,()=>runtime,()=>startupError);
  const summary=handlers.get('catalogue:summary')!;
  const historyGet=handlers.get('catalogue:changes:get')!;
  let result=await summary({});
  check(!result.ok&&result.error.code==='APP_UNAVAILABLE'&&result.error.retryable===true,'unopened catalogue returns a typed retryable error');
  result=await summary({},'extra');
  check(!result.ok&&result.error.code==='VALIDATION_FAILED'&&result.error.retryable===false,'catalogue IPC rejects wrong arity with a typed error');
  result=await historyGet({},'synthetic-change-id',{});check(!result.ok&&result.error.code==='APP_UNAVAILABLE','history reads use the typed IPC runtime boundary');
  startupError={code:'SCHEMA_MISMATCH',message:'Catalogue database structure does not match a supported schema.',retryable:false};
  result=await summary({});check(!result.ok&&result.error.code==='SCHEMA_MISMATCH'&&result.error.message===startupError.message,'trusted IPC surfaces the safe catalogue startup reason');startupError=undefined;
  runtime={
    search:(request:any)=>request.query,
    detail:(kind:string,id:string)=>`${kind}:${id}`,
    copies:(request:any)=>request.workId,
    picker:(request:any)=>request.kind,
    formats:(request:any)=>request.exactLabel,
    lookups:()=>['lookups'],
    statistics:()=>['statistics'],
    changesList:(request:any)=>request.limit,
    changesGet:(id:string,request:any)=>`${id}:${request.limit}`
  };
  const routed:Array<[string,unknown[],unknown]>=[
    ['catalogue:search',[{query:'synthetic'}],'synthetic'],
    ['catalogue:detail',['work','synthetic-work'],'work:synthetic-work'],
    ['catalogue:copies',[{workId:'synthetic-work'}],'synthetic-work'],
    ['catalogue:picker',[{kind:'edition'}],'edition'],
    ['catalogue:formats',[{category:'film',exactLabel:'DVD'}],'DVD'],
    ['catalogue:lookups',[],['lookups']],
    ['catalogue:statistics',[],['statistics']],
    ['catalogue:changes:list',[{limit:7}],7],
    ['catalogue:changes:get',['synthetic-change',{limit:9}],'synthetic-change:9']
  ];
  for(const [channel,args,expected] of routed){const response=await handlers.get(channel)!({},...args);check(response.ok&&JSON.stringify(response.value)===JSON.stringify(expected),`${channel} routes its typed arguments through IPC`);}
  trusted=false;result=await summary({});
  check(!result.ok&&result.error.code==='ACCESS_DENIED'&&result.error.retryable===false,'untrusted catalogue IPC call is denied with typed error');trusted=true;
  runtime={summary:()=>{throw new Error('synthetic-secret-path');}};
  result=await summary({});
  check(!result.ok&&result.error.code==='APP_UNAVAILABLE'&&result.error.retryable===true&&!result.error.message.includes('synthetic-secret-path'),'unexpected catalogue exception is sanitized and retryable');
}

async function pickerCursorRegression(base:string){
  const store=await CatalogueStore.open({databasePath:path.join(base,'picker-cursors','catalogue.sqlite3')});
  try{
    const db=(store as any).db as Database.Database;const stamp='2024-01-01T00:00:00.000Z';
    const workRows=[['w-a','Zed'],['w-b','Alpha'],['w-c','Mango'],['w-d','Beta']] as const;
    for(const [id,title] of workRows)db.prepare('INSERT INTO works(id,category,title,normalized_title,artist,manual_metadata,created_at,updated_at,revision,deleted_at) VALUES(?,?,?,?,NULL,?,?,?,1,NULL)').run(id,'film',title,title.toLowerCase(),'{}',stamp,stamp);
    const editionRows=[['e-a','w-a'],['e-b','w-b'],['e-c','w-c'],['e-d','w-d']] as const;
    for(const [id,work] of editionRows){db.prepare('INSERT INTO editions(id,label,region,platform,created_at,updated_at,revision,deleted_at) VALUES(?,NULL,NULL,NULL,?,?,1,NULL)').run(id,stamp,stamp);db.prepare('INSERT INTO edition_contents(id,edition_id,work_id,coverage_mode) VALUES(?,?,? ,\'not_applicable\')').run(`ec-${id}`,id,work);}
    db.prepare('INSERT INTO formats(id,category,label,normalized_label,builtin_code,created_at,updated_at,revision,deleted_at) VALUES(?,\'film\',?,?,NULL,?,?,1,NULL)').run('z-format','Alpha custom','alpha custom',stamp,stamp);
    db.prepare('INSERT INTO formats(id,category,label,normalized_label,builtin_code,created_at,updated_at,revision,deleted_at) VALUES(?,\'film\',?,?,NULL,?,?,1,NULL)').run('a-format','Zeta custom','zeta custom',stamp,stamp);
    const workIds:string[]=[],editionIds:string[]=[];
    let page=store.picker({kind:'work',query:'',limit:1});
    while(true){assert.ok(page.items.length<=1);workIds.push(...page.items.map((x:any)=>x.id));if(!page.nextCursor)break;page=store.picker({kind:'work',query:'',limit:1,cursor:page.nextCursor});}
    check(workIds.length===4&&new Set(workIds).size===4&&workRows.map(x=>x[0]).every(id=>workIds.includes(id)),'work picker tuple cursor traverses title order without missing/repeating on empty query');
    page=store.picker({kind:'edition',query:'',limit:1});
    while(true){assert.ok(page.items.length<=1);editionIds.push(...page.items.map((x:any)=>x.id));if(!page.nextCursor)break;page=store.picker({kind:'edition',query:'',limit:1,cursor:page.nextCursor});}
    check(editionIds.length===4&&new Set(editionIds).size===4&&editionRows.map(x=>x[0]).every(id=>editionIds.includes(id)),'edition picker tuple cursor follows display sort rather than random IDs');
    const formatKeys:string[]=[];let formatPage=store.formats({category:'film',query:'',limit:1});
    while(true){assert.ok(formatPage.items.length<=1);formatKeys.push(...formatPage.items.map((x:any)=>x.builtinCode??x.id));if(!formatPage.nextCursor)break;formatPage=store.formats({category:'film',query:'',limit:1,cursor:formatPage.nextCursor});}
    check(formatKeys.length===6&&new Set(formatKeys).size===6&&['dvd','bluray','uhd','vhs','z-format','a-format'].every(id=>formatKeys.includes(id)),'format picker pages every canonical builtin and custom row within requested limit');
    const cursorStore=await CatalogueStore.open({databasePath:path.join(base,'picker-cursor-stale','catalogue.sqlite3')});
    try{cursorStore.apply(caller,req('picker-cursor-seed',[op('one','createWork',{ref:'$one',category:'film',title:'First picker row'}),op('two','createWork',{ref:'$two',category:'film',title:'Second picker row'})]));const first=cursorStore.picker({kind:'work',limit:1});assert.ok(first.nextCursor);cursorStore.apply(caller,req('picker-cursor-mutation',[op('work','createWork',{ref:'$new',category:'film',title:'New picker row'})]));expectCode(()=>cursorStore.picker({kind:'work',limit:1,cursor:first.nextCursor!}),'STALE_CURSOR');}finally{cursorStore.close();}
  }finally{store.close();}
}

async function recoveryChecks(base:string){
  phase='synthetic backup and restore';
  const sourcePath=path.join(base,'recovery-source','catalogue.sqlite3');
  const backupDirectory=path.join(base,'recovery-export.backup');
  const source=await CatalogueStore.open({databasePath:sourcePath});
  const seedRequest=req('recovery-source-seed',[
    op('recovery-work','createWork',{ref:'$work',category:'film',title:'Synthetic Recovery Work'}),
    op('recovery-format','createFormat',{ref:'$format',category:'film',label:'DVD'}),
    op('recovery-edition','createEdition',{ref:'$edition',contents:[{work:'$work',coverage:'not_applicable'}],formats:['$format']}),
    op('recovery-copy','createCopy',{ref:'$copy',edition:'$edition',condition:'good',acquisition:{date:'2026-09-29',amount:'12.34',currency:'GBP',retailer:'Synthetic shop'}})
  ]);
  const seeded=source.apply(caller,seedRequest);
  const sourceCopy=ref(seeded,'owned_copy');
  const deleted=source.apply(caller,req('recovery-source-delete',[op('recovery-delete','deleteCopy',{id:sourceCopy.id,expectedRevision:1})]));
  const preBackupUndoTarget=source.apply(caller,req('recovery-prebackup-work',[
    op('prebackup-work','createWork',{ref:'$prebackup-work',category:'film',title:'Synthetic Prebackup Undo'})
  ]));
  const preBackupUndo=source.undo(caller,preBackupUndoTarget.changesetId,'recovery-prebackup-undo');
  const manifest=await source.createBackup(backupDirectory);
  check(manifest.format==='archivist-sqlite-backup'&&manifest.schemaVersion===SCHEMA_VERSION&&manifest.snapshot.file==='catalogue.sqlite3','backup writes a versioned SQLite snapshot manifest');
  const backupPreview=await source.previewBackup(backupDirectory);
  check(backupPreview.schemaVersion===SCHEMA_VERSION&&backupPreview.totals.workCount===manifest.totals.workCount&&backupPreview.changeHistoryIncluded&&!backupPreview.conversationsIncluded&&source.summary().catalogueRevision===manifest.totals.catalogueRevision,'read-only restore preview validates a current-schema bundle without mutating the source catalogue');
  check(manifest.inclusions.changeHistory&&manifest.inclusions.catalogue&&!manifest.inclusions.conversations&&!manifest.inclusions.credentials&&!manifest.inclusions.sessions&&!manifest.inclusions.runtimeAuthority,'backup records history inclusion and authority/conversation exclusions');
  check(manifest.totals.catalogueRevision===4&&manifest.totals.workCount===1&&manifest.totals.copyCount===0&&manifest.totals.spendByCurrency.length===0,'manifest totals reflect the consistent post-delete and pre-backup undo snapshot');
  const archived=new Database(path.join(backupDirectory,'catalogue.sqlite3'),{readonly:true,fileMustExist:true});
  const archivedAuthority=archived.prepare('SELECT count(*) AS n FROM changesets WHERE principal_lineage<>? OR origin_conversation_id IS NOT NULL').get('archivist-backup-v1') as any;
  const archivedTables=(archived.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map(x=>x.name);
  check(Number(archivedAuthority.n)===0&&archivedTables.length===12&&!archivedTables.includes('conversations')&&!archivedTables.includes('messages'),'backup sanitizes runtime lineage and contains only the approved catalogue tables');
  archived.close();
  source.close();

  const targetPath=path.join(base,'recovery-target','catalogue.sqlite3');
  const target=await CatalogueStore.open({databasePath:targetPath});
  target.apply(caller,req('recovery-target-seed',[op('target-work','createWork',{ref:'$target',category:'game',title:'Synthetic Previous Catalogue'})]));
  const restorePending=target.restoreBackup(backupDirectory);
  expectCode(()=>target.apply(caller,req('blocked-during-restore',[op('blocked-work','createWork',{ref:'$blocked',category:'game',title:'Synthetic blocked write'})])),'APP_UNAVAILABLE');
  const restored=await restorePending;
  const restoredCaller={lineage:`desktop-local-collector:${target.catalogueId}`,origin:'collector'} as const;
  const recoveredWork=target.search({query:'Synthetic Recovery Work'}).items[0];
  check(!!recoveredWork&&recoveredWork.id===ref(seeded,'work').id,'restore preserves stable record IDs while replacing the current catalogue');
  check(target.summary().catalogueRevision===manifest.totals.catalogueRevision&&target.summary().copyCount===0,'restore reopens the replacement with matching revision and totals');
  check(target.historyList({limit:10},restoredCaller).items.length===4,'restored change history includes the pre-backup undo under the new local collector authority');
  check(!!restored.currentBackupDirectory&&fs.existsSync(path.join(restored.currentBackupDirectory,'manifest.json')),'restore preserves a consistent backup of the previous catalogue');
  const replay=target.apply(restoredCaller,seedRequest);
  check(replay.replayed&&replay.changesetId===seeded.changesetId,'restored request receipt remains replayable after authority rebinding');
  const undoReplay=target.undo(restoredCaller,preBackupUndoTarget.changesetId,'recovery-prebackup-undo');
  check(undoReplay.replayed&&undoReplay.changesetId===preBackupUndo.changesetId,'restored undo request retains its canonical hash and replays the original undo receipt');
  check(target.historyGet(preBackupUndoTarget.changesetId,{limit:10},restoredCaller).status==='undone'&&target.historyGet(preBackupUndo.changesetId,{limit:10},restoredCaller).undoOf===preBackupUndoTarget.changesetId,'restored history links the undo receipt to its original change');
  target.undo(restoredCaller,deleted.changesetId,'recovery-delete-undo');
  check(target.summary().copyCount===1&&target.detail('owned_copy',sourceCopy.id).type==='owned_copy','restored tombstone and undo history recover the deleted copy');
  target.close();
  const reopened=await CatalogueStore.open({databasePath:targetPath});
  const reopenedCaller={lineage:`desktop-local-collector:${reopened.catalogueId}`,origin:'collector'} as const;
  check(reopened.summary().copyCount===1&&reopened.historyList({limit:10},reopenedCaller).items.length===5,'restored and undone state persists after close and reopen');

  const cloneBundle=(name:string)=>{
    const destination=path.join(base,`${name}.backup`);
    fs.cpSync(backupDirectory,destination,{recursive:true,errorOnExist:true});
    return destination;
  };
  const readManifest=(directory:string)=>JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const writeManifest=(directory:string,value:unknown)=>fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(value));
  const refreshSnapshotIntegrity=(directory:string)=>{
    const snapshotPath=path.join(directory,'catalogue.sqlite3');
    const value=readManifest(directory);
    value.snapshot.sizeBytes=fs.statSync(snapshotPath).size;
    value.snapshot.sha256=createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
    writeManifest(directory,value);
  };
  const assertTargetUnchanged=()=>{
    const db=new Database(targetPath,{readonly:true,fileMustExist:true});
    const title=(db.prepare("SELECT title FROM works WHERE deleted_at IS NULL").get() as any)?.title;
    const workCount=(db.prepare("SELECT count(*) AS n FROM works WHERE deleted_at IS NULL").get() as any).n;
    db.close();
    check(title==='Synthetic Recovery Work'&&Number(workCount)===1,'rejected restore does not replace or merge into the current catalogue');
  };
  check((reopened as any).db.open===true,'restored catalogue connection remains open for refusal checks');
  phase='restore rejects unsafe manifest path';
  const badPath=cloneBundle('recovery-bad-path');
  const badPathManifest=readManifest(badPath);badPathManifest.snapshot.file='../outside.sqlite3';writeManifest(badPath,badPathManifest);
  await expectCodeAsync(()=>reopened.previewBackup(badPath),'RESTORE_INVALID');
  await expectCodeAsync(()=>reopened.restoreBackup(badPath),'RESTORE_INVALID');assertTargetUnchanged();
  phase='restore rejects invalid checksum';
  const badHash=cloneBundle('recovery-bad-hash');
  const badHashManifest=readManifest(badHash);badHashManifest.snapshot.sha256='0'.repeat(64);writeManifest(badHash,badHashManifest);
  await expectCodeAsync(()=>reopened.restoreBackup(badHash),'RESTORE_INVALID');assertTargetUnchanged();
  phase='restore rejects size mismatch';
  const badSize=cloneBundle('recovery-bad-size');
  const badSizeManifest=readManifest(badSize);badSizeManifest.snapshot.sizeBytes++;writeManifest(badSize,badSizeManifest);
  await expectCodeAsync(()=>reopened.restoreBackup(badSize),'RESTORE_INVALID');assertTargetUnchanged();
  phase='restore rejects unknown bundle member';
  const extraMember=cloneBundle('recovery-extra-member');fs.writeFileSync(path.join(extraMember,'unexpected.txt'),'synthetic');
  await expectCodeAsync(()=>reopened.restoreBackup(extraMember),'RESTORE_INVALID');assertTargetUnchanged();
  phase='restore rejects total mismatch';
  const badTotals=cloneBundle('recovery-bad-totals');
  const badTotalsManifest=readManifest(badTotals);badTotalsManifest.totals.workCount++;writeManifest(badTotals,badTotalsManifest);
  await expectCodeAsync(()=>reopened.restoreBackup(badTotals),'SCHEMA_MISMATCH');assertTargetUnchanged();
  phase='restore rejects broken foreign key';
  const badReference=cloneBundle('recovery-bad-reference');
  const badReferenceDb=new Database(path.join(badReference,'catalogue.sqlite3'));badReferenceDb.pragma('foreign_keys = OFF');
  badReferenceDb.prepare('INSERT INTO edition_formats(edition_id,format_id) VALUES(?,?)').run(ref(seeded,'edition').id,'missing-synthetic-format');badReferenceDb.close();
  refreshSnapshotIntegrity(badReference);
  await expectCodeAsync(()=>reopened.restoreBackup(badReference),'SCHEMA_MISMATCH');assertTargetUnchanged();
  phase='restore rejects invalid active graph';
  const badGraph=cloneBundle('recovery-bad-graph');
  const badGraphDb=new Database(path.join(badGraph,'catalogue.sqlite3'));
  badGraphDb.prepare('DELETE FROM edition_formats WHERE edition_id=?').run(ref(seeded,'edition').id);badGraphDb.close();
  refreshSnapshotIntegrity(badGraph);
  await expectCodeAsync(()=>reopened.restoreBackup(badGraph),'SCHEMA_MISMATCH');assertTargetUnchanged();
  phase='restore rejects invalid revisions';
  const badRevision=cloneBundle('recovery-bad-revision');
  const badRevisionDb=new Database(path.join(badRevision,'catalogue.sqlite3'));
  badRevisionDb.pragma('ignore_check_constraints = ON');
  badRevisionDb.prepare('UPDATE works SET revision=0 WHERE id=?').run(ref(seeded,'work').id);badRevisionDb.close();
  refreshSnapshotIntegrity(badRevision);
  await expectCodeAsync(()=>reopened.restoreBackup(badRevision),'SCHEMA_MISMATCH');assertTargetUnchanged();
  phase='restore rejects mismatched undo request target';
  const badUndoTarget=cloneBundle('recovery-bad-undo-target');
  const badUndoTargetDb=new Database(path.join(badUndoTarget,'catalogue.sqlite3'));
  const alteredUndo=JSON.parse((badUndoTargetDb.prepare('SELECT request FROM changesets WHERE request_id=?').get('recovery-prebackup-undo') as any).request);
  alteredUndo.undoOf='missing-synthetic-changeset';
  const alteredUndoRequest=canonicalJson(alteredUndo);
  const alteredUndoHash=createHash('sha256').update(alteredUndoRequest).digest('hex');
  badUndoTargetDb.prepare('UPDATE changesets SET request=?,input_hash=? WHERE request_id=?').run(alteredUndoRequest,alteredUndoHash,'recovery-prebackup-undo');
  badUndoTargetDb.close();
  refreshSnapshotIntegrity(badUndoTarget);
  await expectCodeAsync(()=>reopened.restoreBackup(badUndoTarget),'SCHEMA_MISMATCH');assertTargetUnchanged();
  phase='restore rejects invalid undo request hash';
  const badUndoHash=cloneBundle('recovery-bad-undo-hash');
  const badUndoHashDb=new Database(path.join(badUndoHash,'catalogue.sqlite3'));
  badUndoHashDb.prepare('UPDATE changesets SET input_hash=? WHERE request_id=?').run('0'.repeat(64),'recovery-prebackup-undo');
  badUndoHashDb.close();
  refreshSnapshotIntegrity(badUndoHash);
  await expectCodeAsync(()=>reopened.restoreBackup(badUndoHash),'SCHEMA_MISMATCH');assertTargetUnchanged();
  phase='restore rejects newer schema';
  const newerSchema=cloneBundle('recovery-newer-schema');
  const newerSchemaDb=new Database(path.join(newerSchema,'catalogue.sqlite3'));newerSchemaDb.pragma('user_version=3');newerSchemaDb.close();
  refreshSnapshotIntegrity(newerSchema);
  await expectCodeAsync(()=>reopened.restoreBackup(newerSchema),'SCHEMA_NEWER');assertTargetUnchanged();
  phase='restore rejects unknown schema shape';
  const unknownSchema=cloneBundle('recovery-unknown-schema');
  const unknownSchemaDb=new Database(path.join(unknownSchema,'catalogue.sqlite3'));unknownSchemaDb.exec('ALTER TABLE works ADD COLUMN unexpected TEXT');unknownSchemaDb.close();
  refreshSnapshotIntegrity(unknownSchema);
  await expectCodeAsync(()=>reopened.restoreBackup(unknownSchema),'SCHEMA_MISMATCH');assertTargetUnchanged();
  phase='backup refuses overwrite';
  await expectCodeAsync(()=>reopened.createBackup(backupDirectory),'BACKUP_FAILED');
  reopened.close();

  phase='production runtime recovery seam';
  const runtimeSource=await CatalogueRuntime.open({userDataPath:path.join(base,'runtime-source')});
  const runtimeReceipt=runtimeSource.apply(req('runtime-recovery-seed',[
    op('runtime-work','createWork',{ref:'$runtime-work',category:'music',title:'Synthetic Runtime Recovery'})
  ]));
  const runtimeBackup=path.join(base,'runtime-export.backup');
  await runtimeSource.createBackup(runtimeBackup);
  runtimeSource.close();
  const runtimeTarget=await CatalogueRuntime.open({userDataPath:path.join(base,'runtime-target')});
  runtimeTarget.apply(req('runtime-target-seed',[
    op('runtime-old','createWork',{ref:'$old',category:'game',title:'Synthetic Runtime Previous'})
  ]));
  await runtimeTarget.restoreBackup(runtimeBackup);
  check(runtimeTarget.summary().workCount===1&&runtimeTarget.search({query:'Synthetic Runtime Recovery'}).items[0]?.id===ref(runtimeReceipt,'work').id,'main-process runtime backup and restore use the same production catalogue surface');
  check(runtimeTarget.changesList({limit:10}).items.some((item:any)=>item.id===runtimeReceipt.changesetId),'runtime recalculates trusted collector lineage after restore for history and undo access');
  runtimeTarget.close();

  for(const point of ['after-marker','after-preserve','after-install'] as const){
    phase=`restore interruption ${point}`;
    const databasePath=path.join(base,`interrupted-${point}`,'catalogue.sqlite3');
    const interrupted=await CatalogueStore.open({databasePath});
    interrupted.apply(caller,req(`interrupted-${point}-seed`,[
      op('interrupted-work','createWork',{ref:'$work',category:'game',title:`Synthetic original ${point}`})
    ]));
    await expectCodeAsync(()=>interrupted.restoreBackup(backupDirectory,{injectFailureAt:point}),'RESTORE_INTERRUPTED');
    interrupted.close();
    const afterCrash=await CatalogueStore.open({databasePath});
    check(afterCrash.search({query:`Synthetic original ${point}`}).items.length===1&&afterCrash.search({query:'Synthetic Recovery Work'}).items.length===0,`startup rolls back ${point} interruption to the complete original catalogue`);
    check(!fs.existsSync(`${databasePath}.restore-marker.json`),'startup clears a recovered replacement marker');
    afterCrash.close();
  }
}

async function run(){
  app.setPath('userData',path.join(root,'app-user-data'));
  fs.mkdirSync(diagnostic,{recursive:true});
  diagnosticDb=new Database(path.join(diagnostic,'diagnostic.sqlite3'));
  diagnosticDb.exec("CREATE TABLE diagnostic_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO diagnostic_fixture VALUES (1,'synthetic-diagnostic-canary')");
  const failPath=path.join(root,'atomic','catalogue.sqlite3');
  const failing=await CatalogueStore.open({databasePath:failPath,injectFailureAfterWrite:2});
  const schemaNames=(failing as any).db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((x:any)=>x.name);
  check(schemaNames.length===12,'production schema has exactly twelve tables');
  check(schemaNames.join('|')==='acquisitions|catalogue_state|change_items|changesets|content_seasons|currencies|edition_contents|edition_formats|editions|formats|owned_copies|works','production table names match approved subset');
  check(Number((failing as any).db.pragma('user_version',{simple:true}))===SCHEMA_VERSION,'PRAGMA user_version is set');
  check(Number((failing as any).db.pragma('application_id',{simple:true}))===APPLICATION_ID,'SQLite application id is set');
  check(Number((failing as any).db.pragma('foreign_keys',{simple:true}))===1,'foreign keys are enabled');
  check(Number((failing as any).db.prepare('SELECT count(*) n FROM currencies').get().n)===165,'pinned SIX registry snapshot is seeded completely');
  check(Number((failing as any).db.prepare("SELECT count(*) n FROM currencies WHERE registry_version='ISO-4217-List-One-2026-09-17'").get().n)===165,'all supported currency exponents use the attributed registry version');
  const startRevision=failing.revision;
  const injected=req('rollback-one',[op('a','createWork',{ref:'$a',category:'film',title:'Synthetic rollback'}),op('b','createFormat',{ref:'$b',category:'film',label:'DVD'})]);
  let failed=false;try{failing.apply(caller,injected);}catch{failed=true;}
  check(failed,'injected command failure surfaced');
  check(failing.revision===startRevision,'failed transaction rolled back catalogue revision');
  failing.close();
  const failureReopen=await CatalogueStore.open({databasePath:failPath});
  check(failureReopen.summary().workCount===0,'failed transaction rolled back rows after reopen');
  check(Number((failureReopen as any).db.prepare('SELECT count(*) n FROM changesets').get().n)===0,'failed transaction rolled back receipt after reopen');
  failureReopen.close();

  phase='migration compatibility';
  const migrateFail=path.join(root,'migration-failure','catalogue.sqlite3');
  try{await CatalogueStore.open({databasePath:migrateFail,injectMigrationFailure:true});}catch{}
  const partial=new Database(migrateFail,{readonly:true});
  check(Number(partial.pragma('user_version',{simple:true}))===0,'failed initialization did not set user_version');
  check(Number((partial.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as any).n)===0,'failed initialization rolled back DDL atomically');
  partial.close();
  const legacyV1=path.join(root,'migration-legacy-v1','catalogue.sqlite3'),legacyBackup=path.join(root,'migration-legacy-v1','before-v2.bak');
  makeV1Fixture(legacyV1,true);check(preflight(legacyV1).variant==='v1-history-column-missing','read-only preflight recognizes the exact historical v1 variant');
  const legacyStore=await CatalogueStore.open({databasePath:legacyV1,backupPath:legacyBackup});
  check(Number((legacyStore as any).db.pragma('user_version',{simple:true}))===SCHEMA_VERSION&&legacyStore.summary().copyCount===1&&legacyStore.summary().spendByCurrency[0].amount==='12.50','legacy v1 upgrade preserves collection/acquisition data and advances to v2');
  const oldReplay=legacyStore.apply(caller,req('legacy-receipt-request',[{operationId:'legacy-work',kind:'createWork',ref:'$work',category:'film',title:'Synthetic legacy title'}]));
  check(oldReplay.replayed&&oldReplay.changesetId==='chg-synthetic'&&(legacyStore.detail('work','w-synthetic') as any).title==='Synthetic legacy title'&&legacyStore.historyGet('chg-synthetic',{limit:10},caller).changes[0].after.title==='Synthetic legacy title','legacy v1 upgrade preserves and replays its canonical receipt and history');
  const legacyUpdate=legacyStore.apply(caller,req('legacy-v2-update',[op('rename','updateWork',{id:'w-synthetic',expectedRevision:1,patch:{title:'Synthetic upgraded title'}})]));
  let legacyUndo:any;try{legacyUndo=legacyStore.undo(caller,legacyUpdate.changesetId,'legacy-v2-undo');}catch(error){throw new Error(`synthetic post-upgrade update undo failed: ${error instanceof Error?error.message:String(error)}`);}
  check(!legacyUndo.replayed&&(legacyStore.detail('work','w-synthetic') as any).title==='Synthetic legacy title','legacy v2 store supports post-upgrade apply and undo');
  let oldDeleteUndo:any;try{oldDeleteUndo=legacyStore.undo(caller,'chg-delete-synthetic','legacy-v2-undo-old-delete');}catch(error){throw new Error(`synthetic pre-upgrade delete undo failed: ${error instanceof Error?error.message:String(error)}`);}
  check(!oldDeleteUndo.replayed&&legacyStore.summary().copyCount===2&&(legacyStore.detail('owned_copy','c-deleted-synthetic') as any).record.shelf==='Shelf B','legacy v1 applied copy-delete receipt remains undoable after v2 migration');
  legacyStore.close();
  const legacyBackupDb=new Database(legacyBackup,{readonly:true,fileMustExist:true});
  check(Number(legacyBackupDb.pragma('user_version',{simple:true}))===1&&Number(legacyBackupDb.prepare("SELECT count(*) n FROM pragma_table_info('changesets') WHERE name='origin_conversation_id'").get().n)===0&&Number(legacyBackupDb.prepare('SELECT count(*) n FROM works').get().n)===1,'consistent legacy backup retains its original v1 schema and synthetic data');legacyBackupDb.close();
  const legacyUpgradedDb=new Database(legacyV1,{readonly:true});
  check(Number(legacyUpgradedDb.prepare("SELECT cid FROM pragma_table_info('changesets') WHERE name='origin_conversation_id'").get().cid)===11,'legacy v2 fingerprint records SQLite ALTER column order');legacyUpgradedDb.close();

  const canonicalV1=path.join(root,'migration-canonical-v1','catalogue.sqlite3'),canonicalBackup=path.join(root,'migration-canonical-v1','before-v2.bak');
  makeV1Fixture(canonicalV1,false);check(preflight(canonicalV1).variant==='v1-canonical','read-only preflight recognizes canonical accepted v1');
  const canonicalV1Store=await CatalogueStore.open({databasePath:canonicalV1,backupPath:canonicalBackup});
  const canonicalColumn=(canonicalV1Store as any).db.prepare("SELECT cid FROM pragma_table_info('changesets') WHERE name='origin_conversation_id'").get();
  check(Number((canonicalV1Store as any).db.pragma('user_version',{simple:true}))===SCHEMA_VERSION&&Number(canonicalColumn.cid)===4&&canonicalV1Store.summary().copyCount===1,'canonical v1 upgrades markers without duplicating its provenance column');canonicalV1Store.close();
  check(preflight(canonicalV1).variant==='v2-canonical','canonical v1 migration opens as canonical v2');

  const backupFailure=path.join(root,'migration-backup-failure','catalogue.sqlite3'),blockedBackup=path.join(root,'migration-backup-failure','existing-backup');
  makeV1Fixture(backupFailure,true);fs.mkdirSync(blockedBackup,{recursive:true});
  await expectCodeAsync(()=>CatalogueStore.open({databasePath:backupFailure,backupPath:blockedBackup}),'BACKUP_FAILED');
  const backupFailureDb=new Database(backupFailure,{readonly:true});check(Number(backupFailureDb.pragma('user_version',{simple:true}))===1&&Number(backupFailureDb.prepare("SELECT count(*) n FROM pragma_table_info('changesets') WHERE name='origin_conversation_id'").get().n)===0,'backup failure leaves legacy v1 untouched');backupFailureDb.close();

  const rollbackV1=path.join(root,'migration-rollback','catalogue.sqlite3'),rollbackBackup=path.join(root,'migration-rollback','before-v2.bak');
  makeV1Fixture(rollbackV1,true);await expectCodeAsync(()=>CatalogueStore.open({databasePath:rollbackV1,backupPath:rollbackBackup,injectMigrationFailure:true}),'MIGRATION_FAILED');
  const rollbackDb=new Database(rollbackV1,{readonly:true});check(Number(rollbackDb.pragma('user_version',{simple:true}))===1&&Number(rollbackDb.prepare("SELECT count(*) n FROM pragma_table_info('changesets') WHERE name='origin_conversation_id'").get().n)===0&&fs.existsSync(rollbackBackup),'injected v1 migration failure atomically retains source and backup');rollbackDb.close();

  const concurrentV1=path.join(root,'migration-preflight-race','catalogue.sqlite3'),concurrentBackup=path.join(root,'migration-preflight-race','before-v2.bak');
  makeV1Fixture(concurrentV1,true);await expectCodeAsync(()=>initialize(concurrentV1,{backupPath:concurrentBackup,afterBackupForTest:()=>{const changed=new Database(concurrentV1);changed.exec('ALTER TABLE works ADD COLUMN unexpected TEXT');changed.close();}}),'SCHEMA_MISMATCH');
  const concurrentDb=new Database(concurrentV1,{readonly:true});check(Number(concurrentDb.pragma('user_version',{simple:true}))===1&&Number(concurrentDb.prepare("SELECT count(*) n FROM pragma_table_info('changesets') WHERE name='origin_conversation_id'").get().n)===0,'writer metadata recheck rejects schema drift before migration writes');concurrentDb.close();

  const unexpectedV1=path.join(root,'migration-unknown-v1','catalogue.sqlite3');makeV1Fixture(unexpectedV1,true);const unknown=new Database(unexpectedV1);unknown.exec('ALTER TABLE works ADD COLUMN unexpected TEXT');unknown.close();
  expectCode(()=>preflight(unexpectedV1),'SCHEMA_MISMATCH');
  const negativeMarker=path.join(root,'negative-marker.sqlite3');const negative=new Database(negativeMarker);negative.pragma('user_version=-1');negative.close();expectCode(()=>preflight(negativeMarker),'SCHEMA_MISMATCH');
  const newerPath=path.join(root,'newer.sqlite3');const newer=new Database(newerPath);newer.pragma(`application_id=${APPLICATION_ID}`);newer.pragma(`user_version=${SCHEMA_VERSION+4}`);newer.exec('CREATE TABLE marker(value TEXT)');newer.close();
  expectCode(()=>preflight(newerPath),'SCHEMA_NEWER');
  const newerRead=new Database(newerPath,{readonly:true});check(Number(newerRead.pragma('user_version',{simple:true}))===SCHEMA_VERSION+4&&Number((newerRead.prepare("SELECT count(*) n FROM sqlite_master WHERE name='marker'").get() as any).n)===1,'newer-schema refusal leaves file and markers untouched');newerRead.close();
  const mismatchPath=path.join(root,'mismatch.sqlite3');const mismatch=new Database(mismatchPath);mismatch.pragma('application_id=12345');mismatch.exec('CREATE TABLE marker(value TEXT)');mismatch.close();
  expectCode(()=>preflight(mismatchPath),'SCHEMA_MISMATCH');
  const mismatchRead=new Database(mismatchPath,{readonly:true});check(Number(mismatchRead.pragma('application_id',{simple:true}))===12345&&Number((mismatchRead.prepare("SELECT count(*) n FROM sqlite_master WHERE name='marker'").get() as any).n)===1,'foreign-file refusal leaves file untouched');mismatchRead.close();
  const corruptPath=path.join(root,'corrupt.sqlite3');fs.writeFileSync(corruptPath,Buffer.from('synthetic not-a-sqlite database'));
  expectCode(()=>preflight(corruptPath),'SCHEMA_MISMATCH');

  const schemaPath=path.join(root,'schema-mismatch','catalogue.sqlite3');
  const schemaStore=await CatalogueStore.open({databasePath:schemaPath});schemaStore.close();
  const brokenSchema=new Database(schemaPath);brokenSchema.exec('ALTER TABLE works RENAME COLUMN normalized_title TO wrong_normalized_title');brokenSchema.close();
  const beforeSchemaCheck=new Database(schemaPath,{readonly:true});const beforeJournal=String(beforeSchemaCheck.pragma('journal_mode',{simple:true}));beforeSchemaCheck.close();
  expectCode(()=>preflight(schemaPath),'SCHEMA_MISMATCH');
  const afterSchemaCheck=new Database(schemaPath,{readonly:true});
  check(String(afterSchemaCheck.pragma('journal_mode',{simple:true}))===beforeJournal&&Number(afterSchemaCheck.pragma('user_version',{simple:true}))===SCHEMA_VERSION,'schema mismatch preflight leaves journal mode and version unchanged');afterSchemaCheck.close();

  phase='pre-existing core regressions';await reviewRegressionStores(root);phase='IPC envelope';await catalogueIpcEnvelopeCases();phase='picker cursor regressions';await pickerCursorRegression(root);

  phase='synthetic production catalogue';
  const store=await CatalogueStore.open({databasePath:production});
  const ops=[
    op('w-film-a','createWork',{ref:'$film-a',category:'film',title:'The Shared Release'}),
    op('w-film-b','createWork',{ref:'$film-b',category:'film',title:'The Second Film'}),
    op('f-dvd','createFormat',{ref:'$dvd',category:'film',label:'DVD'}),
    op('f-bluray','createFormat',{ref:'$bluray',category:'film',label:'Blu-ray'}),
    op('f-uhd','createFormat',{ref:'$uhd',category:'film',label:'4K UHD'}),
    op('f-vhs','createFormat',{ref:'$vhs',category:'film',label:'VHS'}),
    op('f-laser','createFormat',{ref:'$laserdisc',category:'film',label:'LaserDisc'}),
    op('e-box','createEdition',{ref:'$box',label:'Two-film box',contents:[{work:'$film-a',coverage:'not_applicable'},{work:'$film-b',coverage:'not_applicable'}],formats:['$dvd','$uhd','$laserdisc']}),
    op('c-one','createCopy',{ref:'$copy-one',edition:'$box',condition:'very_good',shelf:'A',acquisition:{date:'2026-03-29',amount:'25.00',currency:'GBP',retailer:'Synthetic shop'}}),
    op('c-two','createCopy',{ref:'$copy-two',edition:'$box',condition:'like_new',acquisition:{date:'2026-03-30',amount:'1200',currency:'JPY'}}),
    op('w-tv','createWork',{ref:'$tv',category:'tv',title:'Season Zero'}),
    op('f-tv','createFormat',{ref:'$tv-format',category:'tv',label:'TV Blu-ray'}),
    op('f-tv-dvd','createFormat',{ref:'$tv-dvd',category:'tv',label:'DVD',builtinCode:'dvd'}),
    op('e-tv','createEdition',{ref:'$tv-edition',contents:[{work:'$tv',coverage:'explicit',seasons:[0,1]}],formats:['$tv-format','$tv-dvd']}),
    op('c-tv','createCopy',{ref:'$tv-copy',edition:'$tv-edition',condition:'unknown',acquisition:{date:'2024-02-29',amount:null,currency:'GBP'}}),
    op('e-tv-complete-known','createEdition',{ref:'$tv-complete-known',contents:[{work:'$tv',coverage:'complete',seasons:[0,1]}],formats:['$tv-format']}),
    op('e-tv-complete-unknown','createEdition',{ref:'$tv-complete-unknown',contents:[{work:'$tv',coverage:'complete'}],formats:['$tv-format']}),
    op('e-tv-coverage-unknown','createEdition',{ref:'$tv-unknown',contents:[{work:'$tv',coverage:'unknown'}],formats:['$tv-format']}),
    op('c-tv-two','createCopy',{ref:'$tv-copy-two',edition:'$tv-edition',condition:'new',acquisition:{amount:'0',currency:'JPY'}}),
    op('c-tv-max','createCopy',{ref:'$tv-copy-max',edition:'$tv-edition',condition:'acceptable',acquisition:{amount:'92233720368547758.07',currency:'USD'}}),
    op('w-music','createWork',{ref:'$music',category:'music',title:'Three Decimal Album',artist:'Synthetic artist',metadata:{genres:['Ambient']}}),
    op('f-music','createFormat',{ref:'$vinyl',category:'music',label:'Vinyl'}),
    op('f-cd','createFormat',{ref:'$cd',category:'music',label:'CD'}),
    op('f-cassette','createFormat',{ref:'$cassette',category:'music',label:'Cassette'}),
    op('e-music','createEdition',{ref:'$music-edition',contents:[{work:'$music',coverage:'not_applicable'}],formats:['$vinyl']}),
    op('c-music','createCopy',{ref:'$music-copy',edition:'$music-edition',condition:'new',acquisition:{amount:'1.2345',currency:'CLF'}}),
    op('w-game','createWork',{ref:'$game',category:'game',title:'Three Decimal Cartridge'}),
    op('f-game','createFormat',{ref:'$cart',category:'game',label:'Cartridge'}),
    op('f-game-disc','createFormat',{ref:'$game-disc',category:'game',label:'Game disc'}),
    op('e-game','createEdition',{ref:'$game-edition',platform:'Synthetic platform',contents:[{work:'$game',coverage:'not_applicable'}],formats:['$cart']}),
    op('c-game','createCopy',{ref:'$game-copy',edition:'$game-edition',condition:'good',acquisition:{amount:'2.500',currency:'KWD'}}),
  ];
  const seedRequest=req('synthetic-catalogue-seed',ops);
  const t0=performance.now();
  const receipt=store.apply(caller,seedRequest);
  seedElapsed=Math.round(performance.now()-t0);
  measurements.seedRequestBytes=Buffer.byteLength(JSON.stringify(seedRequest));measurements.seedElapsedMs=seedElapsed;
  const seedStorage=(store as any).db.prepare(`SELECT length(request) AS request_bytes,length(result) AS result_bytes,(SELECT COALESCE(sum(COALESCE(length(before_json),0)+COALESCE(length(after_json),0)+length(dependencies_json)),0) FROM change_items WHERE changeset_id=changesets.id) AS snapshot_bytes FROM changesets WHERE id=?`).get(receipt.changesetId) as any;
  measurements.seedStoredRequestBytes=Number(seedStorage.request_bytes);measurements.seedReceiptBytes=Number(seedStorage.result_bytes);measurements.seedSnapshotBytes=Number(seedStorage.snapshot_bytes);
  check(receipt.catalogueRevision===1,'one changeset advances catalogue revision once');
  check(String((diagnosticDb!.prepare('SELECT value FROM diagnostic_fixture WHERE id=1').get() as any).value)==='synthetic-diagnostic-canary','production writes do not touch the TT-001 diagnostic profile');
  check(store.summary().workCount===5&&store.summary().copyCount===7&&store.summary().ownedWorkCount===5,'four-category duplicates and box set count distinct works/copies');
  check(store.summary().pricedCopyCount===6&&store.summary().unpricedCopyCount===1&&store.summary().freeCopyCount===1,'unknown, free and priced purchase counts remain separate');
  check(store.summary().spendByCurrency.map((x:any)=>x.currency).join(',')==='CLF,GBP,JPY,KWD,USD','spend reports independent currencies');
  check(store.summary().spendByCurrency.find((x:any)=>x.currency==='GBP').amount==='25.00','box cost is counted once per copy, not per included work/format');
  check(store.summary().spendByCurrency.find((x:any)=>x.currency==='USD').amount==='92233720368547758.07','int64 boundary amount round-trips through actual SQLite storage');
  const firstWork=ref(receipt,'work',0);const copyPage=store.copies({workId:firstWork.id,limit:1});
  check(copyPage.items.length===1&&!!copyPage.nextCursor,'copy-level browse is independently paginated');
  const secondCopyPage=store.copies({workId:firstWork.id,limit:1,cursor:copyPage.nextCursor!});
  check(secondCopyPage.items.length===1&&secondCopyPage.items[0].id!==copyPage.items[0].id&&!secondCopyPage.nextCursor,'copy page continues without nesting an unbounded owned-copy list');
  const picker=store.picker({kind:'work',query:'shared',limit:5});check(picker.items.length===1&&picker.items[0].id===firstWork.id,'typed picker finds existing works by title');
  const choices=store.formats({category:'film'});check(choices.items.some((x:any)=>x.builtin&&x.label==='DVD'&&x.id),'canonical built-in format lookup resolves a stored row');
  const stats=store.statistics();check(stats.copyCount===7&&stats.categoryMemberships.find((x:any)=>x.category==='film')?.copyCount===2&&stats.categoryMemberships.find((x:any)=>x.category==='tv')?.copyCount===3,'statistics report distinct global copies and overlapping category memberships');
  check(stats.formatMemberships.find((x:any)=>x.label==='DVD')?.copyCount===5,'statistics coalesce DVD memberships across film and TV format rows without multiplying copies');
  const exactDvd=store.formats({category:'film',exactLabel:'  ｄｖｄ  '});
  check(exactDvd.items.length===1&&exactDvd.items[0].builtin&&exactDvd.items[0].id===ref(receipt,'format',0).id,'exact normalized format lookup resolves the canonical category-specific built-in row');
  const filmDiscReceipt=store.apply(caller,req('film-disc-custom-format',[op('film-disc','createFormat',{ref:'$film-disc',category:'film',label:'Disc'})]));
  const filmDisc=ref(filmDiscReceipt,'format');
  const filmDiscChoice=store.formats({category:'film',exactLabel:'disc'});
  check(filmDiscChoice.items.length===1&&filmDiscChoice.items[0].id===filmDisc.id&&!filmDiscChoice.items[0].builtin,'a category may use a custom label that is built in only for another category');
  expectCode(()=>store.apply(caller,req('film-custom-renamed-builtin',[op('rename-film-disc','updateFormat',{id:filmDisc.id,expectedRevision:1,patch:{label:'DVD'}})])),'VALIDATION_FAILED');
  check((store.detail('format',filmDisc.id) as any).label==='Disc','custom format cannot be renamed to a category built-in label');
  expectCode(()=>store.formats({category:'film',exactLabel:' '}),'VALIDATION_FAILED');
  store.apply(caller,req('history-pagination-followup',[op('history-copy-edit','updateCopy',{id:ref(receipt,'owned_copy').id,expectedRevision:1,patch:{shelf:'History shelf'}})]));
  const historyPage=store.historyList({limit:1},caller);check(historyPage.items.length===1&&!!historyPage.nextCursor,'collector change history is capped and paginated');
  const historyPage2=store.historyList({limit:1,cursor:historyPage.nextCursor!},caller);check(historyPage2.items.length===1&&historyPage2.items[0].id!==historyPage.items[0].id,'change history summary cursor continues without repeats');
  const history=store.historyGet(receipt.changesetId,{limit:1},caller);check(history.changes.length===1&&!!history.nextCursor&&history.changes.every((x:any)=>!('request' in x)&&!('principal' in x)),'history detail returns allowlisted bounded change snapshots');
  const history2=store.historyGet(receipt.changesetId,{limit:1,cursor:history.nextCursor!},caller);check(history2.changes.length===1&&history2.changes[0].id!==history.changes[0].id,'history detail pages stable change-item sequences');
  const fullHistory=store.historyGet(receipt.changesetId,{limit:100},caller);
  check(['work','edition','format','owned_copy'].every(kind=>fullHistory.changes.some((x:any)=>x.kind===kind&&x.after?.deleted===false)),'all soft-deletable history projections expose an allowlisted deletion state');
  const copyProjection=fullHistory.changes.find((x:any)=>x.kind==='owned_copy')?.after;
  check(typeof copyProjection?.editionId==='string'&&!('deleted_at' in copyProjection),'owned-copy history exposes its typed release relation without raw deletion timestamps');
  expectCode(()=>store.copies({workId:firstWork.id,cursor:'tampered'}),'INVALID_CURSOR');
  expectCode(()=>store.picker({kind:'work',query:'title',path:'/private/profile'} as any),'VALIDATION_FAILED');
  expectCode(()=>store.picker({kind:'work',query:'x'.repeat(501)}),'VALIDATION_FAILED');
  const beforeFormatConflict=store.revision;expectCode(()=>store.apply(caller,req('builtin-conflict',[op('duplicate-dvd','createFormat',{ref:'$duplicate',category:'film',label:'DVD',builtinCode:'dvd'})])),'CONFLICT');
  check(store.revision===beforeFormatConflict,'canonical format lookup race conflict leaves the catalogue unchanged');
  expectCode(()=>store.apply(caller,req('builtin-mismatch',[op('bad-builtin','createFormat',{ref:'$bad',category:'film',label:'Blu-ray',builtinCode:'dvd'})])),'VALIDATION_FAILED');
  const tv=ref(receipt,'work',2);const tvDetail=store.detail('work',tv.id) as any;
  check(tvDetail.category==='tv','TV work persists');
  const tvCopy=ref(receipt,'owned_copy',2);const copyDetail=store.detail('owned_copy',tvCopy.id) as any;
  check(copyDetail.acquisition.date==='2024-02-29'&&copyDetail.acquisition.amount===null&&copyDetail.acquisition.currency==='GBP','calendar date and unknown amount/currency persist as typed purchase values');
  check(copyDetail.edition?.record.id===copyDetail.record.editionId&&copyDetail.edition?.contents[0].work?.title==='Season Zero','copy detail returns its shared edition and linked work');
  check(typeof copyDetail.record.revision==='number'&&typeof copyDetail.edition?.record.revision==='number'&&typeof copyDetail.acquisition.date==='string'&&copyDetail.acquisition.amount===null,'typed detail DTO uses numeric revisions and preserves unknown money');
  const tvEdition=ref(receipt,'edition',1);const tvEditionDetail=store.detail('edition',tvEdition.id) as any;
  check(tvEditionDetail.contents[0].seasons.join(',')==='0,1','explicit TV release preserves special season 0 and season 1');
  const coverageRows=(store as any).db.prepare(`SELECT ec.coverage_mode,count(cs.season_number) AS n FROM edition_contents ec LEFT JOIN content_seasons cs ON cs.content_id=ec.id WHERE ec.work_id=? GROUP BY ec.id ORDER BY ec.coverage_mode`).all(tv.id) as any[];
  check(coverageRows.some(x=>x.coverage_mode==='complete'&&Number(x.n)===0)&&coverageRows.some(x=>x.coverage_mode==='complete'&&Number(x.n)===2)&&coverageRows.some(x=>x.coverage_mode==='unknown'&&Number(x.n)===0),'complete TV coverage stores its fixed list or unknown list distinctly');
  const conditions=(store as any).db.prepare('SELECT DISTINCT condition FROM owned_copies WHERE deleted_at IS NULL ORDER BY condition').all().map((x:any)=>x.condition);
  check(conditions.join(',')==='acceptable,good,like_new,new,unknown,very_good','all six approved copy condition values persist');
  const filmEdition=ref(receipt,'edition',0);
  check(!receipt.affectedRecordRefs,'new edition receipt does not report pre-existing affected copies');
  check((store.detail('edition',filmEdition.id) as any).contents.length===2,'shared box edition retains both works');
  const laserdisc=ref(receipt,'format',4);
  phase='shared custom format update';
  const formatEdit=store.apply(caller,req('format-label-edit',[op('edit-format','updateFormat',{id:laserdisc.id,expectedRevision:1,patch:{label:'LaserDisc (collector label)'}})]));
  check(formatEdit.affectedRecordRefs?.length===2,'format edit identifies active copies through their shared edition');
  expectCode(()=>store.apply(caller,req('stale-format',[op('stale-format','updateFormat',{id:laserdisc.id,expectedRevision:1,patch:{label:'Stale LaserDisc'}})])),'CONFLICT');
  phase='shared edition update';
  const preEditionRevision=(store.detail('edition',filmEdition.id) as any).record.revision;
  let editionEdit:any;try{editionEdit=store.apply(caller,req('shared-edition-edit',[op('edit-shared','updateEdition',{id:filmEdition.id,expectedRevision:1,patch:{label:'Corrected shared release'}})]));}catch(error){throw new Error(`shared edition update failed at revision ${preEditionRevision}: ${error instanceof CatalogueError?JSON.stringify(error.toJSON()):error instanceof Error?error.message:String(error)}`);}
  check(editionEdit.affectedRecordRefs?.length===2,'shared edition edit reports both affected copies');
  expectCode(()=>store.apply(caller,req('stale-edition-content',[op('stale-shared','updateEdition',{id:filmEdition.id,expectedRevision:1,patch:{label:'Stale'}})])),'CONFLICT');
  check(isCalendarDate('2000-02-29')&&isCalendarDate('2024-02-29')&&!isCalendarDate('1900-02-29')&&!isCalendarDate('2023-02-29')&&!isCalendarDate('2026-02-30'),'Gregorian date boundaries are validated without timezone conversion');
  check(decimalToMinor('2.500','KWD').amountMinor===2500n&&decimalToMinor('1.2345','CLF').amountMinor===12345n&&decimalToMinor('0','JPY').amountMinor===0n,'0/3/4-decimal currency exponents round-trip to exact minor units');
  expectCode(()=>decimalToMinor('2.5010','KWD'),'VALIDATION_FAILED');
  expectCode(()=>decimalToMinor('-0.01','GBP'),'VALIDATION_FAILED');
  expectCode(()=>decimalToMinor('1',null),'VALIDATION_FAILED');
  expectCode(()=>decimalToMinor('1.00','ZZZ'),'VALIDATION_FAILED');
  expectCode(()=>decimalToMinor(1.25,'GBP'),'VALIDATION_FAILED');
  check(decimalToMinor('92233720368547758.07','USD').amountMinor===9223372036854775807n,'SQLite signed 64-bit maximum is accepted exactly');
  expectCode(()=>decimalToMinor('92233720368547758.08','USD'),'VALIDATION_FAILED');

  const replay=store.apply(caller,seedRequest);
  check(replay.replayed&&replay.changesetId===receipt.changesetId&&JSON.stringify(replay.recordRefs)===JSON.stringify(receipt.recordRefs),'same principal/request/body replays original IDs and receipt');
  expectCode(()=>store.apply({lineage:'other-synthetic-lineage',origin:'collector'},seedRequest),'IDEMPOTENCY_CONFLICT');
  expectCode(()=>store.apply(caller,req(seedRequest.requestId,[ops[0]])),'IDEMPOTENCY_CONFLICT');
  const one=ref(receipt,'owned_copy',6);
  check((store.detail('owned_copy',one.id) as any).acquisition.amount==='2.500','public copy detail preserves exact decimal-string money');
  const updated=store.apply(caller,req('copy-update',[op('shelf','updateCopy',{id:one.id,expectedRevision:1,patch:{shelf:'Shelf B'}})]));
  check(updated.recordRefs[0].revision===2,'effective copy update increments entity revision');
  expectCode(()=>store.apply(caller,req('copy-stale',[op('stale','updateCopy',{id:one.id,expectedRevision:1,patch:{shelf:'Shelf C'}})])),'CONFLICT');
  const epoch=store.revision;
  const noop=store.apply(caller,req('copy-noop',[op('noop','updateCopy',{id:one.id,expectedRevision:2,patch:{shelf:'Shelf B'}})]));
  check(noop.catalogueRevision===epoch+1&&noop.recordRefs[0].revision===2,'no-op receipt advances only the catalogue epoch');
  store.apply(caller,req('copy-later-edit',[op('later','updateCopy',{id:one.id,expectedRevision:2,patch:{shelf:'Shelf C'}})]));
  expectCode(()=>store.undo(caller,updated.changesetId,'undo-stale-edit'),'CONFLICT');

  expectCode(()=>store.apply(caller,req('bad-final-graph',[op('w-bad','createWork',{ref:'$bad-work',category:'film',title:'Bad relationship'}),op('f-bad','createFormat',{ref:'$bad-format',category:'tv',label:'Wrong category'}),op('e-bad','createEdition',{ref:'$bad-edition',contents:[{work:'$bad-work',coverage:'not_applicable'}],formats:['$bad-format']})])),'VALIDATION_FAILED');
  check(store.search({query:'Shared',limit:100}).items.length===1,'search returns title matches');
  const gameSearch=store.search({category:'game',limit:100}).items;
  check(gameSearch.length===1&&gameSearch[0].id===ref(receipt,'work',4).id,'category search returns the exact matching work reference');
  const filmDvdSearch=store.search({formatId:ref(receipt,'format',0).id,limit:100}).items;
  check(filmDvdSearch.length===2&&filmDvdSearch.some((x:any)=>x.id===firstWork.id)&&filmDvdSearch.some((x:any)=>x.id===ref(receipt,'work',1).id),'built-in format search returns every work on its shared edition');
  const tvDvdSearch=store.search({formatId:ref(receipt,'format',6).id,limit:100}).items;
  check(tvDvdSearch.length===1&&tvDvdSearch[0].id===ref(receipt,'work',2).id,'same DVD label in another category filters only that category-specific format');
  const customFormatSearch=store.search({formatId:laserdisc.id,limit:100}).items;
  check(customFormatSearch.length===2&&customFormatSearch.every((x:any)=>x.id===firstWork.id||x.id===ref(receipt,'work',1).id),'custom format search returns linked works after the format label is edited');
  check(store.search({genre:'ambient'}).items.some((x:any)=>x.title==='Three Decimal Album'),'search filters the typed genre field');
  check(store.search({genre:'mbi'}).items.some((x:any)=>x.title==='Three Decimal Album'),'genre search remains a case-insensitive substring match');
  check(store.search({purchaseDateFrom:'2026-03-30'}).items.some((x:any)=>x.title==='The Shared Release'),'search filters purchase dates without changing calendar days');
  const exactPurchaseDateSearch=store.search({purchaseDateFrom:'2026-03-30',purchaseDateTo:'2026-03-30',limit:100}).items;
  check(exactPurchaseDateSearch.length===2&&exactPurchaseDateSearch.every((x:any)=>x.id===firstWork.id||x.id===ref(receipt,'work',1).id),'inclusive exact purchase-date range finds all works linked to the matching shared package');
  const categoryFormatIntersection=store.search({category:'film',formatId:ref(receipt,'format',6).id,limit:100}).items;
  check(categoryFormatIntersection.length===0,'category and category-specific format filters intersect without cross-category matches');
  (store as any).db.prepare('UPDATE works SET manual_metadata=? WHERE id=?').run(JSON.stringify({genre:'Legacy Genre'}),ref(receipt,'work',1).id);
  const genreLookups=store.lookups().genres;
  check(genreLookups.includes('Ambient')&&genreLookups.includes('Legacy Genre'),'genre lookup includes active custom and legacy single-string genre values');
  check(store.search({limit:500}).items.length<=100,'search caps page size at the approved maximum of 100');
  const ordered=store.search({limit:100}).items.map((x:any)=>`${x.title.toLocaleLowerCase()}\0${x.id}`);
  check(ordered.join('|')===[...ordered].sort().join('|'),'search order is stable by normalized title then opaque ID');
  expectCode(()=>store.search({unexpected:'value'} as any),'VALIDATION_FAILED');
  const page=store.search({limit:1});
  if(page.nextCursor){const malformed=JSON.parse(Buffer.from(page.nextCursor,'base64url').toString());malformed.title=5;expectCode(()=>store.search({limit:1,cursor:Buffer.from(JSON.stringify(malformed)).toString('base64url')}),'INVALID_CURSOR');store.apply(caller,req('cursor-invalidated',[op('w-extra','createWork',{ref:'$extra',category:'film',title:'Cursor invalidator'})]));expectCode(()=>store.search({limit:1,cursor:page.nextCursor!}),'STALE_CURSOR');}
  const copyDelete=store.apply(caller,req('delete-one-copy',[op('delete-copy','deleteCopy',{id:ref(receipt,'owned_copy',1).id,expectedRevision:1})]));
  const deleteHistory=store.historyGet(copyDelete.changesetId,{limit:10},caller).changes[0];
  check((deleteHistory.before as any)?.deleted===false&&(deleteHistory.after as any)?.deleted===true,'copy deletion history distinguishes active from deleted snapshots');
  check(store.summary().copyCount===6,'deleting one duplicate copy preserves all shared records and the sibling');
  store.apply(caller,req('unrelated-copy-edit',[op('unrelated','updateCopy',{id:ref(receipt,'owned_copy',4).id,expectedRevision:1,patch:{shelf:'Unrelated shelf'}})]));
  const restore=store.undo(caller,copyDelete.changesetId,'undo-copy-delete');
  check(store.summary().copyCount===7&&store.detail('owned_copy',ref(receipt,'owned_copy',1).id)!==null,'undo restores only the named tombstoned copy');
  const undoneHistory=store.historyList({limit:100},caller);
  check(undoneHistory.items.find((x:any)=>x.id===copyDelete.changesetId)?.status==='undone'&&undoneHistory.items.find((x:any)=>x.id===restore.changesetId)?.status==='applied'&&store.historyGet(copyDelete.changesetId,{limit:10},caller).status==='undone','history projects durable undo state for the original and inverse changesets');
  const undoReplay=store.undo(caller,copyDelete.changesetId,'undo-copy-delete');
  check(undoReplay.replayed&&restore.changesetId===undoReplay.changesetId,'undo retry replays the original inverse receipt');
  const foreignLineage={lineage:'other-synthetic-collector',origin:'collector'} as const;
  const foreignChange=store.apply(foreignLineage,req('foreign-history-change',[op('foreign-work','createWork',{ref:'$foreign',category:'film',title:'Private synthetic work'})]));
  check(!store.historyList({limit:100},caller).items.some((x:any)=>x.id===foreignChange.changesetId),'collector history is scoped to the trusted local-collector lineage');
  expectCode(()=>store.historyGet(foreignChange.changesetId,{limit:10},caller),'NOT_FOUND');
  expectCode(()=>store.apply(caller,req('delete-shared-edition',[op('delete-edition','deleteEdition',{id:filmEdition.id,expectedRevision:2})])),'VALIDATION_FAILED');

  const grouped=req('grouped-create',[op('g-work','createWork',{ref:'$gwork',category:'film',title:'Grouped Undo'}),op('g-work-edit','updateWork',{id:'$gwork',expectedRevision:1,patch:{title:'Grouped Undo Updated'}}),op('g-format','createFormat',{ref:'$gformat',category:'film',label:'Grouped Disc'}),op('g-edition','createEdition',{ref:'$gedition',contents:[{work:'$gwork',coverage:'not_applicable'}],formats:['$gformat']}),op('g-copy','createCopy',{ref:'$gcopy',edition:'$gedition',condition:'good'})]);
  const groupedReceipt=store.apply(caller,grouped);
  check((store.detail('work',ref(groupedReceipt,'work').id) as any).title==='Grouped Undo Updated','batch can create and update a temporary record reference');
  const groupedCopy=ref(groupedReceipt,'owned_copy');
  const extraCopy=store.apply(caller,req('dependent-copy',[op('dep','createCopy',{ref:'$dep-copy',edition:ref(groupedReceipt,'edition').id,expectedEditionRevision:1,condition:'good'})]));
  expectCode(()=>store.undo(caller,groupedReceipt.changesetId,'undo-group-with-dependent'),'CONFLICT');
  check(store.detail('owned_copy',groupedCopy.id)!==null,'failed grouped undo is atomic');
  store.undo(caller,extraCopy.changesetId,'undo-dependent-copy');
  const groupedUndo=store.undo(caller,groupedReceipt.changesetId,'undo-group');
  check(groupedUndo.recordRefs.length===4,'grouped undo records inverse snapshots for all created records');

  const current=store;
  const savedReceipt=receipt;
  current.close();
  const reopened=await CatalogueStore.open({databasePath:production});
  const persisted=reopened.apply(caller,seedRequest);
  check(persisted.replayed&&persisted.changesetId===savedReceipt.changesetId,'receipt and generated IDs replay after close/reopen');
  check(reopened.summary().copyCount===7,'catalogue data persists after close/reopen');
  check((reopened as any).db.prepare('SELECT origin_conversation_id FROM changesets WHERE id=?').get(savedReceipt.changesetId).origin_conversation_id===null,'nullable conversation provenance is persisted without a conversations table dependency');
  reopened.close();

  const durablePath=path.join(root,'durable-delete-undo','catalogue.sqlite3');
  const durableStore=await CatalogueStore.open({databasePath:durablePath});
  const durableSeed=durableStore.apply(caller,req('durable-history-seed',[
    op('durable-work','createWork',{ref:'$durable-work',category:'film',title:'Synthetic durable history'}),
    op('durable-format','createFormat',{ref:'$durable-format',category:'film',label:'DVD'}),
    op('durable-edition','createEdition',{ref:'$durable-edition',contents:[{work:'$durable-work',coverage:'not_applicable'}],formats:['$durable-format']}),
    op('durable-copy','createCopy',{ref:'$durable-copy',edition:'$durable-edition',condition:'good'})
  ]));
  const durableCopy=ref(durableSeed,'owned_copy');
  const durableDelete=durableStore.apply(caller,req('durable-copy-delete',[op('delete','deleteCopy',{id:durableCopy.id,expectedRevision:1})]));
  durableStore.close();
  const durableReopened=await CatalogueStore.open({databasePath:durablePath});
  check(durableReopened.historyList({limit:10},caller).items.find((x:any)=>x.id===durableDelete.changesetId)?.status==='applied'&&durableReopened.historyGet(durableDelete.changesetId,{limit:10},caller).changes[0].after?.deleted===true,'durable delete history is available after close and reopen');
  durableReopened.undo(caller,durableDelete.changesetId,'durable-copy-undo-after-reopen');
  check(durableReopened.summary().copyCount===1&&durableReopened.historyGet(durableDelete.changesetId,{limit:10},caller).status==='undone','delete can be undone from durable history after close and reopen');
  durableReopened.close();

  const canonicalStore=await CatalogueStore.open({databasePath:path.join(root,'canonical-request','catalogue.sqlite3')});
  const canonicalOperation=op('canonical-work','createWork',{ref:'$canonical-work',category:'film',title:'Synthetic Canonical Hash'});
  const canonicalRequest=req('canonical-key-order',[canonicalOperation]);
  const firstCanonical=canonicalStore.apply(caller,canonicalRequest);
  const reorderedOperation=Object.fromEntries(Object.entries(canonicalOperation).reverse());
  const reorderedRequest={operations:[reorderedOperation],requestId:'canonical-key-order',contractVersion:1};
  const reorderedReceipt=canonicalStore.apply(caller,reorderedRequest);
  check(reorderedReceipt.replayed&&reorderedReceipt.changesetId===firstCanonical.changesetId,'canonical request hash ignores object key order while preserving replay IDs');
  canonicalStore.close();

  const opsLimit=Array.from({length:MAX_OPERATIONS+1},(_,i)=>op(`op${i}`,'createWork',{ref:`$work${i}`,category:'film',title:`Work ${i}`}));
  expectCode(()=>validateRequest(req('operations-limit',opsLimit)),'PAYLOAD_TOO_LARGE');
  expectCode(()=>validateRequest(req('prototype-kind',[op('bad-kind','toString',{})])),'VALIDATION_FAILED');
  expectCode(()=>validateRequest(req('undefined-property',[{...op('valid','createWork',{ref:'$valid',category:'film',title:'Synthetic valid'}),optional:undefined}])),'VALIDATION_FAILED');
  const opsAt=(count:number)=>Array.from({length:count},(_,i)=>op(`op${i}`,'createWork',{ref:`$work${i}`,category:'film',title:`Work ${i}`}));
  check(validateRequest(req('operations-below',opsAt(MAX_OPERATIONS-1))).operations.length===MAX_OPERATIONS-1,'operation count below cap is accepted');
  check(validateRequest(req('operations-at',opsAt(MAX_OPERATIONS))).operations.length===MAX_OPERATIONS,'operation count at cap is accepted');
  const batchPath=path.join(root,'max-operations','catalogue.sqlite3');const batchStore=await CatalogueStore.open({databasePath:batchPath});const batchRequest=req('measured-max-operations',opsAt(MAX_OPERATIONS));
  const batchStart=performance.now();const batchReceipt=batchStore.apply(caller,batchRequest);measurements.maxOperationsRequestBytes=Buffer.byteLength(JSON.stringify(batchRequest));measurements.maxOperationsElapsedMs=Math.round(performance.now()-batchStart);measurements.maxOperationsRecords=batchReceipt.recordRefs.length;batchStore.close();
  const payloadAtSize=(requestId:string,target:number)=>{const count=120;const build=(lengths:number[])=>req(requestId,lengths.map((length,i)=>op(`payload-${i}`,'createWork',{ref:`$payload${i}`,category:'film',title:`Payload ${i}`,metadata:{description:'x'.repeat(length)}})));const overhead=Buffer.byteLength(JSON.stringify(build(Array(count).fill(0))));const payloadBytes=target-overhead;const each=Math.floor(payloadBytes/count);const remainder=payloadBytes%count;assert.ok(each<=10000);return build(Array.from({length:count},(_,i)=>each+(i<remainder?1:0)));};
  const below=payloadAtSize('payload-below',MAX_REQUEST_BYTES-1);
  const at=payloadAtSize('payload-at',MAX_REQUEST_BYTES);
  const above=payloadAtSize('payload-above',MAX_REQUEST_BYTES+1);
  check(Buffer.byteLength(JSON.stringify(below))===MAX_REQUEST_BYTES-1&&!!validateRequest(below),'payload one byte below cap is accepted');
  check(Buffer.byteLength(JSON.stringify(at))===MAX_REQUEST_BYTES&&!!validateRequest(at),'payload at cap is accepted');
  expectCode(()=>validateRequest(above),'PAYLOAD_TOO_LARGE');
  const payloadPath=path.join(root,'max-payload','catalogue.sqlite3');const payloadStore=await CatalogueStore.open({databasePath:payloadPath});
  const payloadStart=performance.now();const payloadReceipt=payloadStore.apply(caller,at);measurements.maxPayloadRequestBytes=Buffer.byteLength(JSON.stringify(at));measurements.maxPayloadElapsedMs=Math.round(performance.now()-payloadStart);measurements.maxPayloadRecords=payloadReceipt.recordRefs.length;measurements.maxPayloadMainFileBytesBeforeClose=fs.statSync(payloadPath).size;measurements.maxPayloadWalBytes=fs.existsSync(`${payloadPath}-wal`)?fs.statSync(`${payloadPath}-wal`).size:0;
  const payloadStorage=(payloadStore as any).db.prepare(`SELECT length(request) AS request_bytes,length(result) AS result_bytes,(SELECT COALESCE(sum(COALESCE(length(before_json),0)+COALESCE(length(after_json),0)+length(dependencies_json)),0) FROM change_items WHERE changeset_id=changesets.id) AS snapshot_bytes FROM changesets WHERE id=?`).get(payloadReceipt.changesetId) as any;
  measurements.maxPayloadStoredRequestBytes=Number(payloadStorage.request_bytes);measurements.maxPayloadReceiptBytes=Number(payloadStorage.result_bytes);measurements.maxPayloadSnapshotBytes=Number(payloadStorage.snapshot_bytes);payloadStore.close();measurements.maxPayloadDbBytesAfterClose=fs.statSync(payloadPath).size;
  await recoveryChecks(path.join(root,'recovery'));
}
run().then(()=>{
  const versions=new Database(':memory:');
  const sqlite=(versions.prepare('SELECT sqlite_version() v').get() as any).v;
  versions.close();diagnosticDb?.close();
  console.log(JSON.stringify({result:'pass',runtime:{electron:process.versions.electron,node:process.versions.node,sqlite},checks,synthetic:true,dbBytes:fs.statSync(production).size,measurements,profile:'project-local-synthetic-only'}));
  try{fs.rmSync(root,{recursive:true,force:true});}catch{}
  app.quit();
}).catch((error)=>{
  console.error(JSON.stringify({result:'fail',checks,phase,error:error instanceof Error?{name:error.name,message:error.message,code:(error as any).code}:String(error)}));
  try{fs.rmSync(root,{recursive:true,force:true});}catch{}
  app.exit(1);
});
