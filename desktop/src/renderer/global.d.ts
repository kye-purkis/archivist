import type { DiagnosticApi } from '../contracts/diagnostics';
import type { AgentApi } from '../contracts/agents';
import type { CatalogueApi } from '../contracts/catalogue';
declare global { interface Window { appSurface: 'catalogue'|'diagnostic'; diagnostics?: DiagnosticApi; agents?: AgentApi; catalogue: CatalogueApi } }
export {};
