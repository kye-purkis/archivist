import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CatalogueError, type CatalogueErrorShape } from '../core/catalogue/contracts';
import type { CatalogueBackupManifest, CatalogueRecoverySummary } from '../core/catalogue/recovery';
import type { CatalogueRuntime } from './catalogue-runtime';
import type { CatalogueApi, RestoreCompletionResult, SafeResult } from '../contracts/catalogue';

type InvokeEvent = Electron.IpcMainInvokeEvent;
type Handler = (event:InvokeEvent,...args:unknown[])=>Promise<SafeResult<unknown>>;
interface IpcHandlePort { handle(channel:string,listener:Handler):void; }
type RuntimePort = Pick<CatalogueRuntime,'apply'|'undo'|'search'|'detail'|'summary'|'copies'|'picker'|'formats'|'lookups'|'statistics'|'changesList'|'changesGet'|'createBackup'|'previewBackup'|'restoreBackup'>;
export interface RecoveryFolderPicker {
  chooseBackupParent():Promise<string|undefined>;
  chooseRestoreBundle():Promise<string|undefined>;
}
interface PendingRestorePreview { sourceDirectory:string; expiresAt:number; }
const success=<T>(value:T):SafeResult<T>=>({ok:true,value});
const error=(code:string,message:string,retryable=false):SafeResult<never>=>({ok:false,error:{code,message,retryable}});
function errorResult(reason:unknown,channel:string):CatalogueErrorShape {
  if(reason instanceof CatalogueError)return reason.toJSON();
  if(channel==='catalogue:backup:create')return {code:'APP_UNAVAILABLE',message:'Backup could not be created. The catalogue was not changed.',retryable:true};
  if(channel==='catalogue:restore:preview')return {code:'APP_UNAVAILABLE',message:'Backup could not be validated. Nothing was restored.',retryable:true};
  if(channel==='catalogue:restore:confirm')return {code:'APP_UNAVAILABLE',message:'Restore could not be completed. Check the catalogue status before retrying.',retryable:true};
  return {code:'APP_UNAVAILABLE',message:'Catalogue operation failed; retry with the same request ID.',retryable:true};
}
function recoverySummary(manifest:CatalogueBackupManifest|CatalogueRecoverySummary):CatalogueRecoverySummary {
  if('inclusions' in manifest) {
    return {
      formatVersion:manifest.formatVersion,
      createdAt:manifest.createdAt,
      schemaVersion:manifest.schemaVersion,
      totals:manifest.totals,
      changeHistoryIncluded:manifest.inclusions.changeHistory,
      conversationsIncluded:manifest.inclusions.conversations,
    };
  }
  return manifest;
}
function backupBundleName():string {
  const timestamp=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
  return `Archivist backup ${timestamp} ${randomUUID().slice(0,8)}`;
}
export function registerCatalogueIpc(
  ipc:IpcHandlePort,
  isTrusted:(event:InvokeEvent)=>boolean,
  getRuntime:()=>RuntimePort|undefined,
  getStartupError:()=>CatalogueErrorShape|undefined=()=>undefined,
  folderPicker?:RecoveryFolderPicker,
){
  const pendingRestorePreviews=new Map<string,PendingRestorePreview>();
  const register=(channel:`catalogue:${string}`,expectedArgs:number,operation:(runtime:RuntimePort,...args:unknown[])=>unknown|Promise<unknown>)=>{
    ipc.handle(channel,async(event,...args)=>{
      try{if(!isTrusted(event))return error('ACCESS_DENIED','Catalogue caller is unavailable.');}
      catch{return error('ACCESS_DENIED','Catalogue caller is unavailable.');}
      if(args.length!==expectedArgs)return error('VALIDATION_FAILED','Catalogue request arguments are invalid.');
      let runtime:RuntimePort|undefined;
      try{runtime=getRuntime();}catch{return error('APP_UNAVAILABLE','Catalogue is unavailable.',true);}
      if(!runtime){const startup=getStartupError();return startup?{ok:false,error:startup}:error('APP_UNAVAILABLE','Catalogue is unavailable.',true);}
      try{return success(await operation(runtime,...args));}
      catch(reason){return {ok:false,error:errorResult(reason,channel)};}
    });
  };
  register('catalogue:apply',1,(r,request)=>r.apply(request));
  register('catalogue:undo',2,(r,id,requestId)=>{if(typeof id!=='string'||typeof requestId!=='string')throw new CatalogueError('VALIDATION_FAILED','Undo request is invalid.');return r.undo(id,requestId);});
  register('catalogue:search',1,(r,request)=>r.search(request as Parameters<CatalogueApi['search']>[0]));
  register('catalogue:detail',2,(r,kind,id)=>r.detail(kind as Parameters<CatalogueApi['detail']>[0],id as string));
  register('catalogue:summary',0,r=>r.summary());
  register('catalogue:copies',1,(r,request)=>r.copies(request as Parameters<CatalogueApi['copies']>[0]));
  register('catalogue:picker',1,(r,request)=>r.picker(request as Parameters<CatalogueApi['picker']>[0]));
  register('catalogue:formats',1,(r,request)=>r.formats(request as Parameters<CatalogueApi['formats']>[0]));
  register('catalogue:lookups',0,r=>r.lookups());
  register('catalogue:statistics',0,r=>r.statistics());
  register('catalogue:changes:list',1,(r,request)=>r.changesList(request as Parameters<CatalogueApi['changesList']>[0]));
  register('catalogue:changes:get',2,(r,id,request)=>{if(typeof id!=='string')throw new CatalogueError('VALIDATION_FAILED','History item request is invalid.');return r.changesGet(id,request as Parameters<CatalogueApi['changesGet']>[1]);});
  register('catalogue:backup:create',0,async r=>{
    if(!folderPicker)throw new CatalogueError('APP_UNAVAILABLE','Backup folder selection is unavailable.',true);
    const parent=await folderPicker.chooseBackupParent();
    if(parent===undefined)return {status:'cancelled'};
    const bundleName=backupBundleName();
    const manifest=await r.createBackup(path.join(parent,bundleName));
    return {status:'created',bundleName,backup:recoverySummary(manifest)};
  });
  register('catalogue:restore:preview',0,async r=>{
    if(!folderPicker)throw new CatalogueError('APP_UNAVAILABLE','Restore folder selection is unavailable.',true);
    const sourceDirectory=await folderPicker.chooseRestoreBundle();
    if(sourceDirectory===undefined)return {status:'cancelled'};
    pendingRestorePreviews.clear();
    const backup=await r.previewBackup(sourceDirectory);
    const previewToken=randomUUID();
    pendingRestorePreviews.set(previewToken,{sourceDirectory,expiresAt:Date.now()+10*60_000});
    return {status:'ready',previewToken,backup:recoverySummary(backup)};
  });
  register('catalogue:restore:confirm',1,async (r,rawToken)=>{
    if(typeof rawToken!=='string'||!rawToken)throw new CatalogueError('VALIDATION_FAILED','Restore confirmation is invalid.');
    const pending=pendingRestorePreviews.get(rawToken);
    pendingRestorePreviews.delete(rawToken);
    if(!pending||pending.expiresAt<Date.now())throw new CatalogueError('RESTORE_PREVIEW_EXPIRED','This backup preview expired. Select and validate the backup again.');
    const restored=await r.restoreBackup(pending.sourceDirectory);
    const completion:RestoreCompletionResult={
      restored:recoverySummary(restored.manifest),
      previousCatalogueRecoverable:true,
    };
    return completion;
  });
  register('catalogue:restore:cancel-preview',1,(_r,rawToken)=>{
    if(typeof rawToken!=='string'||!rawToken)throw new CatalogueError('VALIDATION_FAILED','Restore cancellation is invalid.');
    return {cancelled:pendingRestorePreviews.delete(rawToken)};
  });
}
