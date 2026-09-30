import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const listeners = new Map<string, (event: any) => void>();
  const state: {
    options?: any;
    createSession: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    forceStop: ReturnType<typeof vi.fn>;
    initializeAndValidate: ReturnType<typeof vi.fn>;
    getCurrentMetadata: ReturnType<typeof vi.fn>;
    listeners: typeof listeners;
  } = {
    createSession: vi.fn(),
    start: vi.fn(),
    send: vi.fn(),
    abort: vi.fn(),
    deleteSession: vi.fn(),
    disconnect: vi.fn(),
    stop: vi.fn(),
    forceStop: vi.fn(),
    initializeAndValidate: vi.fn(),
    getCurrentMetadata: vi.fn(),
    listeners,
  };
  return state;
});

vi.mock('@github/copilot-sdk', () => ({
  RuntimeConnection: { forStdio: vi.fn((options) => ({ kind: 'stdio', ...options })) },
  CopilotClient: vi.fn(function(this: unknown, options: unknown) {
    sdk.options = options;
    return {
      start: sdk.start,
      createSession: sdk.createSession,
      deleteSession: sdk.deleteSession,
      stop: sdk.stop,
      forceStop: sdk.forceStop,
    };
  }),
}));

import { CopilotSdkSession } from '../src/main/copilot-sdk-session';

const approvedTools = [{
  name: 'archivist-catalogue-catalogue_search',
  mcpServerName: 'archivist-catalogue',
  mcpToolName: 'catalogue_search',
  description: 'synthetic catalogue search',
}];

function makeSession() {
  sdk.listeners.clear();
  return {
    sessionId: 'owned-session-1',
    on: vi.fn((type: string, handler: (event: any) => void) => {
      sdk.listeners.set(type, handler);
      return () => sdk.listeners.delete(type);
    }),
    send: sdk.send,
    abort: sdk.abort,
    disconnect: sdk.disconnect,
    rpc: { tools: { initializeAndValidate: sdk.initializeAndValidate, getCurrentMetadata: sdk.getCurrentMetadata } },
  };
}

async function createAdapter(publish = vi.fn()) {
  const adapter = await CopilotSdkSession.create({
    executable: '/usr/local/bin/copilot',
    profile: '/tmp/tt003-profile',
    fixturePath: '/tmp/tt003-profile/catalogue-fixture.cjs',
    publish,
  });
  return { adapter, publish };
}

describe('Copilot SDK adapter fail-closed lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.listeners.clear();
    sdk.start.mockResolvedValue(undefined);
    sdk.createSession.mockImplementation(() => Promise.resolve(makeSession()));
    sdk.send.mockResolvedValue('message-1');
    sdk.abort.mockResolvedValue(undefined);
    sdk.deleteSession.mockResolvedValue(undefined);
    sdk.disconnect.mockResolvedValue(undefined);
    sdk.stop.mockResolvedValue([]);
    sdk.forceStop.mockResolvedValue(undefined);
    sdk.initializeAndValidate.mockResolvedValue(undefined);
    sdk.getCurrentMetadata.mockResolvedValue({ tools: approvedTools });
  });

  it('blocks the first send when the effective tool inventory contains an extra tool', async () => {
    sdk.getCurrentMetadata.mockResolvedValue({ tools: [...approvedTools, { name: 'shell' }] });
    await expect(createAdapter()).rejects.toThrow('effective tool inventory');
    expect(sdk.send).not.toHaveBeenCalled();
    expect(sdk.deleteSession).toHaveBeenCalledWith('owned-session-1');
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('denies an unknown MCP permission request', async () => {
    const { adapter } = await createAdapter();
    const config = sdk.createSession.mock.calls[0][0];
    const result = await config.onPermissionRequest({
      kind: 'mcp', serverName: 'untrusted-server', toolName: 'write_file', readOnly: false,
    }, { sessionId: 'owned-session-1' });
    expect(result).toMatchObject({ kind: 'reject' });
    await adapter.close();
  });

  it('does not report cancellation when idle says the turn completed normally', async () => {
    const { adapter, publish } = await createAdapter();
    await adapter.send('bounded prompt');
    sdk.abort.mockImplementation(async () => {
      sdk.listeners.get('session.idle')?.({ data: { aborted: false } });
    });
    await expect(adapter.cancel()).resolves.toEqual({ cancelled: false });
    expect(publish).toHaveBeenCalledWith({ type: 'state', state: 'completed' });
    await adapter.close();
  });

  it('reports the actual model from assistant usage and does not infer it from auto routing', async () => {
    const { adapter, publish } = await createAdapter();
    await adapter.send('bounded prompt');
    sdk.listeners.get('assistant.turn_start')?.({ data: { model: 'auto' } });
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'info', model: 'auto' }));
    sdk.listeners.get('assistant.usage')?.({ data: { model: 'gpt-6-sol', cost: 123, billingAccount: 'private' } });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', model: 'gpt-6-sol' }));
    expect(JSON.stringify(publish.mock.calls)).not.toContain('billingAccount');
    sdk.listeners.get('session.idle')?.({ data: { aborted: false } });
    await adapter.close();
  });

  it('reports cleanup failure if both SDK stop paths fail', async () => {
    const { adapter } = await createAdapter();
    sdk.stop.mockResolvedValue([new Error('redacted')]);
    sdk.forceStop.mockRejectedValue(new Error('redacted'));
    await expect(adapter.close()).rejects.toThrow('force stop was not confirmed');
    expect(sdk.stop).toHaveBeenCalledOnce();
    expect(sdk.forceStop).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure when runtime stop times out and force stop cannot confirm', async () => {
    const { adapter } = await createAdapter();
    vi.useFakeTimers();
    sdk.stop.mockReturnValue(new Promise(() => undefined));
    sdk.forceStop.mockRejectedValue(new Error('redacted'));
    const close = adapter.close();
    const rejected = expect(close).rejects.toThrow('force stop was not confirmed');
    try {
      await vi.advanceTimersByTimeAsync(12_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an unexpected tool execution event as a boundary failure and closes', async () => {
    const { adapter, publish } = await createAdapter();
    sdk.listeners.get('tool.execution_start')?.({ data: {
      toolName: 'shell', toolCallId: 'unexpected-1', mcpServerName: undefined, mcpToolName: undefined,
    } });
    await vi.waitFor(() => expect(sdk.stop).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', code: 'TOOL_BOUNDARY_FAILURE' }));
    expect(publish).toHaveBeenCalledWith({ type: 'state', state: 'closed' });
  });
});
