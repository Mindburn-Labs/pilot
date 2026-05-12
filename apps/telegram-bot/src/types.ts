import { type Context, type SessionFlavor } from 'grammy';
import { type FounderIntelService } from '@pilot/founder-intel';
import { type Db } from '@pilot/db/client';

export interface SessionData {
  workspaceId?: string;
  userId?: string;
  awaitingProfileInput?: boolean;
  activeOperatorContext?: string; // ID of the operator user is currently chatting with
}

export type BotContext = Context & SessionFlavor<SessionData>;

export interface BotDeps {
  db: Db;
  founderIntel?: FounderIntelService;
  /** Phase 13 Track C4 — run a normal task through the orchestrator. */
  runTask?: (params: OrchestratorRunParams) => Promise<OrchestratorRunResult>;
  /** Phase 13 Track C4 — run a subagent-enabled conduct loop. */
  runConduct?: (params: OrchestratorRunParams) => Promise<OrchestratorRunResult>;
  /** Create a Telegram Managed Bots provisioning request for a founder-owned launch/support bot. */
  createLaunchBotProvisioning?: (params: {
    workspaceId: string;
    userId: string;
    creatorTelegramId: string;
  }) => Promise<{
    creationUrl: string;
    suggestedUsername: string;
    suggestedName: string;
    expiresAt: string;
  }>;
  /** Claim a Telegram child bot after Telegram emits a managed_bot update. */
  claimLaunchBot?: (params: {
    creatorTelegramId: string;
    bot: { id: number | string; username?: string; firstName?: string };
  }) => Promise<{ id: string; telegramBotUsername: string; status: string }>;
  /** Resolve an approval and trigger any deployment-specific resume hook. */
  resolveApproval?: (params: {
    approvalId: string;
    workspaceId: string;
    status: 'approved' | 'rejected';
    resolvedBy: string;
  }) => Promise<void>;
}

export interface OrchestratorRunParams {
  taskId: string;
  workspaceId: string;
  operatorId?: string;
  context: string;
  iterationBudget?: number;
}

export interface OrchestratorRunResult {
  status: 'completed' | 'budget_exhausted' | 'blocked' | 'awaiting_approval' | 'stalled';
  iterationsUsed: number;
  iterationBudget: number;
  costUsd?: number;
  error?: string;
}
