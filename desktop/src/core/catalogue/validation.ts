import { CatalogueError, MAX_OPERATIONS, MAX_REQUEST_BYTES, type ChangesetRequest, type Operation } from './contracts';
import { isCalendarDate } from './calendar-date';
import { decimalToMinor } from './money';

const categories = new Set(['film','tv','music','game']);
const conditions = new Set(['unknown','new','like_new','very_good','good','acceptable']);
const coverages = new Set(['not_applicable','unknown','explicit','complete']);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const nonblank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const keysOnly = (value: Record<string, unknown>, allowed: string[], opId?: string) => {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid('Unknown fields are not accepted.', [{operationId:opId, field:extra[0], message:'Remove the unsupported field.'}]);
};
function invalid(message: string, errors?: Array<{operationId?:string;field?:string;message:string}>) { return new CatalogueError('VALIDATION_FAILED', message, false, errors); }
function validRef(s: unknown) { return nonblank(s) && (s.startsWith('$') ? /^\$[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s) : s.length <= 160); }
function nullableText(value:unknown,field:string,opId:string,max=300){if(value!==undefined&&value!==null&&(typeof value!=='string'||value.length>max))throw invalid(`${field} is invalid.`,[{operationId:opId,field,message:`Use text of up to ${max} characters or null.`}]);}
function positiveRevision(value:unknown){return Number.isSafeInteger(value)&&Number(value)>0;}
function assertJsonValue(value:unknown,seen=new Set<object>()):void {
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))throw invalid('Request must contain only finite JSON data.');return;}
  if(typeof value!=='object'||seen.has(value as object))throw invalid('Request must contain only finite JSON data.');
  seen.add(value as object);
  if(Array.isArray(value)){for(let i=0;i<value.length;i++){if(!Object.hasOwn(value,i))throw invalid('Request must contain only finite JSON data.');assertJsonValue(value[i],seen);}}
  else {if(!isPlain(value))throw invalid('Request must contain only plain JSON objects.');for(const x of Object.values(value))assertJsonValue(x,seen);}
  seen.delete(value as object);
}
function validateContents(value: unknown, opId: string) {
  if (!Array.isArray(value) || value.length === 0) throw invalid('An active edition needs at least one work.', [{operationId:opId,field:'contents',message:'Add at least one work.'}]);
  const seen = new Set<string>();
  for (const c of value) {
    if (!isPlain(c)) throw invalid('Invalid edition content.', [{operationId:opId,field:'contents',message:'Use a valid content entry.'}]);
    keysOnly(c, ['work','coverage','seasons'], opId);
    if (!validRef(c.work) || !coverages.has(String(c.coverage))) throw invalid('Invalid edition content.', [{operationId:opId,field:'contents',message:'Choose a work and valid coverage mode.'}]);
    if (seen.has(String(c.work))) throw invalid('Duplicate edition content.', [{operationId:opId,field:'contents',message:'A work may appear only once in an edition.'}]);
    seen.add(String(c.work));
    if (c.seasons !== undefined) {
      if (!Array.isArray(c.seasons) || c.seasons.some((n) => !Number.isSafeInteger(n) || Number(n) < 0) || new Set(c.seasons).size !== c.seasons.length) throw invalid('Invalid TV season list.', [{operationId:opId,field:'seasons',message:'Use unique nonnegative whole season numbers.'}]);
      if (c.coverage !== 'explicit' && c.coverage !== 'complete' && c.seasons.length) throw invalid('Seasons require explicit or complete TV coverage.', [{operationId:opId,field:'seasons',message:'Choose explicit or complete coverage.'}]);
    }
  }
}
function validateMetadata(value: unknown, opId: string) {
  if(!isPlain(value))throw invalid('Descriptive metadata must be an object.',[{operationId:opId,field:'metadata',message:'Use the supported descriptive metadata fields.'}]);
  keysOnly(value,['year','releaseDate','genres','description','director','publisher','developer','country'],opId);
  if(value.year!==undefined&&(!Number.isSafeInteger(value.year)||Number(value.year)<1||Number(value.year)>9999))throw invalid('Release year is invalid.',[{operationId:opId,field:'metadata.year',message:'Use a year from 1 to 9999.'}]);
  if(value.releaseDate!==undefined&&value.releaseDate!==null&&!isCalendarDate(value.releaseDate))throw invalid('Release date is invalid.',[{operationId:opId,field:'metadata.releaseDate',message:'Use a real YYYY-MM-DD date.'}]);
  if(value.genres!==undefined&&(!Array.isArray(value.genres)||value.genres.length>100||value.genres.some(x=>!nonblank(x)||x.length>120)))throw invalid('Genres are invalid.',[{operationId:opId,field:'metadata.genres',message:'Use up to 100 nonblank genre labels.'}]);
  for(const field of ['description','director','publisher','developer','country'])if(value[field]!==undefined&&value[field]!==null&&(typeof value[field]!=='string'||value[field].length>(field==='description'?10000:300)))throw invalid('Descriptive metadata is invalid.',[{operationId:opId,field:`metadata.${field}`,message:'Use text within the supported length.'}]);
}
function validatePurchase(value: unknown, opId: string) {
  if (!isPlain(value)) throw invalid('Invalid acquisition.', [{operationId:opId,field:'acquisition',message:'Use an acquisition object.'}]);
  keysOnly(value, ['date','amount','currency','retailer'], opId);
  if (value.date != null && !isCalendarDate(value.date)) throw invalid('Invalid calendar date.', [{operationId:opId,field:'date',message:'Use a real YYYY-MM-DD calendar date.'}]);
  decimalToMinor(value.amount, value.currency);
  nullableText(value.retailer,'retailer',opId);
}
const opFields: Record<Operation['kind'], string[]> = {
  createWork:['operationId','kind','ref','category','title','artist','metadata'], createEdition:['operationId','kind','ref','label','region','platform','contents','formats'], createCopy:['operationId','kind','ref','edition','expectedEditionRevision','condition','label','mediaNotes','packagingNotes','notes','shelf','acquisition'],
  updateWork:['operationId','kind','id','expectedRevision','patch'], updateEdition:['operationId','kind','id','expectedRevision','patch'], updateCopy:['operationId','kind','id','expectedRevision','expectedSourceEditionRevision','expectedTargetEditionRevision','patch'], updateFormat:['operationId','kind','id','expectedRevision','patch'],
  deleteCopy:['operationId','kind','id','expectedRevision'], deleteEdition:['operationId','kind','id','expectedRevision'], deleteWork:['operationId','kind','id','expectedRevision'], deleteFormat:['operationId','kind','id','expectedRevision'], createFormat:['operationId','kind','ref','category','label','builtinCode']
};
export function validateRequest(input: unknown): ChangesetRequest {
  if (!isPlain(input)) throw invalid('Request must be an object.');
  keysOnly(input, ['contractVersion','requestId','operations']);
  if (input.contractVersion !== 1) throw new CatalogueError('VERSION_UNSUPPORTED', 'Request contract version is unsupported.');
  if (!nonblank(input.requestId) || input.requestId.length > 160) throw invalid('Request ID is invalid.', [{field:'requestId',message:'Use an opaque request ID of up to 160 characters.'}]);
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw invalid('Changeset must contain at least one operation.', [{field:'operations',message:'Add at least one operation.'}]);
  if (input.operations.length > MAX_OPERATIONS) throw new CatalogueError('PAYLOAD_TOO_LARGE', `A changeset may contain at most ${MAX_OPERATIONS} operations.`);
  assertJsonValue(input);
  let encoded: string;
  try { encoded = JSON.stringify(input); }
  catch { throw invalid('Request must contain only finite JSON data.'); }
  if (typeof encoded !== 'string') throw invalid('Request must contain only finite JSON data.');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) throw new CatalogueError('PAYLOAD_TOO_LARGE', `A changeset may not exceed ${MAX_REQUEST_BYTES} bytes.`);
  const operationIds = new Set<string>(); const refs = new Set<string>();
  for (const raw of input.operations) {
    if (!isPlain(raw) || typeof raw.kind !== 'string' || !Object.hasOwn(opFields,raw.kind)) throw invalid('Unknown operation kind.');
    const op = raw as unknown as Operation;
    keysOnly(raw, opFields[op.kind], op.operationId);
    if (!nonblank(op.operationId) || op.operationId.length > 100 || operationIds.has(op.operationId)) throw invalid('Operation IDs must be unique.', [{operationId:op.operationId,field:'operationId',message:'Provide a unique operation ID.'}]);
    operationIds.add(op.operationId);
    if ('ref' in op) { if (!validRef(op.ref) || !op.ref.startsWith('$') || refs.has(op.ref)) throw invalid('Temporary references must be unique opaque names.', [{operationId:op.operationId,field:'ref',message:'Provide a unique temporary reference.'}]); refs.add(op.ref); }
    if (op.kind === 'createWork') {
      if (!categories.has(op.category) || !nonblank(op.title) || op.title.length>500) throw invalid('Work category and title are required.', [{operationId:op.operationId,field:'title',message:'Enter a title of up to 500 characters and supported category.'}]);
      nullableText(op.artist,'artist',op.operationId);
      if (op.artist != null && typeof op.artist !== 'string') throw invalid('Invalid artist.', [{operationId:op.operationId,field:'artist',message:'Use text or null.'}]);
      if (op.metadata !== undefined) validateMetadata(op.metadata,op.operationId);
    } else if (op.kind === 'createEdition') {
      nullableText(op.label,'label',op.operationId);nullableText(op.region,'region',op.operationId);nullableText(op.platform,'platform',op.operationId);
      validateContents(op.contents, op.operationId);
      if (!Array.isArray(op.formats) || !op.formats.length || op.formats.some((x) => !validRef(x)) || new Set(op.formats).size !== op.formats.length) throw invalid('An active edition needs unique formats.', [{operationId:op.operationId,field:'formats',message:'Add one or more unique formats.'}]);
    } else if (op.kind === 'createCopy') {
      if (!validRef(op.edition) || !conditions.has(op.condition)) throw invalid('Copy needs one edition and a valid condition.', [{operationId:op.operationId,field:'edition',message:'Choose a valid edition and condition.'}]);
      if(op.edition.startsWith('$') ? op.expectedEditionRevision!==undefined : !positiveRevision(op.expectedEditionRevision)) throw invalid('Selected edition revision is required.',[{operationId:op.operationId,field:'expectedEditionRevision',message:'Use the current edition revision, except for an edition created in this changeset.'}]);
      nullableText(op.label,'label',op.operationId);nullableText(op.mediaNotes,'mediaNotes',op.operationId,2000);nullableText(op.packagingNotes,'packagingNotes',op.operationId,2000);nullableText(op.notes,'notes',op.operationId,5000);nullableText(op.shelf,'shelf',op.operationId,300);
      if (op.acquisition !== undefined) validatePurchase(op.acquisition, op.operationId);
    } else if (op.kind === 'createFormat') {
      if (!categories.has(op.category) || !nonblank(op.label)||op.label.length>200) throw invalid('Format category and label are required.', [{operationId:op.operationId,field:'label',message:'Enter a format label of up to 200 characters and supported category.'}]);
      nullableText(op.builtinCode,'builtinCode',op.operationId,120);
    } else if (op.kind.startsWith('update')) {
      const update = op as Extract<Operation, { kind: 'updateWork' | 'updateEdition' | 'updateCopy' | 'updateFormat' }>;
      if (!nonblank(op.id) || !Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 1 || !isPlain(update.patch)) throw invalid('Update target or revision is invalid.', [{operationId:op.operationId,field:'expectedRevision',message:'Use the current positive record revision.'}]);
      const patch=update.patch as Record<string,unknown>;
      const allowed = op.kind === 'updateWork' ? ['title','artist','metadata'] : op.kind === 'updateEdition' ? ['label','region','platform','contents','formats'] : op.kind === 'updateFormat'?['label']:['edition','condition','label','mediaNotes','packagingNotes','notes','shelf','acquisition'];
      keysOnly(patch, allowed, op.operationId);
      if(op.kind==='updateCopy'){
        const moving='edition' in patch;
        const copyUpdate=update as Extract<Operation,{kind:'updateCopy'}>;
        if(moving){
          if(!validRef(patch.edition)||!positiveRevision(copyUpdate.expectedSourceEditionRevision))throw invalid('Copy reassignment needs current source and target release revisions.',[{operationId:op.operationId,field:'expectedSourceEditionRevision',message:'Provide the current source and target edition revisions.'}]);
          if(String(patch.edition).startsWith('$')?copyUpdate.expectedTargetEditionRevision!==undefined:!positiveRevision(copyUpdate.expectedTargetEditionRevision))throw invalid('Copy reassignment needs current source and target release revisions.',[{operationId:op.operationId,field:'expectedTargetEditionRevision',message:'Use the current target edition revision, except for an edition created in this changeset.'}]);
        }else if(copyUpdate.expectedSourceEditionRevision!==undefined||copyUpdate.expectedTargetEditionRevision!==undefined)throw invalid('Release revisions are only valid when reassigning a copy.',[{operationId:op.operationId,field:'patch.edition',message:'Select a target edition to use release revisions.'}]);
      }
      if (op.kind === 'updateWork' && 'title' in patch && (!nonblank(patch.title)||patch.title.length>500)) throw invalid('Title cannot be blank.', [{operationId:op.operationId,field:'title',message:'Enter a title of up to 500 characters.'}]);
      if(op.kind==='updateWork'&&'metadata' in patch)validateMetadata(patch.metadata,op.operationId);
      if (op.kind === 'updateEdition') { if ('contents' in patch) validateContents(patch.contents, op.operationId); if ('formats' in patch && (!Array.isArray(patch.formats) || !patch.formats.length || patch.formats.some(x=>!validRef(x)) || new Set(patch.formats).size !== patch.formats.length)) throw invalid('An active edition needs unique formats.', [{operationId:op.operationId,field:'formats',message:'Add one or more unique formats.'}]); }
      const textFields=op.kind==='updateWork'?['artist']:op.kind==='updateEdition'?['label','region','platform']:op.kind==='updateFormat'?['label']:['label','mediaNotes','packagingNotes','notes','shelf'];
      if(op.kind==='updateCopy'&&'edition' in patch&&!validRef(patch.edition))throw invalid('Target edition reference is invalid.',[{operationId:op.operationId,field:'edition',message:'Choose a valid existing or same-changeset edition.'}]);
      for(const field of textFields)if(field in patch)nullableText(patch[field],field,op.operationId,field.endsWith('Notes')?2000:field==='notes'?5000:300);
      if(op.kind==='updateFormat'&&(!nonblank(patch.label)||patch.label.length>200))throw invalid('Format label is invalid.',[{operationId:op.operationId,field:'label',message:'Enter a format label of up to 200 characters.'}]);
      if(op.kind==='updateCopy'&&'condition' in patch&&!conditions.has(String(patch.condition)))throw invalid('Condition is invalid.',[{operationId:op.operationId,field:'condition',message:'Choose a supported condition.'}]);
      if (op.kind === 'updateCopy' && 'acquisition' in patch) validatePurchase(patch.acquisition, op.operationId);
    } else if (!nonblank(op.id) || !Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 1) throw invalid('Delete target or revision is invalid.', [{operationId:op.operationId,field:'expectedRevision',message:'Use the current positive record revision.'}]);
  }
  return input as unknown as ChangesetRequest;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
