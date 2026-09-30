export const CONTRACT_VERSION = 1 as const;
export const MAX_OPERATIONS = 500;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_PAGE_SIZE = 100;

export type Category = 'film' | 'tv' | 'music' | 'game';
export type Condition = 'unknown' | 'new' | 'like_new' | 'very_good' | 'good' | 'acceptable';
export type CoverageMode = 'not_applicable' | 'unknown' | 'explicit' | 'complete';
export type RecordKind = 'work' | 'edition' | 'owned_copy';
export interface TrustedCaller { readonly lineage: string; readonly origin: 'collector'; }
export interface PurchaseInput { date?: string | null; amount?: string | null; currency?: string | null; retailer?: string | null; }
export type Operation =
  | { operationId: string; kind: 'createWork'; ref: string; category: Category; title: string; artist?: string | null; metadata?: Record<string, unknown> }
  | { operationId: string; kind: 'createEdition'; ref: string; label?: string | null; region?: string | null; platform?: string | null; contents: Array<{ work: string; coverage: CoverageMode; seasons?: number[] }>; formats: string[] }
  | { operationId: string; kind: 'createCopy'; ref: string; edition: string; expectedEditionRevision?: number; condition: Condition; label?: string | null; mediaNotes?: string | null; packagingNotes?: string | null; notes?: string | null; shelf?: string | null; acquisition?: PurchaseInput }
  | { operationId: string; kind: 'updateWork'; id: string; expectedRevision: number; patch: { title?: string; artist?: string | null; metadata?: Record<string, unknown> } }
  | { operationId: string; kind: 'updateEdition'; id: string; expectedRevision: number; patch: { label?: string | null; region?: string | null; platform?: string | null; contents?: Array<{ work: string; coverage: CoverageMode; seasons?: number[] }>; formats?: string[] } }
  | { operationId: string; kind: 'updateCopy'; id: string; expectedRevision: number; expectedSourceEditionRevision?: number; expectedTargetEditionRevision?: number; patch: { edition?: string; condition?: Condition; label?: string | null; mediaNotes?: string | null; packagingNotes?: string | null; notes?: string | null; shelf?: string | null; acquisition?: PurchaseInput } }
  | { operationId: string; kind: 'updateFormat'; id: string; expectedRevision: number; patch: { label: string } }
  | { operationId: string; kind: 'deleteCopy'; id: string; expectedRevision: number }
  | { operationId: string; kind: 'deleteEdition'; id: string; expectedRevision: number }
  | { operationId: string; kind: 'deleteWork'; id: string; expectedRevision: number }
  | { operationId: string; kind: 'deleteFormat'; id: string; expectedRevision: number }
  | { operationId: string; kind: 'createFormat'; ref: string; category: Category; label: string; builtinCode?: string | null };
