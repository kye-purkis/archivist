import { useEffect, useRef, useState } from 'react';
import { Sun, Moon, Database, ShieldCheck, Trash2, MessageSquare } from 'lucide-react';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarGroupContent, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarInset, SidebarTrigger, SidebarFooter } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { ButtonGroup } from '@/components/ui/button-group';
import { PhysicalFormatChart } from './PhysicalFormatChart';
import { ArchivistMark } from './components/archivist-mark';
import { MessageGroup, Message, MessageContent, MessageHeader } from '@/components/ui/message';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent } from '@/components/ui/message-scroller';
import type { DiagnosticStatus, SafeResult } from '../contracts/diagnostics';
import type { AgentEvent, AgentTarget } from '../contracts/agents';
import CatalogueApp from './CatalogueApp';

function DiagnosticApp() {
  const diagnosticApi = window.diagnostics!;
  const [status, setStatus] = useState<DiagnosticStatus>();
  const [startupError, setStartupError] = useState('');
  const [fixture, setFixture] = useState('fixture-after-restart');
  const [result, setResult] = useState('');
  const [secure, setSecure] = useState(false);
  const [dark, setDark] = useState(false);
  const [checked, setChecked] = useState(true);
  const [sample, setSample] = useState('Two synthetic chat messages.');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [agentTarget, setAgentTarget] = useState<AgentTarget>('codex');
  const [agentPrompt, setAgentPrompt] = useState('Reply with a short greeting. Do not use tools.');
  const [agentSession, setAgentSession] = useState<{ id: string; target: AgentTarget }>();
  const [agentStatus, setAgentStatus] = useState('Idle');
  const [agentPending, setAgentPending] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const agentRequestPending = useRef(false);
  const [agentMessages, setAgentMessages] = useState<Array<{ role: 'you' | 'agent' | 'event'; target: AgentTarget; text: string }>>([]);
  const refresh = async () => {
    try {
      if (!window.diagnostics || typeof window.diagnostics.status !== 'function') throw new Error('The desktop preload bridge is unavailable. Close this window and relaunch the desktop app.');
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The desktop diagnostic did not respond within 8 seconds. Close this window and relaunch the app.')), 8000));
      const r = await Promise.race([window.diagnostics.status(), timeout]);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      setStatus(r.value); setStartupError('');
      if (r.value.lastFixture) setFixture(r.value.lastFixture);
    } catch (error) { setStartupError(error instanceof Error ? error.message : 'The desktop diagnostic could not start.'); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const api = window.agents;
    if (!api || typeof api.onEvent !== 'function') { setAgentStatus('Unavailable: the agent preload bridge is missing.'); return; }
    return api.onEvent((event: AgentEvent) => {
    if (event.type === 'state') {
      setAgentStatus(`${event.target}: ${event.state}`);
      if (['starting', 'ready', 'running'].includes(event.state)) setAgentBusy(true);
      if (['completed', 'cancelled', 'failed', 'closed'].includes(event.state)) setAgentBusy(false);
      if (event.state === 'closed') setAgentSession(current => current?.target === event.target ? undefined : current);
    }
    if (event.type === 'info') setAgentMessages(current => [...current, { role: 'event', target: event.target, text: `${event.version}${event.model ? ` · ${event.model}` : ''}` }]);
    if (event.type === 'reply') setAgentMessages(current => {
      const last = current.at(-1);
      if (last?.role === 'agent' && last.target === event.target) return [...current.slice(0, -1), { ...last, text: (last.text + event.text).slice(0, 8000) }];
      return [...current, { role: 'agent', target: event.target, text: event.text.slice(0, 8000) }];
    });
    if (event.type === 'tool') setAgentMessages(current => [...current, { role: 'event', target: event.target, text: `Tool ${event.name}: ${event.status}` }]);
    if (event.type === 'error') { setAgentStatus(`${event.target}: failed (${event.code})`); setAgentMessages(current => [...current, { role: 'event', target: event.target, text: `${event.code}: ${event.message}` }]); }
  });
  }, []);
  const show = async <T,>(promise: Promise<SafeResult<T>>, label: string) => { const r = await promise; setResult(r.ok ? `${label}: passed` : `${label}: ${r.error.code} — ${r.error.message}`); await refresh(); };
  const sendAgent = async () => {
    const question = agentPrompt.trim(); if (!question || agentRequestPending.current) return;
    const target = agentTarget;
    const api = window.agents;
    if (!api || typeof api.start !== 'function' || typeof api.followUp !== 'function') {
      setAgentStatus(`${target}: unavailable (agent preload bridge missing)`);
      setAgentMessages(current => [...current, { role: 'event', target, text: 'The agent preload bridge is unavailable. Close this window and relaunch the desktop app.' }]);
      return;
    }
    agentRequestPending.current = true;
    setAgentPending(true);
    setAgentMessages(current => [...current, { role: 'you', target: agentSession?.target ?? target, text: question }]);
    setAgentPrompt('');
    try {
      const r = agentSession?.target === target
        ? await api.followUp(target, agentSession.id, question)
        : await api.start(target, question);
      if (!r.ok) { setAgentStatus(`${target}: unavailable (${r.error.code})`); setAgentMessages(current => [...current, { role: 'event', target, text: `${r.error.code}: ${r.error.message}` }]); setAgentPending(false); }
      else if ('sessionId' in r.value) setAgentSession({ id: r.value.sessionId, target });
    } catch {
      setAgentStatus(`${target}: unavailable`);
      setAgentMessages(current => [...current, { role: 'event', target, text: 'The agent request failed before the session could be confirmed.' }]);
      setAgentPending(false);
    } finally {
      agentRequestPending.current = false;
      setAgentPending(false);
    }
  };
  return <div className={dark ? 'dark app-root' : 'app-root'}>
    <SidebarProvider defaultOpen={true}>
      <Sidebar collapsible="icon">
      <SidebarHeader><div className="brand"><ArchivistMark className="brand-mark"/><span className="brand-label">Archivist</span></div></SidebarHeader>
        <SidebarContent><SidebarGroup><SidebarGroupLabel>Diagnostic</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton isActive aria-current="page" tooltip="Storage"><Database/><span>Storage</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton tooltip="Trust boundary"><ShieldCheck/><span>Trust boundary</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton tooltip="Components"><MessageSquare/><span>Components</span></SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent>
        <SidebarFooter><span className="sidebar-note">Synthetic fixtures only</span></SidebarFooter>
      </Sidebar>
      <SidebarInset className="main-shell">
        <header className="topbar"><SidebarTrigger aria-label="Toggle sidebar"/><div className="top-actions"><Button variant="outline" size="sm" onClick={() => setDark(!dark)} aria-label={dark ? 'Use light theme' : 'Use dark theme'}>{dark ? <Sun/> : <Moon/>}Theme</Button></div></header>
        <main className="content">
          <section className="intro"><p className="eyebrow">TT-001 · local diagnostic</p><h1>Desktop foundation check</h1><p>Sandboxed renderer, typed IPC, native SQLite and OS-backed credential adapter.</p></section>{startupError && <p className="result startup-error" role="alert">Diagnostic startup failed: {startupError} <Button variant="outline" size="sm" onClick={() => void refresh()}>Retry status</Button></p>}
          <section className="grid two">
            <article className="panel"><h2>Runtime and persistence</h2><p className="muted">Database belongs to this disposable spike profile.</p>
              <dl className="facts"><dt>Electron / Node / Chromium</dt><dd>{status ? `${status.electron} / ${status.node} / ${status.chrome}` : 'Loading'}</dd><dt>SQLite</dt><dd>{status?.sqlite ?? (startupError ? 'unavailable' : 'Loading')} · {status?.database ?? (startupError ? 'unavailable' : 'checking')}{status?.storageMessage ? ` — ${status.storageMessage}` : ''}</dd><dt>Write rollback</dt><dd>{status?.rollbackVerified ? 'passed' : 'pending'} · foreign keys {status?.foreignKeysEnabled ? 'on' : 'off'} · single instance guard {status?.singleInstanceGuard ? 'active' : 'inactive'}</dd><dt>Credential provider</dt><dd>{status?.credentialBackend ?? 'checking'} · {status?.secureCredentials ? 'secure persistence available' : 'secure persistence unavailable'} · canary file {status?.credentialFilePresent ? 'present' : 'absent'}</dd></dl>
              <Label htmlFor="fixture">Synthetic fixture text</Label><InputGroup><InputGroupInput id="fixture" maxLength={160} value={fixture} onChange={e => setFixture(e.target.value)} /><InputGroupAddon align="inline-end"><InputGroupButton onClick={() => void show(diagnosticApi.writeFixture(fixture), 'SQLite write')}>Write</InputGroupButton></InputGroupAddon></InputGroup>
              <div className="row"><Button onClick={() => void show(diagnosticApi.readFixture(), 'SQLite read')}>Read fixture</Button><Button variant="outline" onClick={async () => { const r = await diagnosticApi.credentialRoundTrip(); setResult(r.ok ? (r.value.retrievedExisting ? 'Credential check: existing encrypted canary decrypted' : 'Credential check: encrypted canary saved; relaunch and repeat') : `Credential check: ${r.error.code} — ${r.error.message}`); await refresh(); }}>Run canary check</Button><Button variant="outline" onClick={async () => { const r = await diagnosticApi.replaceCredentialCanary(); setResult(r.ok ? 'Credential check: canary replaced and verified' : `Credential check: ${r.error.code} — ${r.error.message}`); await refresh(); }}>Replace canary</Button><Button variant="outline" onClick={() => void show(diagnosticApi.runMemoryOnlyCredentialSession(), 'Memory-only session')}>Session only</Button><Button variant="outline" onClick={() => void show(diagnosticApi.deleteFixtures(), 'Delete fixtures')}><Trash2/>Clear</Button></div>
              <p className="result" role="status" aria-live="polite">{result || 'Ready.'}</p>
            </article>
            <article className="panel"><h2>Controls and overlays</h2><p className="muted">Exercise keyboard focus, state, portal, clipping and Escape behavior.</p>
              <div className="control-row"><Label htmlFor="sample-select">Sample mode</Label><Select defaultValue="packaged"><SelectTrigger id="sample-select"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="packaged">Packaged sample</SelectItem><SelectItem value="development">Development sample</SelectItem></SelectContent></Select></div>
              <label className="checkbox-line"><Checkbox checked={checked} onCheckedChange={v => setChecked(v === true)}/>Persist synthetic fixture on restart</label>
              <ButtonGroup><Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogTrigger asChild><Button variant="outline">Open dialog</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Focus and Escape check</DialogTitle><DialogDescription>Close with Escape, then confirm focus returns to the trigger.</DialogDescription></DialogHeader><Input aria-label="Dialog sample input" placeholder="Keyboard focus target"/></DialogContent></Dialog>
                <Popover open={popoverOpen} onOpenChange={setPopoverOpen}><PopoverTrigger asChild><Button variant="outline">Open popover</Button></PopoverTrigger><PopoverContent><p>Popover portal fixture</p><Button size="sm" onClick={() => setPopoverOpen(false)}>Close popover</Button></PopoverContent></Popover></ButtonGroup>
              <div className="row"><Button variant="outline" onClick={() => setSecure(!secure)}>{secure ? 'Disable' : 'Enable'} secure action</Button><span className="muted">{secure ? 'Enabled for this view' : 'Off'}</span></div>
            </article>
          </section>
          <section className="grid two">
            <article className="panel"><h2>Chart sample</h2><p className="muted">Synthetic format memberships.</p><PhysicalFormatChart data={[{format:'Blu-ray',count:7},{format:'DVD',count:4},{format:'Vinyl',count:3},{format:'Game cartridge',count:2}]}/></article>
            <article className="panel chat-panel"><h2>Message scroller sample</h2><MessageScrollerProvider><MessageScroller className="chat-scroll"><MessageScrollerViewport><MessageScrollerContent className="chat-messages"><MessageGroup><Message><MessageHeader>Diagnostic fixture</MessageHeader><MessageContent>Canary and messages are synthetic.</MessageContent></Message><Message align="end"><MessageHeader>Rendered safely</MessageHeader><MessageContent>{sample}</MessageContent></Message></MessageGroup></MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider><InputGroup><InputGroupInput aria-label="Synthetic message" value={sample} onChange={e => setSample(e.target.value)} /><InputGroupAddon align="inline-end"><InputGroupButton>Send sample</InputGroupButton></InputGroupAddon></InputGroup></article>
          </section>
          <section className="grid">
            <article className="panel agent-panel"><h2>TT-003 · Existing-agent probe</h2><p className="muted">Synthetic prompts only. The managed process runs from a disposable profile; replies are rendered here, and ordinary tool arguments and prompts are omitted from the event list.</p>
              <div className="control-row"><Label htmlFor="agent-target">Agent</Label><Select value={agentTarget} onValueChange={value => setAgentTarget(value as AgentTarget)} disabled={!!agentSession || agentPending}><SelectTrigger id="agent-target"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="codex">Codex App Server</SelectItem><SelectItem value="copilot">GitHub Copilot CLI</SelectItem></SelectContent></Select><span role="status" aria-live="polite">{agentStatus}</span></div>
              <div className="agent-messages" role="log" aria-live="polite">{agentMessages.map((message, index) => <div className={`agent-message ${message.role}`} key={`${message.target}-${index}`}><strong>{message.target} · {message.role}</strong><div>{message.text}</div></div>)}</div>
              <label className="agent-compose" htmlFor="agent-question"><span className="sr-only">Question or follow-up</span><textarea id="agent-question" maxLength={1000} value={agentPrompt} onChange={e => setAgentPrompt(e.target.value)} placeholder="Ask a synthetic diagnostic question…" onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void sendAgent(); }}/><div className="row"><span className="muted">1–1000 characters · Ctrl/⌘+Enter to send</span><Button onClick={() => void sendAgent()} disabled={!agentPrompt.trim() || agentPending || agentBusy}>Send</Button>{agentSession?.target === agentTarget && <><Button variant="outline" disabled={agentPending || !agentBusy} onClick={async () => { const api = window.agents; if (!api || typeof api.cancel !== 'function') { setAgentStatus(`${agentTarget}: cancel unavailable (agent preload bridge missing)`); return; } setAgentPending(true); try { const r = await api.cancel(agentTarget, agentSession.id); if (!r.ok) setAgentStatus(`${agentTarget}: cancel failed (${r.error.code})`); } catch { setAgentStatus(`${agentTarget}: cancel unavailable`); } finally { agentRequestPending.current = false; setAgentPending(false); } }}>Cancel turn</Button><Button variant="outline" disabled={agentPending} onClick={async () => { const current = agentSession; const api = window.agents; if (!current) return; if (!api || typeof api.close !== 'function') { setAgentStatus(`${current.target}: close unavailable (agent preload bridge missing)`); return; } setAgentPending(true); try { const r = await api.close(current.target, current.id); if (r.ok) { setAgentSession(undefined); setAgentBusy(false); setAgentStatus(`${current.target}: closed`); } else setAgentStatus(`${current.target}: close failed (${r.error.code})`); } catch { setAgentStatus(`${current.target}: close unavailable`); } finally { agentRequestPending.current = false; setAgentPending(false); } }}>Close / new session</Button></>}</div></label>
            </article>
          </section>
        </main>
      </SidebarInset>
    </SidebarProvider>
  </div>;
}

export default function App() {
  return window.appSurface === 'diagnostic' ? <DiagnosticApp /> : <CatalogueApp />;
}
