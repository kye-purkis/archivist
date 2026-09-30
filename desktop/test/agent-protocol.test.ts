import { describe, expect, it, vi } from 'vitest';
import { catalogueSearch, codexContextIssue, codexEnabledFeatures, codexFeatureOverrides, codexFeaturesAreRestricted, codexMcpServerNames, codexRequestFailure, HOSTILE_CATALOGUE_NOTE, readNewlineFrames } from '../src/main/agent-protocol';
import { MAX_PROMPT_CHARS, safeAgentError, validPrompt } from '../src/contracts/agents';
import { AgentSessions } from '../src/main/agent-sessions';
import { SYNTHETIC_MCP_FIXTURE_SOURCE } from '../src/main/agent-sessions';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const copilotSdkMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/main/copilot-sdk-session', () => ({ CopilotSdkSession: { create: copilotSdkMock.create } }));

describe('TT-003 protocol boundaries', () => {
  it('accepts bounded synthetic prompts and rejects empty or oversized input', () => {
    expect(validPrompt('hello')).toBe(true);
    expect(validPrompt(' '.repeat(2))).toBe(false);
    expect(validPrompt('x'.repeat(MAX_PROMPT_CHARS + 1))).toBe(false);
    expect(validPrompt(null)).toBe(false);
  });

  it('parses complete newline frames, retains partial data, and ignores malformed messages', () => {
    const first = readNewlineFrames('{"id":1}\nnot-json\n{"id":');
    expect(first.messages).toEqual([{ id: 1 }]);
    expect(first.malformed).toBe(1);
    expect(first.remainder).toBe('{"id":');
  });

  it('permits only the fixed read-only synthetic callback and rejects unknown or malformed tools', () => {
    expect(catalogueSearch({ query: 'feature' })).toEqual({ denied: false, records: [{ ref: 'synthetic-film-001', title: 'Synthetic Feature', category: 'film', ownership: 'owned' }] });
    expect(catalogueSearch({ query: 'tv' }).denied).toBe(false);
    expect(catalogueSearch({ query: 'hostile' })).toMatchObject({ denied: false, records: [{ ref: 'synthetic-film-001', untrustedNote: HOSTILE_CATALOGUE_NOTE }] });
    expect(catalogueSearch({ query: '' })).toMatchObject({ denied: true });
    expect(catalogueSearch({ query: 'x'.repeat(81) })).toMatchObject({ denied: true });
    expect(catalogueSearch({ operation: 'delete', query: 'feature' })).toMatchObject({ denied: true });
  });

  it('fails closed when Codex reports inherited instruction, MCP, connector, skill, or incomplete audit state', () => {
    const root = path.join(os.tmpdir(), 'tt003-profile');
    const clean = (sources: unknown = [], mcp: unknown = { data: [], nextCursor: null }, apps: unknown = { apps: [] }, skills: unknown = { data: [{ skills: [] }] }) => codexContextIssue(root, sources, mcp, apps, skills);
    expect(clean([path.join(root, 'AGENTS.md')])).toBeNull();
    expect(clean(['/tmp/codex/AGENTS.md'])).toContain('instruction source');
    expect(clean([], { data: [{ name: 'inherited-mcp' }] })).toContain('MCP servers');
    expect(clean([], { data: [], nextCursor: 'more' })).toContain('MCP inventory');
    expect(clean([], { data: [{ runtimeStatus: 'disabled', tools: {} }], nextCursor: null })).toContain('MCP servers');
    expect(clean([], { data: [] }, { apps: [{ callable: true }] })).toContain('connector tools');
    expect(clean([], { data: [], nextCursor: null }, { apps: [{ id: 'app', callable: true }] })).toContain('connector tools');
    expect(clean([], { data: [], nextCursor: null }, { apps: [{ id: 'app' }] })).toContain('connector tools');
    expect(clean([], { data: [], nextCursor: null }, { apps: [] }, { data: [{ skills: [{ name: 'inherited' }] }] })).toContain('skills');
    expect(clean([], { data: [], nextCursor: null }, { apps: [] }, { data: [{}] })).toContain('skills');
    expect(clean(null)).toContain('instruction source');
    expect(clean([], null)).toContain('MCP servers');
  });

  it('sanitizes unexpected and malformed errors', () => {
    expect(safeAgentError('BAD_REQUEST', 'line 1\nline 2')).toEqual({ code: 'BAD_REQUEST', message: 'line 1 line 2' });
    expect(safeAgentError('secret\npath', undefined)).toEqual({ code: 'AGENT_ERROR', message: 'The agent request failed.' });
  });

  it('identifies a rejected Codex method and code without forwarding server payloads', () => {
    const failure = codexRequestFailure('thread/start', { code: -32602, message: 'token=do-not-show /tmp/private/path' });
    expect(failure.message).toBe('Codex App Server rejected thread/start (code -32602).');
    expect(codexRequestFailure('secret path', { code: 'invalid', message: 'do not show' }).message).toBe('Codex App Server rejected unknown-method (code unknown).');
  });

  it('validates the Codex MCP inventory and accepts only explicitly disabled, empty entries', () => {
    expect(codexMcpServerNames([{ name: 'safe_server' }, { name: 'another-server' }])).toEqual(['safe_server', 'another-server']);
    expect(codexMcpServerNames([{ name: 'unsafe.name' }])).toBeUndefined();
    expect(codexMcpServerNames({ result: [] })).toBeUndefined();
    const clean = codexContextIssue(path.join(os.tmpdir(), 'tt003-profile'), [], { data: [{ name: 'inherited', runtimeStatus: 'disabled', tools: {} }], nextCursor: null }, { apps: [] }, { data: [{ skills: [] }] });
    expect(clean).toBeNull();
    const withFixture = codexContextIssue(path.join(os.tmpdir(), 'tt003-profile'), [], { data: [
      { name: 'inherited', runtimeStatus: 'disabled', tools: {} },
      { name: 'archivist_tt003_unique', runtimeStatus: 'connected', tools: { catalogue_search: {} } },
    ], nextCursor: null }, { apps: [] }, { data: [{ skills: [] }] }, 'archivist_tt003_unique');
    expect(withFixture).toBeNull();
    expect(codexContextIssue(path.join(os.tmpdir(), 'tt003-profile'), [], { data: [
      { name: 'inherited', runtimeStatus: 'disabled', tools: {} },
      { name: 'archivist_tt003_unique', runtimeStatus: 'connected', tools: { catalogue_search: {}, catalogue_write: {} } },
    ], nextCursor: null }, { apps: [] }, { data: [{ skills: [] }] }, 'archivist_tt003_unique')).toContain('MCP servers');
    expect(codexContextIssue(path.join(os.tmpdir(), 'tt003-profile'), [], { data: [{ name: 'active', runtimeStatus: 'connected', tools: {} }], nextCursor: null }, { apps: [] }, { data: [{ skills: [] }] })).toContain('active or unverifiable MCP');
    expect(codexContextIssue(path.join(os.tmpdir(), 'tt003-profile'), [], { data: [{ name: 'unknown', tools: {} }], nextCursor: null }, { apps: [] }, { data: [{ skills: [] }] })).toContain('active or unverifiable MCP');
  });

  it('disables and audits every effective Codex feature before starting the app server', () => {
    const initial = ['apps stable true', 'shell_tool stable true', 'unified_exec stable true', 'view_image stable true', 'browser_use stable true', 'computer_use stable true', 'hooks stable true', 'guardianv2.thread_context stable true'].join('\n');
    const overrides = codexFeatureOverrides(initial);
    expect(overrides).toContain('features.apps=false');
    expect(overrides).toContain('features.shell_tool=false');
    expect(overrides).toContain('features.unified_exec=false');
    expect(overrides).toContain('features.hooks=false');
    expect(overrides).toContain('features.guardianv2.thread_context=false');
    expect(codexFeaturesAreRestricted(initial.replaceAll('true', 'false'))).toBe(true);
    expect(codexFeaturesAreRestricted(initial)).toBe(false);
    expect(codexEnabledFeatures(initial)).toEqual(['apps', 'shell_tool', 'unified_exec', 'view_image', 'browser_use', 'computer_use', 'hooks', 'guardianv2.thread_context']);
    expect(codexFeatureOverrides('malformed feature output')).toBeUndefined();
  });

  it('runs only the owned Codex process, streams replies, accepts follow-up, and interrupts the active turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tt003-fake-codex-'));
    const bin = path.join(root, 'bin'); await mkdir(bin);
    const closed = path.join(root, 'closed'); const argsFile = path.join(root, 'codex-args.json'); const startParamsFile = path.join(root, 'start-params.json'); const mcpDebugFile = path.join(root, 'mcp-debug.json');
    const executable = path.join(bin, 'codex');
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'); let input=''; let turn=0; let active; let activeBehavior=''; if(process.argv[2]==='mcp'&&process.argv[3]==='list'){console.log(JSON.stringify([{name:'inherited-test'}]));process.exit(0)} if(process.argv[2]==='features'){const all=['apps','shell_tool','unified_exec','view_image','browser_use','computer_use','hooks','guardianv2.thread_context'];const disabled=new Set(process.argv.filter(x=>x.startsWith('features.')&&x.endsWith('=false')).map(x=>x.slice('features.'.length,-6)));console.log(all.map(x=>x+' stable '+(disabled.has(x)?'false':'true')).join('\\n'));process.exit(0)} if(process.argv.includes('--version')){console.log('codex fake 1.0');process.exit(0)} fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2))); const fixtureArg=process.argv.find(x=>x.includes('mcp_servers.archivist_tt003_')&&x.includes('enabled=true')); const fixtureName=fixtureArg?.split('mcp_servers.')[1]?.split('=')[0]; process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(closed)},'closed');process.exit(0)}); process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{input+=chunk;let i;while((i=input.indexOf('\\n'))>=0){const line=input.slice(0,i);input=input.slice(i+1);let m;try{m=JSON.parse(line)}catch{continue} const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'); if(m.method==='initialize')send({id:m.id,result:{}}); else if(m.method==='thread/start'){fs.writeFileSync(${JSON.stringify(startParamsFile)},JSON.stringify(m.params));send({id:m.id,result:{thread:{id:'fake-thread'},model:'fake-model',instructionSources:[]}})} else if(m.method==='mcpServerStatus/list'){const result={data:[{name:'inherited-test',runtimeStatus:'disabled',tools:{}},{name:fixtureName,runtimeStatus:'connected',tools:{catalogue_search:{}}}],nextCursor:null}; fs.writeFileSync(${JSON.stringify(mcpDebugFile)},JSON.stringify({fixtureArg,fixtureName,result}));send({id:m.id,result})} else if(m.method==='app/installed')send({id:m.id,result:{apps:[]}}); else if(m.method==='skills/list')send({id:m.id,result:{data:[{skills:[]}]}}); else if(m.method==='turn/start'){turn++; active='fake-turn-'+turn; activeBehavior=JSON.stringify(m.params.input); const turnId=active; send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}}); if(JSON.stringify(m.params.input).includes('lookup')){send({method:'item/started',params:{item:{type:'mcpToolCall',server:fixtureName,tool:'catalogue_search'}}});send({method:'item/completed',params:{item:{type:'mcpToolCall',server:fixtureName,tool:'catalogue_search',status:'completed'}}})} if(JSON.stringify(m.params.input).includes('unexpected'))send({method:'item/started',params:{item:{type:'commandExecution'}}}); if(!JSON.stringify(m.params.input).includes('hold'))setTimeout(()=>{send({method:'item/agentMessage/delta',params:{delta:'synthetic reply'}});send({method:'turn/completed',params:{turn:{id:turnId,status:'completed'}}})},10)} else if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{turn:{id:active,status:activeBehavior.includes('unconfirmed')?'completed':'interrupted'}}})} } });`);
    await chmod(executable, 0o700);
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ''}`;
    const sessions = new AgentSessions(root);
    const events: string[] = [];
    const unsubscribe = sessions.onEvent(event => events.push(event.type === 'reply' ? `reply:${event.text}` : event.type === 'state' ? event.state : event.type === 'info' && event.model ? `model:${event.model}` : event.type === 'error' ? `error:${event.code}` : event.type));
    try {
      const started = await sessions.start('codex', 'lookup feature');
      const codexArgs = JSON.parse(await readFile(argsFile, 'utf8'));
      expect(codexArgs).toContain('features.apps=false');
      expect(codexArgs).toContain('features.shell_tool=false');
      expect(codexArgs).toContain('features.unified_exec=false');
      expect(codexArgs).toContain('features.browser_use=false');
      expect(codexArgs).toContain('features.computer_use=false');
      expect(codexArgs).toContain('features.view_image=false');
      expect(codexArgs).toContain('features.hooks=false');
      expect(codexArgs.some((arg: string) => arg.startsWith('mcp_servers.archivist_tt003_') && arg.includes('enabled=true'))).toBe(true);
      expect(codexArgs).toContain('mcp_servers.codex_app={command="false",enabled=false}');
      expect(codexArgs).toContain('mcp_servers.codex_apps={command="false",enabled=false}');
      expect(codexArgs).toContain('mcp_servers.inherited-test={command="false",enabled=false}');
      const startParams = JSON.parse(await readFile(startParamsFile, 'utf8'));
      expect(startParams.ephemeral).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(events).toContain('reply:synthetic reply');
      expect(events).toContain('tool');
      expect(events).toContain('completed');
      expect(events).toContain('model:fake-model');
      await expect(sessions.followUp('codex', started.sessionId, 'another synthetic question')).resolves.toEqual({ accepted: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      const active = await sessions.followUp('codex', started.sessionId, 'hold this turn');
      expect(active.accepted).toBe(true);
      await expect(sessions.cancel('codex', started.sessionId)).resolves.toEqual({ cancelled: true });
      expect(events).toContain('cancelled');
      await expect(sessions.closeSession('codex', started.sessionId)).resolves.toEqual({ closed: true });
      expect(events).toContain('closed');
      const restarted = await sessions.start('codex', 'new synthetic session');
      expect(restarted.sessionId).not.toBe(started.sessionId);
      await expect(sessions.closeSession('codex', restarted.sessionId)).resolves.toEqual({ closed: true });
      const unconfirmed = await sessions.start('codex', 'hold with unconfirmed cancellation');
      await expect(sessions.cancel('codex', unconfirmed.sessionId)).rejects.toThrow('did not confirm cancellation');
      expect(events.filter(event => event === 'closed').length).toBeGreaterThanOrEqual(2);
      const starting = sessions.start('codex', 'parallel start reservation');
      await expect(sessions.start('codex', 'racing second start')).rejects.toThrow('Close the existing diagnostic session');
      const reserved = await starting;
      await expect(sessions.closeSession('codex', reserved.sessionId)).resolves.toEqual({ closed: true });
      const unexpected = await sessions.start('codex', 'unexpected command tool event');
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(events).toContain('error:UNEXPECTED_TOOL_EVENT');
      await expect(sessions.followUp('codex', unexpected.sessionId, 'must not continue')).rejects.toThrow('no longer available');
    } finally {
      unsubscribe(); await sessions.closeAll(); process.env.PATH = oldPath;
      await new Promise(resolve => setTimeout(resolve, 25));
      await expect(readFile(closed, 'utf8')).resolves.toBe('closed');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes Copilot through the pinned SDK, passes only the fixture, and owns cancel/close lifecycle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tt003-fake-copilot-'));
    const bin = path.join(root, 'bin'); await mkdir(bin);
    const executable = path.join(bin, 'copilot');
    await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('GitHub Copilot CLI 1.0.88');process.exit(0)} process.exit(0);`);
    await chmod(executable, 0o700);
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ''}`;
    copilotSdkMock.create.mockReset();
    const events: string[] = [];
    let sdkOptions: any;
    let publishSdkEvent: ((event: any) => void) | undefined;
    let sdkBusy = false;
    const sdk = {
      sdkVersion: '1.0.14',
      send: vi.fn(async (prompt: string) => {
        sdkBusy = true; publishSdkEvent?.({ type: 'state', state: 'running' });
        publishSdkEvent?.({ type: 'reply', text: `synthetic Copilot ${prompt}` });
        if (!prompt.includes('hold')) { sdkBusy = false; publishSdkEvent?.({ type: 'state', state: 'completed' }); }
      }),
      cancel: vi.fn(async () => { sdkBusy = false; publishSdkEvent?.({ type: 'state', state: 'cancelled' }); return { cancelled: true }; }),
      close: vi.fn(async () => { sdkBusy = false; publishSdkEvent?.({ type: 'state', state: 'closed' }); }),
    };
    copilotSdkMock.create.mockImplementation(async (options: any) => { sdkOptions = options; publishSdkEvent = options.publish; return sdk; });
    const sessions = new AgentSessions(root);
    const unsubscribe = sessions.onEvent(event => events.push(event.type === 'reply' ? `reply:${event.text}` : event.type === 'state' ? event.state : event.type));
    try {
      const started = await sessions.start('copilot', 'hello');
      expect(events).toContain('reply:synthetic Copilot hello');
      expect(events).toContain('completed');
      expect(sdkOptions.executable).toBe(executable);
      expect(sdkOptions.profile).toContain('tt003-copilot-');
      expect(sdkOptions.fixturePath).toContain('catalogue-mcp-fixture.cjs');
      const fixture = await readFile(sdkOptions.fixturePath, 'utf8');
      expect(fixture).toContain('readOnlyHint: true');
      expect(fixture).toContain(HOSTILE_CATALOGUE_NOTE);
      expect(sdk.send).toHaveBeenCalledWith('hello');
      await expect(sessions.followUp('copilot', started.sessionId, 'follow-up')).resolves.toEqual({ accepted: true });
      expect(sdk.send).toHaveBeenCalledWith('follow-up');
      await expect(sessions.followUp('copilot', started.sessionId, 'hold this turn')).resolves.toEqual({ accepted: true });
      await expect(sessions.cancel('copilot', started.sessionId)).resolves.toEqual({ cancelled: true });
      expect(events).toContain('cancelled');
      await expect(sessions.closeSession('copilot', started.sessionId)).resolves.toEqual({ closed: true });
      expect(events).toContain('closed');
    } finally {
      unsubscribe(); await sessions.closeAll(); process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs the fixed MCP fixture and rejects oversized or unknown callback requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tt003-mcp-fixture-'));
    const fixture = path.join(root, 'fixture.cjs');
    await writeFile(fixture, SYNTHETIC_MCP_FIXTURE_SOURCE, { mode: 0o700 });
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalogue_search', arguments: { query: 'hostile' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalogue_search', arguments: { query: 'x'.repeat(81) } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'catalogue_write', arguments: { query: 'feature' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'catalogue_search', arguments: { query: 'feature', path: '/tmp/marker' } } },
    ];
    const child = spawn(process.execPath, [fixture], { env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const output = await new Promise<string[]>((resolve, reject) => {
      let buffer = '';
      const lines: string[] = [];
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture response timeout')); }, 3000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
        if (lines.length === requests.length) { clearTimeout(timeout); resolve(lines); child.kill('SIGTERM'); }
      });
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
    });
    try {
      const frames = output.map((line) => JSON.parse(line));
      const hostile = JSON.parse(frames[1].result.content[0].text);
      expect(hostile.records[0]).toMatchObject({ ref: 'synthetic-film-001', untrustedNote: HOSTILE_CATALOGUE_NOTE });
      expect(frames[2].result.isError).toBe(true);
      expect(frames[3].result.isError).toBe(true);
      expect(frames[4].result.isError).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
