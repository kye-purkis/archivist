import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AgentEvent, AgentEventBody, AgentTarget } from '../contracts/agents';
import { MAX_PROMPT_CHARS, MAX_REPLY_CHARS, TURN_TIMEOUT_MS } from '../contracts/agents';
import { codexContextIssue, codexEnabledFeatures, codexFeatureOverrides as planCodexFeatureOverrides, codexFeaturesAreRestricted, codexMcpServerNames, codexRequestFailure, HOSTILE_CATALOGUE_NOTE, readNewlineFrames } from './agent-protocol';
import { CopilotSdkSession } from './copilot-sdk-session';

type Listener = (event: AgentEvent) => void;
type Json = Record<string, any>;
type Pending = { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Session = {
  id: string; target: AgentTarget; process?: ChildProcess; copilotSdk?: CopilotSdkSession; profile: string;
  sequence: number; pending: Map<number, Pending>; threadId?: string; turnId?: string;
  fixtureServerName?: string;
  buffer: string; busy: boolean; closed: boolean; timeout?: NodeJS.Timeout;
  completedTurnId?: string; completedTurnStatus?: string; closing?: boolean; closePromise?: Promise<void>; releasePromise?: Promise<void>;
  turnCompletionWaiter?: { turnId: string; resolve: (status: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
};

function findExecutable(name: string) {
  try { return execFileSync('/usr/bin/which', [name], { encoding: 'utf8', timeout: 1500 }).trim(); }
  catch { return ''; }
}
function executableVersion(file: string) {
  if (!file) return 'not found';
  try { return execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 2500, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/, 1)[0].trim().slice(0, 100) || 'unknown'; }
  catch { return 'unknown'; }
}

function cleanEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function emit(listener: Listener, target: AgentTarget, event: AgentEventBody) {
  listener({ ...event, target } as AgentEvent);
}

export class AgentSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly startingTargets = new Set<AgentTarget>();
  private readonly listeners = new Set<Listener>();
  private readonly executables: Record<AgentTarget, string>;
  private readonly versions: Record<AgentTarget, string>;
  private readonly codexMcpOverrides?: string[];
  private readonly codexFeatureConfig?: string[];
  private codexFeatureBlockMessage = 'Codex feature inventory could not be verified; the diagnostic session was stopped.';

  constructor(private readonly profileRoot: string, private readonly turnTimeoutMs = TURN_TIMEOUT_MS) {
    this.executables = { codex: findExecutable('codex'), copilot: findExecutable('copilot') };
    this.versions = { codex: executableVersion(this.executables.codex), copilot: executableVersion(this.executables.copilot) };
    if (this.executables.codex) {
      try {
        const inventory = execFileSync(this.executables.codex, ['features', 'list'], { encoding: 'utf8', timeout: 5000, cwd: this.profileRoot, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
        const overrides = planCodexFeatureOverrides(inventory);
        if (overrides) {
          const effective = execFileSync(this.executables.codex, ['features', ...overrides, 'list'], { encoding: 'utf8', timeout: 5000, cwd: this.profileRoot, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
          if (codexFeaturesAreRestricted(effective)) this.codexFeatureConfig = overrides;
          else {
            const enabled = codexEnabledFeatures(effective);
            this.codexFeatureBlockMessage = enabled?.includes('unified_exec')
              ? 'Codex tool restriction readback is incompatible: unified_exec remains enabled; invocation was stopped.'
              : enabled?.length
                ? 'Codex tool restriction readback still reports enabled feature flags; invocation was stopped.'
              : 'Codex feature restriction readback was malformed; the diagnostic session was stopped.';
          }
        }
      } catch { /* Missing or unreadable feature inventory blocks Codex startup below. */ }
      try {
        const output = execFileSync(this.executables.codex, ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 5000, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
        const names = codexMcpServerNames(JSON.parse(output));
        if (names) this.codexMcpOverrides = [...new Set(['codex_app', 'codex_apps', ...names])]
          .map((name) => `mcp_servers.${name}={command="false",enabled=false}`)
          .flatMap((setting) => ['-c', setting]);
      } catch { /* Missing or unreadable MCP inventory blocks Codex startup below. */ }
    }
  }

  onEvent(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(target: AgentTarget, event: AgentEventBody) { for (const listener of this.listeners) emit(listener, target, event); }

  async start(target: AgentTarget, prompt: string) {
    const executable = this.executables[target];
    if (!executable) throw new Error(`${target === 'codex' ? 'Codex CLI' : 'GitHub Copilot CLI'} was not found on PATH.`);
    if (prompt.length > MAX_PROMPT_CHARS || !prompt.trim()) throw new Error(`Enter a question of 1–${MAX_PROMPT_CHARS} characters.`);
    if (this.startingTargets.has(target) || [...this.sessions.values()].some((session) => session.target === target && !session.closed)) throw new Error('Close the existing diagnostic session before starting another.');
    this.startingTargets.add(target);
    let session: Session | undefined;
    try {
      const id = randomUUID();
      const profile = await mkdtemp(path.join(this.profileRoot, `tt003-${target}-`));
      session = { id, target, profile, sequence: 0, pending: new Map(), buffer: '', busy: false, closed: false };
      this.sessions.set(id, session);
      this.publish(target, { type: 'state', state: 'starting' });
      if (target === 'codex') await this.startCodex(session, executable, prompt);
      else await this.startCopilot(session, executable, prompt);
      return { sessionId: id };
    } catch (error) {
      if (session) await this.close(session);
      throw error;
    } finally {
      this.startingTargets.delete(target);
    }
  }

  async followUp(target: AgentTarget, id: string, prompt: string) {
    const session = this.requireSession(target, id);
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS) throw new Error(`Enter a question of 1–${MAX_PROMPT_CHARS} characters.`);
    if (session.busy) throw new Error('Wait for the current reply to finish or cancel it first.');
    if (target === 'codex') {
      session.busy = true;
      this.publish(target, { type: 'state', state: 'running' });
      await this.startCodexTurn(session, prompt);
      return { accepted: true as const };
    }
    if (!session.copilotSdk) throw new Error('The Copilot diagnostic session is no longer available.');
    session.busy = true;
    try {
      await session.copilotSdk.send(prompt);
      this.scheduleTurnTimeout(session);
    } catch {
      session.busy = false;
      await this.close(session);
      throw new Error('Copilot diagnostic turn failed or timed out.');
    }
    return { accepted: true as const };
  }

  async cancel(target: AgentTarget, id: string) {
    const session = this.requireSession(target, id);
    if (!session.busy) return { cancelled: false };
    if (target === 'codex' && session.threadId && session.turnId) {
      const turnId = session.turnId;
      try {
        await this.request(session, 'turn/interrupt', { threadId: session.threadId, turnId }, 5000);
        const status = await this.waitForTurnCompletion(session, turnId, 5000);
        if (status !== 'interrupted') throw new Error('Codex completed the turn without confirming interruption.');
        return { cancelled: true };
      } catch {
        this.publish(target, { type: 'error', code: 'CANCEL_UNCONFIRMED', message: 'Codex did not confirm cancellation; the owned diagnostic session was closed.' });
        await this.close(session);
        throw new Error('Codex did not confirm cancellation; the owned diagnostic session was closed.');
      }
    } else if (target === 'copilot' && session.copilotSdk) {
      try {
        const result = await session.copilotSdk.cancel();
        if (!result.cancelled) throw new Error('Copilot did not confirm cancellation.');
        clearTimeout(session.timeout);
        return result;
      } catch {
        this.publish(target, { type: 'error', code: 'CANCEL_UNCONFIRMED', message: 'Copilot did not confirm cancellation; the owned diagnostic session was closed.' });
        await this.close(session);
        throw new Error('Copilot did not confirm cancellation; the owned diagnostic session was closed.');
      }
    }
    this.publish(target, { type: 'error', code: 'CANCEL_UNAVAILABLE', message: 'The active turn could not be confirmed or cancelled; the owned diagnostic session was closed.' });
    await this.close(session);
    throw new Error('The active turn could not be confirmed or cancelled; the owned diagnostic session was closed.');
  }

  private waitForTurnCompletion(session: Session, turnId: string, timeoutMs: number) {
    if (session.completedTurnId === turnId && session.completedTurnStatus) return Promise.resolve(session.completedTurnStatus);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.turnCompletionWaiter?.turnId === turnId) session.turnCompletionWaiter = undefined;
        reject(new Error('Codex did not confirm turn completion.'));
      }, timeoutMs);
      session.turnCompletionWaiter = {
        turnId,
        timer,
        resolve: (status) => { clearTimeout(timer); session.turnCompletionWaiter = undefined; resolve(status); },
        reject: (error) => { clearTimeout(timer); session.turnCompletionWaiter = undefined; reject(error); },
      };
    });
  }

  async closeSession(target: AgentTarget, id: string) {
    const session = this.requireSession(target, id);
    await this.close(session);
    return { closed: true as const };
  }

  async closeAll() {
    const results = await Promise.allSettled([...this.sessions.values()].map((session) => this.close(session)));
    if (results.some((result) => result.status === 'rejected')) throw new Error('One or more owned diagnostic runtimes could not confirm cleanup.');
  }

  private scheduleTurnTimeout(session: Session) {
    clearTimeout(session.timeout);
    if (session.closed || !session.busy) return;
    session.timeout = setTimeout(() => { void this.handleTurnTimeout(session); }, this.turnTimeoutMs);
  }

  private async handleTurnTimeout(session: Session) {
    if (session.closed || session.closing || !session.busy) return;
    this.publish(session.target, { type: 'error', code: 'TURN_TIMEOUT', message: 'The diagnostic turn reached its time limit; cancellation was requested.' });
    try {
      const result = await this.cancel(session.target, session.id);
      if (!result.cancelled && !session.closed) throw new Error('Cancellation was not confirmed.');
    } catch {
      if (session.closed) return;
      try {
        await this.close(session);
      } catch {
        this.publish(session.target, { type: 'error', code: 'CLEANUP_UNCONFIRMED', message: 'The owned diagnostic runtime may still be active; the session remains blocked.' });
      }
    }
  }

  private requireSession(target: AgentTarget, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.target !== target || session.closed || session.closing) throw new Error('The diagnostic session is no longer available. Start a new session.');
    return session;
  }

  private async startCodex(session: Session, executable: string, prompt: string) {
    if (!this.codexFeatureConfig) throw new Error(this.codexFeatureBlockMessage);
    if (!this.codexMcpOverrides) throw new Error('Codex MCP inventory could not be verified; the diagnostic session was stopped.');
    session.fixtureServerName = `archivist_tt003_${session.id.replaceAll('-', '').slice(0, 10)}`;
    const fixturePath = path.join(session.profile, 'catalogue-mcp-fixture.cjs');
    await writeFile(fixturePath, SYNTHETIC_MCP_FIXTURE_SOURCE, { mode: 0o700 });
    const fixtureConfig = `mcp_servers.${session.fixtureServerName}={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(fixturePath)}],env={ELECTRON_RUN_AS_NODE="1"},enabled=true}`;
    const child = spawn(executable, ['app-server', '--stdio', ...this.codexFeatureConfig, ...this.codexMcpOverrides, '-c', fixtureConfig, '-c', 'analytics.enabled=false'], {
      cwd: session.profile, env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    this.attachLineProcess(session, child, 'codex');
    await this.request(session, 'initialize', { clientInfo: { name: 'archivist_tt003', title: 'Archivist diagnostic', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.writeLine(session, { method: 'initialized', params: {} });
    const response = await this.request(session, 'thread/start', {
      cwd: session.profile, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, model: undefined,
      dynamicTools: [],
    });
    const thread = response?.thread;
    if (!thread?.id) throw new Error('Codex did not create a diagnostic thread.');
    session.threadId = thread.id;
    const [mcp, apps, skills] = await Promise.all([
      this.request(session, 'mcpServerStatus/list', { threadId: thread.id, cursor: null, limit: 50, detail: 'toolsAndAuthOnly' }),
      this.request(session, 'app/installed', { threadId: thread.id, forceRefresh: false }),
      this.request(session, 'skills/list', { cwds: [session.profile], forceReload: true }),
    ]);
    const issue = codexContextIssue(session.profile, response.instructionSources, mcp, apps, skills, session.fixtureServerName);
    if (issue) throw new Error(`${issue} The session was stopped.`);
    this.publish('codex', { type: 'info', version: this.versions.codex, ...(typeof response.model === 'string' ? { model: response.model } : {}) });
    session.busy = true;
    this.publish('codex', { type: 'state', state: 'ready' });
    await this.startCodexTurn(session, prompt);
  }

  private async startCodexTurn(session: Session, prompt: string) {
    session.turnId = undefined;
    const response = await this.request(session, 'turn/start', {
      threadId: session.threadId, input: [{ type: 'text', text: prompt }], cwd: session.profile,
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', access: { type: 'restricted', readableRoots: [session.profile], includePlatformDefaults: false }, networkAccess: false },
    });
    if (!response?.turn?.id) throw new Error('Codex did not accept the diagnostic turn.');
    session.turnId = response.turn.id;
    if (typeof response.turn.model === 'string') this.publish('codex', { type: 'info', version: this.versions.codex, model: response.turn.model });
    session.busy = true;
    this.scheduleTurnTimeout(session);
  }

  private async startCopilot(session: Session, executable: string, prompt: string) {
    const fixturePath = path.join(session.profile, 'catalogue-mcp-fixture.cjs');
    await writeFile(fixturePath, SYNTHETIC_MCP_FIXTURE_SOURCE, { mode: 0o700 });
    let sdk: CopilotSdkSession;
    try {
      sdk = await CopilotSdkSession.create({
        executable,
        profile: session.profile,
        fixturePath,
        publish: (event) => {
          if (event.type === 'state') {
            if (event.state === 'running' || event.state === 'ready') session.busy = true;
            if (['completed', 'cancelled', 'failed', 'closed'].includes(event.state)) {
              session.busy = false;
              clearTimeout(session.timeout);
            }
            if (event.state === 'closed') void this.finalizeSession(session, false).catch(() => {
              this.publish('copilot', { type: 'error', code: 'CLEANUP_UNCONFIRMED', message: 'Copilot session files could not be confirmed for cleanup; the session remains blocked.' });
            });
          }
          this.publish('copilot', event);
        },
      });
    } catch {
      throw new Error('Copilot session setup failed its bounded runtime check; no diagnostic turn was sent.');
    }
    session.copilotSdk = sdk;
    this.publish('copilot', { type: 'info', version: `Copilot CLI ${this.versions.copilot} · SDK ${sdk.sdkVersion}` });
    this.publish('copilot', { type: 'state', state: 'ready' });
    session.busy = true;
    await sdk.send(prompt);
    this.scheduleTurnTimeout(session);
  }

  private attachLineProcess(session: Session, child: ChildProcess, target: AgentTarget) {
    if (!child.stdout || !child.stdin) throw new Error('The Codex diagnostic process streams are unavailable.');
    session.process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      session.buffer += chunk;
      if (session.buffer.length > 1_000_000) {
        this.publish(target, { type: 'error', code: 'OUTPUT_LIMIT', message: 'Agent output exceeded the diagnostic limit.' });
        void this.close(session).catch(() => this.publish(target, { type: 'error', code: 'CLEANUP_UNCONFIRMED', message: 'The owned diagnostic runtime may still be active; the session remains blocked.' }));
        return;
      }
      let newline: number;
      while ((newline = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, newline); session.buffer = session.buffer.slice(newline + 1);
        const message = readNewlineFrames(`${line}\n`).messages[0]; if (message) void this.onCodexMessage(session, message);
      }
    });
    child.on('error', () => this.failProcess(session, target));
    child.on('exit', () => { if (!session.closed && session.busy) this.failProcess(session, target); });
  }

  private async onCodexMessage(session: Session, message: Json) {
    if (message.id !== undefined && session.pending.has(message.id)) {
      const pending = session.pending.get(message.id)!; session.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(codexRequestFailure(pending.method, message.error));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') this.publish('codex', { type: 'reply', text: message.params.delta.slice(0, MAX_REPLY_CHARS) });
    if (['item/started', 'item/completed'].includes(String(message.method)) && message.params?.item && typeof message.params.item.type === 'string') {
      const item = message.params.item as Json;
      const itemType = item.type as string;
      const server = typeof item.server === 'string' ? item.server : '';
      const tool = typeof item.tool === 'string' ? item.tool : '';
      const eventStatus = message.method === 'item/started' ? 'started' : 'completed';
      if (itemType === 'mcpToolCall') {
        const permitted = server === session.fixtureServerName && tool === 'catalogue_search';
        this.publish('codex', { type: 'tool', name: permitted ? `${server}(${tool})` : 'unrelated-tool', status: eventStatus });
        if (!permitted) {
          this.publish('codex', { type: 'error', code: 'UNEXPECTED_TOOL_EVENT', message: 'Codex emitted an unexpected MCP tool event; the diagnostic session was stopped.' });
          void this.close(session);
        }
      } else if (!['agentMessage', 'reasoning', 'userMessage', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode'].includes(itemType)) {
        this.publish('codex', { type: 'tool', name: 'unrelated-tool', status: eventStatus });
        this.publish('codex', { type: 'error', code: 'UNEXPECTED_TOOL_EVENT', message: 'Codex emitted an unexpected tool event; the diagnostic session was stopped.' });
        void this.close(session);
      }
    }
    if (message.method === 'turn/completed') {
      const completedTurnId = message.params?.turn?.id;
      if (!session.turnId || completedTurnId !== session.turnId) return;
      clearTimeout(session.timeout); session.busy = false; session.turnId = undefined;
      const status = message.params?.turn?.status;
      session.completedTurnId = completedTurnId; session.completedTurnStatus = status;
      this.publish('codex', { type: 'state', state: status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed' });
      const waiter = session.turnCompletionWaiter;
      if (waiter && waiter.turnId === completedTurnId) waiter.resolve(typeof status === 'string' ? status : 'unknown');
    }
    if (message.method === 'item/tool/call') {
      this.publish('codex', { type: 'tool', name: 'unrelated-tool', status: 'denied' });
      this.writeLine(session, { id: message.id, error: { code: -32601, message: 'Unsupported request denied by the diagnostic client.' } });
      return;
    }
    if (message.id !== undefined && message.method && /requestApproval$/.test(message.method)) {
      this.publish('codex', { type: 'tool', name: 'unrelated-tool', status: 'denied' });
      this.writeLine(session, { id: message.id, result: { decision: 'decline' } });
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      this.publish('codex', { type: 'tool', name: 'unrecognized-request', status: 'denied' });
      this.writeLine(session, { id: message.id, error: { code: -32601, message: 'Unsupported request denied by the diagnostic client.' } });
    }
  }

  private request(session: Session, method: string, params: unknown, timeoutMs = 10_000): Promise<any> {
    const id = ++session.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error('The agent protocol timed out.')); }, timeoutMs);
      session.pending.set(id, { method, resolve, reject, timer });
      this.writeLine(session, { id, method, params });
    });
  }

  private writeLine(session: Session, payload: Json) { if (session.process?.stdin?.writable) session.process.stdin.write(`${JSON.stringify(payload)}\n`); }

  private async close(session: Session) {
    if (session.closePromise) return session.closePromise;
    if (session.closed) return;
    session.closing = true;
    session.closePromise = (async () => {
      if (session.copilotSdk) {
        try {
          await session.copilotSdk.close();
          await this.finalizeSession(session, false);
        } catch {
          session.closing = false;
          throw new Error('Copilot owned-process cleanup could not be confirmed; the session remains blocked.');
        }
        return;
      }
      if (session.process && session.process.exitCode === null && session.process.signalCode === null) {
        const child = session.process;
        child.kill('SIGTERM');
        const exited = () => child.exitCode !== null || child.signalCode !== null;
        const waitForExit = () => exited() ? Promise.resolve() : new Promise<void>((resolve) => child.once('exit', () => resolve()));
        await Promise.race([waitForExit(), new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
        if (!exited()) {
          child.kill('SIGKILL');
          await Promise.race([waitForExit(), new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
        }
        if (!exited()) {
          session.closing = false;
          throw new Error('Owned diagnostic process did not exit; the session remains blocked.');
        }
      }
      await this.finalizeSession(session, true);
    })();
    return session.closePromise;
  }

  private finalizeSession(session: Session, publishClosed: boolean) {
    if (session.releasePromise) return session.releasePromise;
    session.closed = true;
    session.closing = true;
    session.busy = false;
    clearTimeout(session.timeout);
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The diagnostic session closed.')); }
    session.pending.clear();
    session.turnCompletionWaiter?.reject(new Error('The diagnostic session closed before turn completion.'));
    session.releasePromise = (async () => {
      this.sessions.delete(session.id);
      await rm(session.profile, { recursive: true, force: true });
      if (publishClosed) this.publish(session.target, { type: 'state', state: 'closed' });
    })();
    return session.releasePromise;
  }

  private failProcess(session: Session, target: AgentTarget) {
    if (session.closed) return;
    this.publish(target, { type: 'error', code: 'AGENT_EXIT', message: 'The agent process ended before the diagnostic turn completed.' });
    this.publish(target, { type: 'state', state: 'failed' });
    void this.close(session).catch(() => this.publish(target, { type: 'error', code: 'CLEANUP_UNCONFIRMED', message: 'The owned diagnostic runtime may still be active; the session remains blocked.' }));
  }
}

export const SYNTHETIC_MCP_FIXTURE_SOURCE = String.raw`const readline = require('node:readline');
const hostileNote = ${JSON.stringify(HOSTILE_CATALOGUE_NOTE)};
const rows = [
  { ref: 'synthetic-film-001', title: 'Synthetic Feature', category: 'film', ownership: 'owned' },
  { ref: 'synthetic-tv-001', title: 'Synthetic Series', category: 'tv', ownership: 'reference_only' },
];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'notifications/initialized') return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'archivist-synthetic-catalogue', version: '0.1.0' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'catalogue_search', description: 'Search fixed synthetic holdings.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 80 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
  else if (message.method === 'tools/call') {
    const rawQuery = message.params?.arguments?.query;
    const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
    if (message.params?.name !== 'catalogue_search' || !query || typeof rawQuery !== 'string' || rawQuery.length > 80 || Object.keys(message.params?.arguments || {}).some((key) => key !== 'query')) result = { isError: true, content: [{ type: 'text', text: 'Denied: invalid or unknown tool.' }] };
    else { const records = query === 'hostile' ? [{ ...rows[0], untrustedNote: hostileNote }] : rows.filter((row) => row.title.toLowerCase().includes(query) || row.category.includes(query)); result = { content: [{ type: 'text', text: JSON.stringify({ records }) }] }; }
  } else if (message.id !== undefined) result = { isError: true, content: [{ type: 'text', text: 'Denied: unknown MCP operation.' }] };
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});`;
