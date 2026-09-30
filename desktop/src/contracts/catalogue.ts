import type { AppliedReceipt, CatalogueDetail, CatalogueErrorShape, CatalogueSearchRequest, CatalogueSearchResult, CatalogueSummary, ChangesetRequest, CopyPageRequest, PickerRequest, FormatLookupRequest } from '../core/catalogue/contracts';
import type { CatalogueRecoverySummary } from '../core/catalogue/recovery';
export type SafeResult<T> = {ok:true;value:T}|{ok:false;error:CatalogueErrorShape};
export type CreateBackupResult =
  | {status:'cancelled'}
  | {status:'created';bundleName:string;backup:CatalogueRecoverySummary};
export type RestorePreviewResult =
  | {status:'cancelled'}
  | {status:'ready';previewToken:string;backup:CatalogueRecoverySummary};
export interface RestoreCompletionResult {
  restored:CatalogueRecoverySummary;
  previousCatalogueRecoverable:true;
}
export interface CatalogueApi {
  apply(request:ChangesetRequest):Promise<SafeResult<AppliedReceipt>>;
  undo(changesetId:string,requestId:string):Promise<SafeResult<AppliedReceipt>>;
  search(request:CatalogueSearchRequest):Promise<SafeResult<CatalogueSearchResult>>;
  detail(kind:'work'|'edition'|'owned_copy'|'format',id:string):Promise<SafeResult<CatalogueDetail>>;
  summary():Promise<SafeResult<CatalogueSummary>>;
  copies(request:CopyPageRequest):Promise<SafeResult<import('../core/catalogue/contracts').CopyPageResult>>;
  picker(request:PickerRequest):Promise<SafeResult<import('../core/catalogue/contracts').PickerResult>>;
  formats(request:FormatLookupRequest):Promise<SafeResult<import('../core/catalogue/contracts').FormatLookupResult>>;
  lookups():Promise<SafeResult<import('../core/catalogue/contracts').CatalogueLookups>>;
  statistics():Promise<SafeResult<import('../core/catalogue/contracts').StatisticsResult>>;
  createBackup():Promise<SafeResult<CreateBackupResult>>;
  previewRestore():Promise<SafeResult<RestorePreviewResult>>;
  confirmRestore(previewToken:string):Promise<SafeResult<RestoreCompletionResult>>;
  cancelRestorePreview(previewToken:string):Promise<SafeResult<{cancelled:boolean}>>;
  changesList(request:{limit?:number;cursor?:string}):Promise<SafeResult<import('../core/catalogue/contracts').ChangeHistoryPage>>;
  changesGet(id:string,request?:import('../core/catalogue/contracts').ChangeHistoryDetailRequest):Promise<SafeResult<import('../core/catalogue/contracts').ChangeHistoryDetail>>;
}
