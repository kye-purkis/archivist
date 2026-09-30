import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AgentSessions } from './main/agent-sessions';
import { pathToFileURL } from 'node:url';
import { credentialRoundTrip, memoryOnlyCredentialSession, credentialStatus, credentialPresent, foreignKeysEnabled, closeStorage, deleteFixture, openStorage, readFixture, rollbackVerified, sqliteVersion, writeFixture } from './main/storage';
import type { DiagnosticStatus, SafeResult } from './contracts/diagnostics';
import type { AgentTarget } from './contracts/agents';
import { validPrompt } from './contracts/agents';
import { validateFixture, isTrustedInvocation, hasExpectedArgumentCount } from './contracts/validation';
import { CatalogueRuntime } from './main/catalogue-runtime';
import { registerCatalogueIpc } from './main/catalogue-ipc';
import { CatalogueError } from './core/catalogue/contracts';

// Forge emits this entry as CommonJS, so resolve assets from the bundle directory.
const here = __dirname;
const channels = ['diagnostic:status','diagnostic:write','diagnostic:read','diagnostic:credential','diagnostic:credential-replace','diagnostic:session','diagnostic:delete','agent:start','agent:followup','agent:cancel','agent:close'] as const;
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
const isDev = !!MAIN_WINDOW_VITE_DEV_SERVER_URL;
const diagnosticSurface = app.commandLine.hasSwitch('diagnostic-ui');
let windowRef: BrowserWindow | undefined;
let storageFailure: string | undefined;
let trustedRendererUrl = '';
let agentSessions: AgentSessions | undefined;
let catalogueRuntime: CatalogueRuntime | undefined;
let catalogueStartupError: ReturnType<CatalogueError['toJSON']> | undefined;
let quitAfterAgentCleanup = false;
const ok = <T>(value: T): SafeResult<T> => ({ ok: true, value });
const fail = (code: string, message: string): SafeResult<never> => ({ ok: false, error: { code, message } });
function authorized(event: Electron.IpcMainInvokeEvent) {
  if (!windowRef || !event.senderFrame) return false;
  return isTrustedInvocation(event.sender === windowRef.webContents, event.senderFrame === event.sender.mainFrame, event.senderFrame.url, trustedRendererUrl);
}
if(app.commandLine.hasSwitch('catalogue-ipc-smoke')){
  const smokeRoot=process.env.ARCHIVIST_TT004_SMOKE_ROOT??path.join(app.getPath('temp'),'archivist-tt004-smoke');
  const isolatedUserData=path.join(smokeRoot,'ipc-user-data');
  fs.mkdirSync(smokeRoot,{recursive:true});
  if(app.commandLine.getSwitchValue('catalogue-ipc-smoke')==='write')fs.rmSync(isolatedUserData,{recursive:true,force:true});
  app.setPath('userData',isolatedUserData);
}
if(app.commandLine.hasSwitch('catalogue-ui-review')){
  const reviewId=app.commandLine.getSwitchValue('catalogue-ui-review');
  if(!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(reviewId))throw new Error('Catalogue review ID is invalid.');
  const reviewUserData=path.join(app.getPath('temp'),'archivist-tt011-review',reviewId);
  fs.mkdirSync(reviewUserData,{recursive:true,mode:0o700});
  app.setPath('userData',reviewUserData);
}
function register(channel: typeof channels[number], expectedArgs: number, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<SafeResult<unknown>> | SafeResult<unknown>) {
  if (!diagnosticSurface && (channel.startsWith('diagnostic:') || channel.startsWith('agent:'))) return;
  ipcMain.handle(channel, async (event, ...args) => {
    if (!authorized(event)) return fail('DENIED', 'Request was not authorized.');
    if (!hasExpectedArgumentCount(args.length, expectedArgs)) return fail('INVALID_INPUT', 'Unexpected request arguments.');
    try { return await handler(event, ...args); }
    catch (e) {
      const message = e instanceof Error ? e.message.replaceAll(app.getPath('userData'), '[profile]').replaceAll(app.getPath('temp'), '[temporary-profile]').slice(0, 180) : 'Diagnostic operation failed.';
      return fail('UNAVAILABLE', message || 'Diagnostic operation failed.');
    }
  });
}
function setupHandlers() {
  register('diagnostic:status', 0, async () => {
    const creds = await credentialStatus();
    const status: DiagnosticStatus = { electron: process.versions.electron ?? 'unknown', node: process.versions.node, chrome: process.versions.chrome ?? 'unknown', sqlite: sqliteVersion(), database: storageFailure ? 'unavailable' : 'ready', ...(storageFailure ? { storageMessage: storageFailure } : {}), credentialBackend: creds.backend, secureCredentials: creds.secure, lastFixture: storageFailure ? undefined : readFixture() ?? undefined, rollbackVerified: !storageFailure && rollbackVerified(), singleInstanceGuard: true, credentialFilePresent: credentialPresent(), foreignKeysEnabled: !storageFailure && foreignKeysEnabled() };
    return ok(status);
  });
  register('diagnostic:write', 1, (_e, value) => {
    if (!validateFixture(value)) return fail('INVALID_INPUT', 'Use 1–160 characters for the fixture.');
    writeFixture(value); return ok({ value });
  });
  register('diagnostic:read', 0, () => ok({ value: readFixture() }));
  register('diagnostic:credential', 0, async () => ok(await credentialRoundTrip()));
  register('diagnostic:credential-replace', 0, async () => ok(await credentialRoundTrip(true)));
  register('diagnostic:session', 0, () => ok(memoryOnlyCredentialSession()));
  register('diagnostic:delete', 0, () => ok({ deleted: deleteFixture() }));
  register('agent:start', 2, async (_e, target, prompt) => {
    if ((target !== 'codex' && target !== 'copilot') || !validPrompt(prompt)) return fail('INVALID_INPUT', 'Choose an agent and enter a question of up to 1000 characters.');
    if (!agentSessions) return fail('UNAVAILABLE', 'Agent diagnostic is unavailable.');
    return ok(await agentSessions.start(target as AgentTarget, prompt));
  });
  register('agent:followup', 3, async (_e, target, id, prompt) => {
    if ((target !== 'codex' && target !== 'copilot') || typeof id !== 'string' || !validPrompt(prompt)) return fail('INVALID_INPUT', 'The follow-up request is invalid.');
    if (!agentSessions) return fail('UNAVAILABLE', 'Agent diagnostic is unavailable.');
    return ok(await agentSessions.followUp(target as AgentTarget, id, prompt));
  });
  register('agent:cancel', 2, async (_e, target, id) => {
    if ((target !== 'codex' && target !== 'copilot') || typeof id !== 'string') return fail('INVALID_INPUT', 'The cancel request is invalid.');
    if (!agentSessions) return fail('UNAVAILABLE', 'Agent diagnostic is unavailable.');
    return ok(await agentSessions.cancel(target as AgentTarget, id));
  });
  register('agent:close', 2, async (_e, target, id) => {
    if ((target !== 'codex' && target !== 'copilot') || typeof id !== 'string') return fail('INVALID_INPUT', 'The session close request is invalid.');
    if (!agentSessions) return fail('UNAVAILABLE', 'Agent diagnostic is unavailable.');
    return ok(await agentSessions.closeSession(target as AgentTarget, id));
  });
  if (!diagnosticSurface) {
    registerCatalogueIpc(
      ipcMain,
      authorized,
      () => catalogueRuntime ?? undefined,
      () => catalogueStartupError,
      {
        chooseBackupParent: async () => {
          if (!windowRef || windowRef.isDestroyed()) throw new CatalogueError('APP_UNAVAILABLE','Backup folder selection is unavailable.',true);
          const result = await dialog.showOpenDialog(windowRef, {
            title: 'Choose where to save the backup',
            buttonLabel: 'Choose folder',
            properties: ['openDirectory','createDirectory'],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
        chooseRestoreBundle: async () => {
          if (!windowRef || windowRef.isDestroyed()) throw new CatalogueError('APP_UNAVAILABLE','Restore folder selection is unavailable.',true);
          const result = await dialog.showOpenDialog(windowRef, {
            title: 'Choose an Archivist backup folder',
            buttonLabel: 'Preview backup',
            properties: ['openDirectory'],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
      },
    );
  }
}
async function createWindow(show=true) {
  windowRef = new BrowserWindow({ title:diagnosticSurface?'Archivist desktop diagnostic':'Archivist', width: 1180, height: 820, minWidth: 640, minHeight: 540, show, webPreferences: { preload: path.join(here, 'preload.js'), additionalArguments: diagnosticSurface ? ['--archivist-diagnostic-ui'] : [], contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('will-navigate', (event, url) => { if (!isTrustedInvocation(true, true, url, trustedRendererUrl)) event.preventDefault(); });
  if (isDev) { trustedRendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL; await windowRef.loadURL(trustedRendererUrl); }
  else { const rendererFile = path.join(here, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`); trustedRendererUrl = pathToFileURL(rendererFile).href; await windowRef.loadFile(rendererFile); }
}
async function runCatalogueIpcSmoke(phase:'write'|'read',root:string){
  const userData=path.join(root,'ipc-user-data');
  fs.mkdirSync(userData,{recursive:true});
  app.setPath('userData',userData);
  catalogueRuntime=await CatalogueRuntime.open();
  setupHandlers();
  await createWindow(false);
  const request={contractVersion:1,requestId:'tt004-packaged-ipc-smoke-v1',operations:[
    {operationId:'work',kind:'createWork',ref:'$work',category:'film',title:'Synthetic packaged IPC smoke'},
    {operationId:'format',kind:'createFormat',ref:'$format',category:'film',label:'Synthetic DVD'},
    {operationId:'edition',kind:'createEdition',ref:'$edition',contents:[{work:'$work',coverage:'not_applicable'}],formats:['$format']},
    {operationId:'copy',kind:'createCopy',ref:'$copy',edition:'$edition',condition:'unknown'}
  ]};
  const mainResult=await windowRef!.webContents.executeJavaScript(`(async()=>{const result=await window.catalogue.apply(${JSON.stringify(request)});if(!result.ok)throw new Error('trusted renderer command was rejected');if(${JSON.stringify(phase)}==='read'&&!result.value.replayed)throw new Error('restart replay was not returned');const work=result.value.recordRefs.find(x=>x.type==='work');const detail=await window.catalogue.detail('work',work.id);const summary=await window.catalogue.summary();const invalid=await window.catalogue.apply({contractVersion:1,requestId:'invalid-empty-v1',operations:[]});if(!detail.ok||!summary.ok||typeof detail.value.revision!=='number'||summary.value.copyCount!==1||invalid.ok||invalid.error.code!=='VALIDATION_FAILED'||invalid.error.retryable!==false)throw new Error('typed renderer projection/error contract failed');return {phase:${JSON.stringify(phase)},replayed:result.value.replayed,recordCount:result.value.recordRefs.length,revisionType:typeof detail.value.revision,copyCount:summary.value.copyCount,invalidCode:invalid.error.code};})()`);
  const outsider=new BrowserWindow({show:false,webPreferences:{preload:path.join(here,'preload.js'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
  try{
    await outsider.loadURL(trustedRendererUrl);
    const rejected=await outsider.webContents.executeJavaScript('window.catalogue.summary()');
    if(rejected.ok||rejected.error?.code!=='ACCESS_DENIED'||rejected.error?.retryable!==false)throw new Error('untrusted renderer IPC was not denied with the typed envelope');
  }finally{outsider.destroy();}
  return {...mainResult,untrustedCode:'ACCESS_DENIED'};
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => windowRef?.focus());
  app.whenReady().then(async () => {
    if(app.commandLine.hasSwitch('catalogue-ipc-smoke')){
      const phase=app.commandLine.getSwitchValue('catalogue-ipc-smoke');
      const smokeRoot=process.env.ARCHIVIST_TT004_SMOKE_ROOT??path.join(app.getPath('temp'),'archivist-tt004-smoke');
      try{if(phase!=='write'&&phase!=='read')throw new Error('Unknown catalogue smoke phase.');const result=await runCatalogueIpcSmoke(phase,smokeRoot);console.log('TT004_PACKAGE_IPC_SMOKE_PASS',JSON.stringify(result));app.quit();}
      catch(error){console.error('TT004_PACKAGE_IPC_SMOKE_FAIL',error instanceof Error?error.message:'Catalogue IPC smoke failed.');app.exit(1);}
      return;
    }
    const developmentSocket = isDev ? MAIN_WINDOW_VITE_DEV_SERVER_URL.replace(/^http/, 'ws') : '';
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [`default-src 'self'; script-src 'self' ${isDev ? "'nonce-tt001-vite-development'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${developmentSocket}; object-src 'none'; base-uri 'none'; frame-src 'none'`] } }));
    if (!diagnosticSurface) {
      try {
        catalogueRuntime = await CatalogueRuntime.open();
        catalogueStartupError = undefined;
      } catch (reason) {
        catalogueStartupError =
          reason instanceof CatalogueError
            ? reason.toJSON()
            : {
                code: "APP_UNAVAILABLE",
                message:
                  "The local catalogue could not be opened because of an unexpected startup error. Private diagnostic details were withheld.",
                retryable: true,
              };
        console.error(
          "[catalogue] startup failed",
          JSON.stringify({
            code: catalogueStartupError.code,
            reason:
              reason instanceof CatalogueError
                ? catalogueStartupError.message
                : "unexpected error; details withheld",
          }),
        );
      }
    }
    if (diagnosticSurface) {
      try { openStorage(); } catch (e) { storageFailure = e instanceof Error ? e.message.replaceAll(app.getPath('userData'), '[profile]').slice(0, 160) : 'Diagnostic storage is unavailable.'; }
      const agentRoot = await mkdir(path.join(app.getPath('temp'), 'archivist-tt003'), { recursive: true }).then(() => path.join(app.getPath('temp'), 'archivist-tt003'));
      agentSessions = new AgentSessions(agentRoot);
      agentSessions.onEvent((event) => { if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('agent:event', event); });
    }
    setupHandlers(); void createWindow();
  });
}
app.on('before-quit', (event) => {
  if (quitAfterAgentCleanup || !agentSessions) { catalogueRuntime?.close(); closeStorage(); return; }
  event.preventDefault();
  quitAfterAgentCleanup = true;
  void agentSessions.closeAll().then(() => {
    closeStorage();
    catalogueRuntime?.close();
    app.quit();
  }).catch(() => {
    quitAfterAgentCleanup = false;
    if (windowRef && !windowRef.isDestroyed()) void dialog.showMessageBox(windowRef, {
      type: 'error',
      title: 'Diagnostic runtime still active',
      message: 'Archivist could not confirm cleanup for every owned diagnostic runtime. The app remains open and the affected session stays blocked.',
    });
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
