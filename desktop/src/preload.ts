import { contextBridge, ipcRenderer } from 'electron';
import type { DiagnosticApi } from './contracts/diagnostics';
import type { AgentApi, AgentEvent } from './contracts/agents';
import type { CatalogueApi } from './contracts/catalogue';
const agents: AgentApi = {
  start: (target, prompt) => ipcRenderer.invoke('agent:start', target, prompt),
  followUp: (target, sessionId, prompt) => ipcRenderer.invoke('agent:followup', target, sessionId, prompt),
  cancel: (target, sessionId) => ipcRenderer.invoke('agent:cancel', target, sessionId),
  close: (target, sessionId) => ipcRenderer.invoke('agent:close', target, sessionId),
  onEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value);
    ipcRenderer.on('agent:event', wrapped);
    return () => ipcRenderer.removeListener('agent:event', wrapped);
  },
};
const api: DiagnosticApi = {
  status: () => ipcRenderer.invoke('diagnostic:status'),
  writeFixture: (value) => ipcRenderer.invoke('diagnostic:write', value),
  readFixture: () => ipcRenderer.invoke('diagnostic:read'),
  credentialRoundTrip: () => ipcRenderer.invoke('diagnostic:credential'),
  replaceCredentialCanary: () => ipcRenderer.invoke('diagnostic:credential-replace'),
  runMemoryOnlyCredentialSession: () => ipcRenderer.invoke('diagnostic:session'),
  deleteFixtures: () => ipcRenderer.invoke('diagnostic:delete'),
};
const diagnosticSurface = process.argv.includes('--archivist-diagnostic-ui');
contextBridge.exposeInMainWorld('appSurface', diagnosticSurface ? 'diagnostic' : 'catalogue');
if (diagnosticSurface) {
  contextBridge.exposeInMainWorld('diagnostics', api);
  contextBridge.exposeInMainWorld('agents', agents);
}
const catalogue: CatalogueApi = {
  apply: (request) => ipcRenderer.invoke('catalogue:apply', request),
  undo: (changesetId, requestId) => ipcRenderer.invoke('catalogue:undo', changesetId, requestId),
  search: (request) => ipcRenderer.invoke('catalogue:search', request),
  detail: (kind, id) => ipcRenderer.invoke('catalogue:detail', kind, id),
  summary: () => ipcRenderer.invoke('catalogue:summary'),
  copies: (request) => ipcRenderer.invoke('catalogue:copies', request),
  picker: (request) => ipcRenderer.invoke('catalogue:picker', request),
  formats: (request) => ipcRenderer.invoke('catalogue:formats', request),
  lookups: () => ipcRenderer.invoke('catalogue:lookups'),
  statistics: () => ipcRenderer.invoke('catalogue:statistics'),
  createBackup: () => ipcRenderer.invoke('catalogue:backup:create'),
  previewRestore: () => ipcRenderer.invoke('catalogue:restore:preview'),
  confirmRestore: (previewToken) => ipcRenderer.invoke('catalogue:restore:confirm', previewToken),
  cancelRestorePreview: (previewToken) => ipcRenderer.invoke('catalogue:restore:cancel-preview', previewToken),
  changesList: (request) => ipcRenderer.invoke('catalogue:changes:list', request),
  changesGet: (id, request={}) => ipcRenderer.invoke('catalogue:changes:get', id, request),
};
if (!diagnosticSurface) contextBridge.exposeInMainWorld('catalogue', catalogue);