export interface ChangesetRequest { contractVersion: 1; requestId: string; operations: Operation[]; }
export interface AppliedReceipt { contractVersion: 1; changesetId: string; requestId: string; catalogueRevision: number; recordRefs: Array<{ type: RecordKind | 'format'; id: string; revision: number }>; affectedRecordRefs?: Array<{ type: RecordKind | 'format'; id: string; revision: number }>; replayed: boolean; }
export interface RecordReference { id:string; revision:number; }
export interface CatalogueSearchRequest { query?:string; category?:Category; formatId?:string; genre?:string; purchaseDateFrom?:string; purchaseDateTo?:string; limit?:number; cursor?:string; }
export interface CatalogueSearchResult { contractVersion:1; catalogueRevision:number; items:Array<{type:'work';id:string;category:Category;title:string;revision:number;editionCount:number;copyCount:number}>; nextCursor:string|null; }
export interface CatalogueSummary { contractVersion:1; catalogueRevision:number; workCount:number; ownedWorkCount:number; copyCount:number; pricedCopyCount:number; unpricedCopyCount:number; freeCopyCount:number; spendByCurrency:Array<{currency:string;amount:string;pricedCopyCount:number}>; }
export interface StatisticsResult extends CatalogueSummary { categoryMemberships:Array<{category:Category;copyCount:number}>; formatMemberships:Array<{label:string;copyCount:number}>; }
export interface CopyPageRequest { workId:string; limit?:number; cursor?:string; }
export interface CopyPageResult { contractVersion:1; catalogueRevision:number; items:Array<{id:string;revision:number;editionId:string;title:string;category:Category;shelf:string|null;condition:Condition;purchaseDate:string|null}>; nextCursor:string|null; }
export interface PickerRequest { kind:'work'|'edition'; query?:string; category?:Category; limit?:number; cursor?:string; }
export interface PickerResult { contractVersion:1; catalogueRevision:number; items:Array<{id:string;revision:number;title:string;category?:Category;label?:string|null;workCount?:number;formatLabels?:string[]}>; nextCursor:string|null; }
export interface FormatLookupRequest { category:Category; query?:string; exactLabel?:string; limit?:number; cursor?:string; }
export interface FormatLookupResult { contractVersion:1; catalogueRevision:number; items:Array<{id:string|null;revision:number|null;category:Category;label:string;builtinCode:string|null;builtin:boolean}>; nextCursor:string|null; }
export interface CatalogueLookups { currencies:Array<{code:string;exponent:number}>; conditionOptions:Condition[]; tvCoverageOptions:CoverageMode[]; genres:string[]; }
export interface ChangeHistorySummary { id:string; createdAt:string; status:'applied'|'undone'; undoOf:string|null; changeCount:number; operations:string[]; }
export interface ChangeHistoryPage { contractVersion:1; items:ChangeHistorySummary[]; nextCursor:string|null; }
export interface ChangeHistoryDetailRequest { limit?:number; cursor?:string; }
export type ChangeHistoryProjection =
  | {deleted:boolean;title:string;category:Category;artist:string|null;metadata:Record<string,unknown>}
  | {deleted:boolean;category:Category;label:string;builtinCode:string|null}
  | {deleted:boolean;label:string|null;region:string|null;platform:string|null;contents:Array<{workId:string;coverage:CoverageMode;seasons:number[]}>;formats:string[]}
  | {deleted:boolean;editionId:string;condition:Condition;shelf:string|null;label:string|null;notes:string|null;mediaNotes:string|null;packagingNotes:string|null;acquisition:{date:string|null;amount:string|null;currency:string|null;retailer:string|null}|null};
export interface ChangeHistoryDetail { id:string; createdAt:string; status:'applied'|'undone'; undoOf:string|null; changes:Array<{kind:RecordKind|'format';id:string;operation:string;before:ChangeHistoryProjection|null;after:ChangeHistoryProjection|null;beforeRevision:number|null;afterRevision:number|null}>; nextCursor:string|null; }
export interface EditionProjection { record:{id:string;label:string|null;region:string|null;platform:string|null;createdAt:string;updatedAt:string;revision:number}; contents:Array<{id:string;workId:string;coverageMode:CoverageMode;seasons:number[];work:{id:string;category:Category;title:string;revision:number}|null}>; formats:Array<{id:string;category:Category;label:string;builtinCode:string|null;revision:number}>; }
export type CatalogueDetail =
  | {type:'work';id:string;category:Category;title:string;artist:string|null;metadata:Record<string,unknown>;createdAt:string;updatedAt:string;revision:number;editionRefs:RecordReference[];ownedCopyRefs:RecordReference[]}
  | ({type:'edition'} & EditionProjection & {ownedCopyRefs:RecordReference[]})
  | {type:'owned_copy';record:{id:string;editionId:string;label:string|null;condition:Condition;mediaNotes:string|null;packagingNotes:string|null;notes:string|null;shelf:string|null;createdAt:string;updatedAt:string;revision:number};edition:EditionProjection|null;acquisition:{date:string|null;amount:string|null;currency:string|null;retailer:string|null}|null}
  | {type:'format';id:string;category:Category;label:string;builtinCode:string|null;createdAt:string;updatedAt:string;revision:number;editionRefs:RecordReference[]};
export interface CatalogueErrorShape { code: string; message: string; retryable: boolean; operationErrors?: Array<{ operationId?: string; field?: string; message: string }>; recordRefs?: Array<{ type: string; id: string; revision?: number }> }
export class CatalogueError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly operationErrors?: CatalogueErrorShape['operationErrors'], readonly recordRefs?: CatalogueErrorShape['recordRefs']) { super(message); this.name = 'CatalogueError'; }
  toJSON(): CatalogueErrorShape { return { code: this.code, message: this.message, retryable: this.retryable, ...(this.operationErrors ? { operationErrors: this.operationErrors } : {}), ...(this.recordRefs ? { recordRefs: this.recordRefs } : {}) }; }
}
export interface StoreOptions { databasePath: string; backupPath?: string; clock?: () => Date; id?: () => string; injectFailureAfterWrite?: number; injectMigrationFailure?: boolean; }
