import type { SafeResult } from './diagnostics';

export type AgentTarget = 'codex' | 'copilot';
export type AgentEvent =
  | { type: 'info'; target: AgentTarget; version: string; model?: string }
  | { type: 'state'; target: AgentTarget; state: 'starting' | 'ready' | 'running' | 'completed' | 'cancelled' | 'failed' | 'closed' }
  | { type: 'reply'; target: AgentTarget; text: string }
  | { type: 'tool'; target: AgentTarget; name: string; status: 'started' | 'completed' | 'denied' }
  | { type: 'error'; target: AgentTarget; code: string; message: string };
export type AgentEventBody = AgentEvent extends infer Event ? Event extends { target: AgentTarget } ? Omit<Event, 'target'> : never : never;

export interface AgentApi {
  start(target: AgentTarget, prompt: string): Promise<SafeResult<{ sessionId: string }>>;
  followUp(target: AgentTarget, sessionId: string, prompt: string): Promise<SafeResult<{ accepted: true }>>;
  cancel(target: AgentTarget, sessionId: string): Promise<SafeResult<{ cancelled: boolean }>>;
  close(target: AgentTarget, sessionId: string): Promise<SafeResult<{ closed: true }>>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

export const MAX_PROMPT_CHARS = 1000;
export const MAX_REPLY_CHARS = 8000;
export const TURN_TIMEOUT_MS = 90_000;

export function validPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PROMPT_CHARS;
}

export function safeAgentError(code: unknown, message: unknown): { code: string; message: string } {
  const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'AGENT_ERROR';
  const safeMessage = typeof message === 'string' ? message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  return { code: safeCode, message: safeMessage || 'The agent request failed.' };
}
