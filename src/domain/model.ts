import { z } from 'zod';
import type { Project } from '../config.js';
import type { Interpretation } from './conversation.js';

export const engineSchema = z.enum(['claude', 'codex']);
export type Engine = z.infer<typeof engineSchema>;
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'ready' | 'completed' | 'failed' | 'cancelled';
export type Phase = 'plan' | 'implement';
export type InteractionKind = 'clarification' | 'architecture' | 'recovery' | 'acceptance';
export const editSchema = z.object({ path: z.string().min(1), before: z.string().nullable(), after: z.string().nullable() }).strict();
export type Edit = z.infer<typeof editSchema>;
export const responseSchema = z.object({
  decision: z.enum(['ready', 'clarification', 'architecture', 'blocked']),
  summary: z.string().min(1),
  rationale: z.string(),
  question: z.string().nullable(),
  affectedPaths: z.array(z.string()).max(60),
  acceptance: z.array(z.string()),
  edits: z.array(editSchema).max(60),
  learning: z.string().nullable(),
}).strict();
export type AgentResponse = z.infer<typeof responseSchema>;
export const responseJsonSchema = z.toJSONSchema(responseSchema);

export interface Interaction {
  id: string;
  kind: InteractionKind;
  question: string;
  proposalHash: string;
  createdAt: string;
}
export interface Decision extends Interaction {
  actorId: string;
  answer: string;
  resolvedAt: string;
}
export interface Task {
  id: string;
  projectId: string;
  engine: Engine;
  status: TaskStatus;
  phase: Phase;
  requesterId: string;
  chatId: string | null;
  delivery?: { channel: 'group' | 'p2p' | 'local'; groupMode: 'private' | 'milestones' | 'group' };
  request: string;
  title?: string;
  workspace: string | null;
  baseCommit: string | null;
  sessionId: string | null;
  policyHash: string;
  projectSnapshot: Project;
  versions: Record<string, string>;
  role: string;
  skill: string;
  experience: string;
  plan: AgentResponse | null;
  planHash: string | null;
  interaction: Interaction | null;
  decisions: Decision[];
  feedback: string[];
  iteration: number;
  maxIterations: number;
  runTimeoutMs?: number;
  summary: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  cachedInputTokens?: number | null;
  scope?: 'turn' | 'session';
}
export interface EngineRequest {
  taskId: string;
  engine: Engine;
  cwd: string;
  prompt: string;
  instructions: string;
  sessionId: string | null;
  model?: string;
  effort?: string;
  authentication?: 'api_key' | 'local_login';
  signal: AbortSignal;
  timeoutMs: number;
  onProgress: (message: string) => void;
}
export interface EngineResult {
  response: AgentResponse;
  sessionId: string;
  usage: Usage;
}
export interface AgentEngine {
  readonly id: Engine;
  execute(request: EngineRequest): Promise<EngineResult>;
  interpretConversation?(request: EngineRequest): Promise<Interpretation>;
}
export interface CheckResult {
  name: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
}
export interface Run {
  id: string;
  taskId: string;
  engine: Engine;
  phase: Phase;
  requestedModel: string | null;
  requestedEffort?: string | null;
  versions: Record<string, string>;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  sessionId: string | null;
  usage: Usage | null;
  response: AgentResponse | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface Evidence {
  id: string;
  taskId: string;
  kind: 'baseline' | 'verification' | 'delivery';
  passed: boolean;
  checks: CheckResult[];
  artifact: string | null;
  createdAt: string;
}
export interface IncomingMessage {
  id: string;
  actorId: string;
  chatId: string;
  chatType?: 'group' | 'p2p';
  text: string;
  replyTo: string | null;
  createdAt?: string;
}
export interface Notification {
  id: string;
  taskId: string | null;
  interactionId?: string;
  recipientType: 'chat_id' | 'open_id';
  recipientId: string;
  text: string;
  createdAt: string;
}
export interface Improvement {
  id: string;
  taskId: string;
  status: 'candidate' | 'promoted' | 'archived';
  content: string;
  createdAt: string;
  promotedAt: string | null;
  evaluatedHash: string | null;
  validatedEngines?: Engine[];
}

export interface ChannelContext {
  projectId: string | null;
  selection: { projectIds: string[]; original: IncomingMessage | null; createdAt: string } | null;
}
export interface AuditEvent {
  id: string;
  action: string;
  actorId: string;
  taskId: string | null;
  detail: unknown;
  createdAt: string;
}
export interface AccessRequest {
  id: string;
  actorId: string;
  message: IncomingMessage;
  status: 'pending' | 'granted' | 'denied';
  projectId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export interface EvaluationJob {
  id: string;
  candidateId: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'interrupted';
  reportId: string | null;
  summary: string;
  createdAt: string;
  finishedAt: string | null;
}
