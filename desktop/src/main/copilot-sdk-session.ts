import {
  CopilotClient,
  RuntimeConnection,
  type PermissionRequest,
  type SessionEvent,
} from '@github/copilot-sdk';
import path from 'node:path';
import type { AgentEventBody } from '../contracts/agents';
import { MAX_REPLY_CHARS } from '../contracts/agents';

const FIXTURE_SERVER = 'archivist-catalogue';
const FIXTURE_TOOL = 'catalogue_search';
const FIXTURE_QUALIFIED_TOOL = `${FIXTURE_SERVER}-${FIXTURE_TOOL}`;
const SDK_VERSION = '1.0.14';
const SDK_BUNDLED_CLI_VERSION = '1.0.85';
const STOP_TIMEOUT_MS = 12_000;
const RPC_TIMEOUT_MS = 15_000;

export interface CopilotSdkSessionOptions {
  /** The already-installed Copilot CLI selected by the privileged main process. */
  executable: string;
  /** A fresh, app-owned directory used for this diagnostic session. */
  profile: string;
  /** The app-owned, read-only synthetic catalogue MCP server entry point. */
  fixturePath: string;
  publish: (event: AgentEventBody) => void;
}

/**
 * Narrow wrapper around the pinned Copilot SDK for a single disposable TT-003 session.
 * It intentionally offers only send, cancel and close; SDK capabilities stay private.
 */
export class CopilotSdkSession {
  readonly sdkVersion = SDK_VERSION;
  readonly bundledCliVersion = SDK_BUNDLED_CLI_VERSION;

  private readonly client: CopilotClient;
  private session?: Awaited<ReturnType<CopilotClient['createSession']>>;
  private busy = false;
  private closed = false;
  private idleWaiter?: { resolve: (aborted: boolean) => void; timer: NodeJS.Timeout };
  private streamingTextLength = 0;
  private streamedMessageIds = new Set<string>();
  private readonly toolNamesByCallId = new Map<string, string>();
  private readonly unsubscribe: Array<() => void> = [];
  private stopPromise?: Promise<void>;

