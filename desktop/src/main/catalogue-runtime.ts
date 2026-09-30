import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { CatalogueStore } from '../core/catalogue/store';
import type { StoreOptions, TrustedCaller } from '../core/catalogue/contracts';

// The trusted local collector context is created only in main. Renderer DTOs never carry it.
export class CatalogueRuntime {
  private constructor(readonly store: CatalogueStore) {}
  static async open(options: { userDataPath?: string; storeOptions?: Partial<StoreOptions> } = {}) {
    const base=options.userDataPath??app.getPath('userData');
    const profile=path.join(base,'archivist-catalogue-production');
    fs.mkdirSync(profile,{recursive:true,mode:0o700});
    try{fs.chmodSync(profile,0o700);}catch{/* platform ACL inheritance */}
    const store=await CatalogueStore.open({databasePath:path.join(profile,'catalogue.sqlite3'),...options.storeOptions});
    return new CatalogueRuntime(store);
  }
  private get localCollector():TrustedCaller{return Object.freeze({lineage:`desktop-local-collector:${this.store.catalogueId}`,origin:'collector'});}
  apply(request: unknown){return this.store.apply(this.localCollector,request);}
  undo(changesetId: string,requestId: string){return this.store.undo(this.localCollector,changesetId,requestId);}
  search(request: import('../core/catalogue/contracts').CatalogueSearchRequest){return this.store.search(request);}
  detail(kind:'work'|'edition'|'owned_copy'|'format',id:string){return this.store.detail(kind,id);}
  summary(){return this.store.summary();}
  copies(request:import('../core/catalogue/contracts').CopyPageRequest){return this.store.copies(request);}
  picker(request:import('../core/catalogue/contracts').PickerRequest){return this.store.picker(request);}
  formats(request:import('../core/catalogue/contracts').FormatLookupRequest){return this.store.formats(request);}
  lookups(){return this.store.lookups();}
  statistics(){return this.store.statistics();}
  changesList(request:{limit?:number;cursor?:string}){return this.store.historyList(request,this.localCollector);}
  changesGet(id:string,request?:import('../core/catalogue/contracts').ChangeHistoryDetailRequest){return this.store.historyGet(id,request??{},this.localCollector);}
  createBackup(destinationDirectory:string){return this.store.createBackup(destinationDirectory);}
  previewBackup(sourceDirectory:string){return this.store.previewBackup(sourceDirectory);}
  restoreBackup(sourceDirectory:string){return this.store.restoreBackup(sourceDirectory);}
  close(){this.store.close();}

}
