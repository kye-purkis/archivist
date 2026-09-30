import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CopilotClient, RuntimeConnection, type PermissionRequest, type SessionEvent } from '@github/copilot-sdk';
import { SYNTHETIC_MCP_FIXTURE_SOURCE } from '../src/main/agent-sessions';

const runLive = process.env.TT003_COPILOT_LIVE_BOUNDARY === '1';
const liveDescribe = runLive ? describe : describe.skip;
const RPC_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 12_000;

type Attempt = { name: string; resultType: string; errorCode?: string; shellMarkerReturned?: boolean; canaryReturned?: boolean };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function resultType(result: unknown): string {
  if (typeof result === 'string') return 'string';
  if (result && typeof result === 'object' && 'resultType' in result && typeof result.resultType === 'string') return result.resultType;
  return 'unknown';
}

function safeCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,48}$/.test(code) ? code : undefined;
}

function cleanEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of [
    'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP',
    'TMP', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

liveDescribe('Copilot SDK live effective-tool execution boundary (opt-in)', () => {
  it('refuses direct execution of every tool outside the single synthetic catalogue search', async () => {
    const executable = process.env.TT003_COPILOT_CLI || execFileSync('/usr/bin/which', ['copilot'], {
      encoding: 'utf8', timeout: 2_500, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const cliVersion = execFileSync(executable, ['--version'], {
      encoding: 'utf8', timeout: 2_500, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/, 1)[0].trim().slice(0, 100);
    expect(cliVersion).toContain('1.0.88');

    const scratch = await mkdtemp(path.join('/tmp', 'archivist-tt003-copilot-boundary-'));
    const profile = path.join(scratch, 'session-profile');
    const fixturePath = path.join(profile, 'catalogue-mcp-fixture.cjs');
    const canaryPath = path.join(scratch, 'outside-session-canary.txt');
    const canary = `TT003_READ_CANARY_${randomUUID()}`;
    await mkdir(profile, { mode: 0o700 });
    await writeFile(fixturePath, SYNTHETIC_MCP_FIXTURE_SOURCE, { mode: 0o700 });
    await writeFile(canaryPath, canary, { mode: 0o600 });

    const permissionKinds: string[] = [];
    const starts: Array<{ name: string; server?: string; mcpTool?: string }> = [];
    const successfulCompletions: string[] = [];
    let client: CopilotClient | undefined;
    let session: Awaited<ReturnType<CopilotClient['createSession']>> | undefined;
    let setupError = false;
    const attempts: Attempt[] = [];
    let report: Record<string, unknown> = {};
    try {
      client = new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: executable, args: ['--no-custom-instructions'] }),
        mode: 'empty',
        workingDirectory: profile,
        baseDirectory: profile,
        env: cleanEnvironment(),
        logLevel: 'none',
        useLoggedInUser: true,
      });
      await withTimeout(client.start(), RPC_TIMEOUT_MS, 'Copilot CLI startup timed out.');
      session = await withTimeout(client.createSession({
        clientName: 'archivist-tt003-boundary-probe',
        configDirectory: profile,
        workingDirectory: profile,
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
        availableTools: ['mcp:archivist-catalogue-catalogue_search'],
        excludedTools: ['builtin:*', 'custom:*'],
        mcpServers: {
          'archivist-catalogue': {
            type: 'local',
            command: process.execPath,
            args: [fixturePath],
            env: { ELECTRON_RUN_AS_NODE: '1' },
            workingDirectory: profile,
            tools: ['catalogue_search'],
            timeout: 5_000,
          },
        },
        onPermissionRequest: (request: PermissionRequest) => {
          permissionKinds.push(request.kind);
          if (request.kind === 'mcp' && request.serverName === 'archivist-catalogue' && request.toolName === 'catalogue_search' && request.readOnly) {
            return { kind: 'approve-once' };
          }
          return { kind: 'reject', feedback: 'Only the read-only synthetic catalogue search is allowed.' };
        },
      }), RPC_TIMEOUT_MS, 'Copilot session creation timed out.');
      session.on('tool.execution_start', (event: Extract<SessionEvent, { type: 'tool.execution_start' }>) => {
        starts.push({ name: event.data.toolName, ...(event.data.mcpServerName ? { server: event.data.mcpServerName } : {}), ...(event.data.mcpToolName ? { mcpTool: event.data.mcpToolName } : {}) });
      });
      session.on('tool.execution_complete', (event: Extract<SessionEvent, { type: 'tool.execution_complete' }>) => {
        if (event.data.success) successfulCompletions.push(event.data.toolCallId);
      });

      await withTimeout(session.rpc.tools.initializeAndValidate(), RPC_TIMEOUT_MS, 'Tool inventory initialization timed out.');
      const inventory = await withTimeout(session.rpc.tools.getCurrentMetadata(), RPC_TIMEOUT_MS, 'Effective tool inventory timed out.');
      const effectiveTools = inventory.tools ?? [];
      const expected = effectiveTools.length === 1 && effectiveTools[0].name === 'archivist-catalogue-catalogue_search' && effectiveTools[0].mcpServerName === 'archivist-catalogue' && effectiveTools[0].mcpToolName === 'catalogue_search';
      if (!expected) {
        setupError = true;
        report = { cliVersion, sdkVersion: '1.0.14', effectiveToolCount: effectiveTools.length, effectiveToolNames: effectiveTools.map((tool) => tool.name.slice(0, 100)), setup: 'blocked-unexpected-tool-inventory' };
        expect(expected, JSON.stringify(report)).toBe(true);
      }

      const probes: Array<{ name: string; arguments: Record<string, unknown> }> = [
        { name: 'shell', arguments: { command: 'printf TT003_SHELL_MARKER' } },
        { name: 'read_file', arguments: { path: canaryPath, filePath: canaryPath, fileName: canaryPath } },
        { name: 'web_fetch', arguments: { url: 'https://example.com' } },
        { name: 'archivist-catalogue-catalogue_write', arguments: { operation: 'delete', query: 'synthetic-probe' } },
      ];
      for (const probe of probes) {
        try {
          const result = await withTimeout(session.rpc.tools.execute({
            name: probe.name,
            arguments: probe.arguments as never,
            toolCallId: randomUUID(),
          }), RPC_TIMEOUT_MS, 'Direct tool execution probe timed out.');
          const serializedResult = JSON.stringify(result);
          attempts.push({
            name: probe.name,
            resultType: resultType(result),
            shellMarkerReturned: serializedResult.includes('TT003_SHELL_MARKER'),
            canaryReturned: serializedResult.includes(canary),
          });
        } catch (error) {
          attempts.push({ name: probe.name, resultType: 'threw', ...(safeCode(error) ? { errorCode: safeCode(error) } : {}) });
        }
      }
      const canaryUnchanged = (await readFile(canaryPath, 'utf8')) === canary;
      const reportSafe = {
        cliVersion,
        sdkVersion: '1.0.14',
        effectiveToolNames: effectiveTools.map((tool) => tool.name.slice(0, 100)),
        attempts,
        permissionRequestKinds: permissionKinds,
        executionStarts: starts,
        successfulDisallowedExecutionCount: successfulCompletions.length,
        shellMarkerReturned: attempts.some((attempt) => attempt.shellMarkerReturned),
        canaryReturned: attempts.some((attempt) => attempt.canaryReturned),
        canaryUnchanged,
      };
      report = reportSafe;

      expect(attempts).toHaveLength(probes.length);
      expect(attempts.every((attempt) => attempt.resultType === 'failure'), JSON.stringify(reportSafe)).toBe(true);
      expect(starts, JSON.stringify(reportSafe)).toHaveLength(0);
      expect(permissionKinds, JSON.stringify(reportSafe)).toHaveLength(0);
      expect(successfulCompletions, JSON.stringify(reportSafe)).toHaveLength(0);
      expect(attempts.some((attempt) => attempt.shellMarkerReturned), JSON.stringify(reportSafe)).toBe(false);
      expect(attempts.some((attempt) => attempt.canaryReturned), JSON.stringify(reportSafe)).toBe(false);
      expect(canaryUnchanged, JSON.stringify(reportSafe)).toBe(true);
    } finally {
      const cleanupErrors: string[] = [];
      if (session && client) {
        try { await withTimeout(session.disconnect(), CLEANUP_TIMEOUT_MS, 'Session detach timed out.'); } catch { cleanupErrors.push('session-detach-unconfirmed'); }
        try { await withTimeout(client.deleteSession(session.sessionId), CLEANUP_TIMEOUT_MS, 'Session deletion timed out.'); } catch { cleanupErrors.push('session-delete-unconfirmed'); }
      }
      if (client) {
        try {
          const errors = await withTimeout(client.stop(), CLEANUP_TIMEOUT_MS, 'Owned Copilot CLI stop timed out.');
          if (errors.length > 0) {
            cleanupErrors.push('sdk-stop-reported-error');
            await withTimeout(client.forceStop(), CLEANUP_TIMEOUT_MS, 'Owned Copilot CLI force stop timed out.');
          }
        } catch {
          try { await withTimeout(client.forceStop(), CLEANUP_TIMEOUT_MS, 'Owned Copilot CLI force stop timed out.'); }
          catch { cleanupErrors.push('owned-process-stop-unconfirmed'); }
        }
      }
      try { await rm(scratch, { recursive: true, force: true }); } catch { cleanupErrors.push('temporary-probe-data-removal-unconfirmed'); }
      process.stdout.write(`${JSON.stringify({ probe: 'TT-003 Copilot SDK direct execution boundary', setupError, report, cleanupErrors })}\n`);
      expect(cleanupErrors).toEqual([]);
    }
  }, 180_000);
});