  private constructor(private readonly options: CopilotSdkSessionOptions) {
    const env: Record<string, string | undefined> = {};
    for (const key of [
      'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP',
      'TMP', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR',
    ]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    this.client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: options.executable, args: ['--no-custom-instructions'] }),
      mode: 'empty',
      workingDirectory: options.profile,
      baseDirectory: options.profile,
      env,
      logLevel: 'none',
      useLoggedInUser: true,
    });
  }

  static async create(options: CopilotSdkSessionOptions): Promise<CopilotSdkSession> {
    const adapter = new CopilotSdkSession(options);
    try {
      await adapter.initialize();
      return adapter;
    } catch (error) {
      try {
        await adapter.close();
      } catch {
        throw new Error('Copilot session setup failed and owned-process cleanup could not be confirmed.');
      }
      throw error;
    }
  }

  private async initialize() {
    if (!path.isAbsolute(this.options.profile) || !path.isAbsolute(this.options.fixturePath)) {
      throw new Error('Copilot diagnostic paths must be absolute.');
    }
    await this.withTimeout(this.client.start(), RPC_TIMEOUT_MS, 'Copilot runtime startup timed out.');
    const session = await this.withTimeout(this.client.createSession({
      clientName: 'archivist-tt003',
      configDirectory: this.options.profile,
      workingDirectory: this.options.profile,
      model: 'auto',
      streaming: true,
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      enableExperimentalMode: false,
      enableSessionStore: false,
      enableSessionTelemetry: false,
      enableFileChangeTracking: false,
      requestExtensions: false,
      enableMcpApps: false,
      requestCanvasRenderer: false,
      includedBuiltinSkills: [],
      skillDirectories: [],
      customAgents: [],
      tools: [],
      availableTools: [`mcp:${FIXTURE_QUALIFIED_TOOL}`],
      excludedTools: ['builtin:*', 'custom:*'],
      mcpServers: {
        [FIXTURE_SERVER]: {
          type: 'local',
          command: process.execPath,
          args: [this.options.fixturePath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          workingDirectory: this.options.profile,
          tools: [FIXTURE_TOOL],
          timeout: 5_000,
        },
      },
      onPermissionRequest: (request) => this.decidePermission(request),
    }), RPC_TIMEOUT_MS, 'Copilot session creation timed out.');
    this.session = session;
    this.subscribe(session);

    // Ask the runtime to resolve the actual available set and fail closed if any
    // built-in, inherited, or unexpected MCP tool remains present.
    await this.withTimeout(session.rpc.tools.initializeAndValidate(), RPC_TIMEOUT_MS, 'Copilot tool inventory initialization timed out.');
    const inventory = await this.withTimeout(session.rpc.tools.getCurrentMetadata(), RPC_TIMEOUT_MS, 'Copilot effective tool inventory timed out.');
    const tools = inventory.tools;
    if (
      !tools || tools.length !== 1 ||
      tools[0].mcpServerName !== FIXTURE_SERVER ||
      tools[0].mcpToolName !== FIXTURE_TOOL ||
      tools[0].name !== FIXTURE_QUALIFIED_TOOL
    ) {
      throw new Error('Copilot effective tool inventory did not match the single approved catalogue callback; the session was stopped.');
    }
  }

  private decidePermission(request: PermissionRequest) {
    if (request.kind === 'mcp' && request.serverName === FIXTURE_SERVER && request.toolName === FIXTURE_TOOL && request.readOnly) {
      return { kind: 'approve-once' as const };
    }
    if (request.kind === 'mcp') {
      this.options.publish({ type: 'tool', name: request.toolName.slice(0, 100), status: 'denied' });
    }
    return { kind: 'reject' as const, feedback: 'This diagnostic session only permits the read-only synthetic catalogue search.' };
  }

  private subscribe(session: Awaited<ReturnType<CopilotClient['createSession']>>) {
    this.unsubscribe.push(session.on('assistant.usage', (event) => {
      const model = event.data.model;
      if (typeof model === 'string' && model) {
        this.options.publish({ type: 'info', version: this.versionLabel, model: model.slice(0, 100) });
      }
    }));
    this.unsubscribe.push(session.on('assistant.message_delta', (event) => this.onDelta(event)));
    this.unsubscribe.push(session.on('assistant.message', (event) => this.onMessage(event)));
    this.unsubscribe.push(session.on('tool.execution_start', (event) => {
      const name = this.safeToolName(event.data.toolName);
      if (event.data.mcpServerName !== FIXTURE_SERVER || event.data.mcpToolName !== FIXTURE_TOOL || event.data.toolName !== FIXTURE_QUALIFIED_TOOL) {
        this.failBoundary('Copilot attempted to start a tool outside the single approved catalogue callback.');
        return;
      }
      this.toolNamesByCallId.set(event.data.toolCallId, name);
      this.options.publish({ type: 'tool', name, status: 'started' });
    }));
    this.unsubscribe.push(session.on('tool.execution_complete', (event) => {
      const name = this.toolNamesByCallId.get(event.data.toolCallId);
      if (!name) {
        this.failBoundary('Copilot completed a tool call that had no approved start event.');
        return;
      }
      this.toolNamesByCallId.delete(event.data.toolCallId);
      this.options.publish({ type: 'tool', name, status: event.data.success ? 'completed' : 'denied' });
    }));
    this.unsubscribe.push(session.on('session.error', () => {
      this.options.publish({ type: 'error', code: 'COPILOT_SESSION_ERROR', message: 'Copilot reported a diagnostic session error.' });
    }));
    this.unsubscribe.push(session.on('session.idle', (event) => {
      if (this.closed) return;
      this.busy = false;
      const aborted = Boolean(event.data.aborted);
      this.options.publish({ type: 'state', state: aborted ? 'cancelled' : 'completed' });
      const waiter = this.idleWaiter;
      if (waiter) {
        clearTimeout(waiter.timer);
        this.idleWaiter = undefined;
        waiter.resolve(aborted);
      }
    }));
  }

  private get versionLabel() { return `GitHub Copilot SDK ${this.sdkVersion}`; }

  private onDelta(event: Extract<SessionEvent, { type: 'assistant.message_delta' }>) {
    const text = event.data.deltaContent;
    if (typeof text !== 'string' || !text || this.closed) return;
    if (this.streamingTextLength + text.length > MAX_REPLY_CHARS) {
      this.options.publish({ type: 'error', code: 'REPLY_LIMIT', message: 'Copilot reply exceeded the diagnostic display limit.' });
      void this.cancel().catch(() => {
        void this.close().catch(() => {
          this.options.publish({ type: 'error', code: 'CLEANUP_UNCONFIRMED', message: 'The owned diagnostic runtime may still be active; the session remains blocked.' });
        });
      });
      return;
    }
    this.streamingTextLength += text.length;
    this.streamedMessageIds.add(event.data.messageId);
    this.options.publish({ type: 'reply', text });
  }

  private onMessage(event: Extract<SessionEvent, { type: 'assistant.message' }>) {
    if (this.closed || this.streamedMessageIds.has(event.data.messageId)) return;
    const text = event.data.content;
    if (typeof text !== 'string' || !text) return;
    this.options.publish({ type: 'reply', text: text.slice(0, MAX_REPLY_CHARS) });
  }

  private safeToolName(name: string) {
    return name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100) || 'unknown_tool';
  }

  async send(prompt: string): Promise<void> {
    const session = this.requireSession();
    if (this.busy) throw new Error('Wait for the current Copilot reply to finish or cancel it first.');
    this.busy = true;
    this.streamingTextLength = 0;
    this.streamedMessageIds.clear();
    this.options.publish({ type: 'state', state: 'running' });
    try {
      await this.withTimeout(session.send({ prompt }), RPC_TIMEOUT_MS, 'Copilot did not accept the diagnostic request in time.');
    } catch (error) {
      this.busy = false;
      this.options.publish({ type: 'error', code: 'COPILOT_SEND_FAILED', message: 'Copilot did not accept the diagnostic request.' });
      await this.close();
      throw error;
    }
  }

  async cancel(): Promise<{ cancelled: boolean }> {
    const session = this.requireSession();
    if (!this.busy) return { cancelled: false };
    try {
      const [_, aborted] = await Promise.all([
        this.withTimeout(session.abort(), STOP_TIMEOUT_MS, 'Copilot did not acknowledge cancellation.'),
        this.waitForIdle(STOP_TIMEOUT_MS),
      ]);
      return { cancelled: aborted };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.stopPromise = this.closeOwnedResources();
    return this.stopPromise;
  }

  private async closeOwnedResources() {
    const session = this.session;
    this.session = undefined;
    const idleWaiter = this.idleWaiter;
    if (idleWaiter) {
      clearTimeout(idleWaiter.timer);
      this.idleWaiter = undefined;
      idleWaiter.resolve(false);
    }
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try { unsubscribe(); } catch { /* Ignore an already-removed SDK listener. */ }
    }
    const cleanupIssues: string[] = [];
    if (session) {
      if (this.busy) {
        try { await this.withTimeout(session.abort(), STOP_TIMEOUT_MS, 'Copilot turn did not stop in time.'); } catch { /* client stop below owns process teardown */ }
      }
      try { await this.withTimeout(session.disconnect(), STOP_TIMEOUT_MS, 'Copilot session disconnect timed out.'); }
      catch { cleanupIssues.push('session disconnect was not confirmed'); }
      try { await this.withTimeout(this.client.deleteSession(session.sessionId), STOP_TIMEOUT_MS, 'Copilot session history could not be deleted in time.'); }
      catch { cleanupIssues.push('session history deletion was not confirmed'); }
    }
    let stopped = false;
    try {
      const errors = await this.withTimeout(this.client.stop(), STOP_TIMEOUT_MS, 'Copilot runtime did not stop in time.');
      stopped = errors.length === 0;
      if (errors.length > 0) cleanupIssues.push('SDK graceful stop reported an error');
    } catch {
      cleanupIssues.push('SDK graceful stop was not confirmed');
    }
    if (!stopped) {
      try {
        await this.withTimeout(this.client.forceStop(), STOP_TIMEOUT_MS, 'Copilot runtime force stop timed out.');
        stopped = true;
      } catch {
        cleanupIssues.push('SDK force stop was not confirmed');
      }
    }
    this.busy = false;
    if (!stopped || cleanupIssues.length > 0) {
      throw new Error(`Copilot cleanup was not fully confirmed (${cleanupIssues.join('; ') || 'owned process may still be running'}).`);
    }
    this.options.publish({ type: 'state', state: 'closed' });
  }

  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.busy) return Promise.resolve(false);
    if (this.idleWaiter) throw new Error('A Copilot cancellation is already waiting for completion.');
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiter = undefined;
        reject(new Error('Copilot did not confirm turn completion after cancellation.'));
      }, timeoutMs);
      this.idleWaiter = { resolve, timer };
    });
  }

  private failBoundary(message: string) {
    if (this.closed) return;
    this.options.publish({ type: 'error', code: 'TOOL_BOUNDARY_FAILURE', message });
    this.options.publish({ type: 'state', state: 'failed' });
    void this.close().catch(() => {
      this.options.publish({ type: 'error', code: 'CLEANUP_UNCONFIRMED', message: 'Copilot owned-process cleanup could not be confirmed.' });
    });
  }

  private requireSession() {
    if (this.closed || !this.session) throw new Error('The Copilot diagnostic session is no longer available.');
    return this.session;
  }

  private withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }
}
