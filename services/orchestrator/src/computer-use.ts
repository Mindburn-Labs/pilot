import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog, computerActions } from '@pilot/db/schema';
import type { Db } from '@pilot/db/client';
import type { OperatorComputerUse } from '@pilot/shared/schemas';
import type { OperatorComputerUseResult } from '@pilot/helm-client';
import { createSandbox, SandboxError, type SandboxProvider } from '@pilot/sandbox';
import { and, eq } from 'drizzle-orm';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 256_000;
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';
const SANDBOX_ROOT = '/workspace';

const ALLOWED_COMMANDS = new Set([
  'pwd',
  'ls',
  'find',
  'rg',
  'grep',
  'sed',
  'cat',
  'head',
  'tail',
  'wc',
  'git',
  'npm',
  'pnpm',
  'yarn',
]);

const DENIED_COMMAND_WORDS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'chmod',
  'chown',
  'sudo',
  'su',
  'kill',
  'pkill',
  'shutdown',
  'reboot',
  'mkfs',
  'dd',
]);

type ComputerUseTx = Pick<Db, 'insert' | 'update'>;
type ComputerUseDb = ComputerUseTx & Pick<Db, 'transaction'>;

interface Completion {
  status: 'completed' | 'denied' | 'failed';
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  fileDiff?: string;
  outputHash?: string;
  metadata?: Record<string, unknown>;
}

export interface SafeComputerUseOptions {
  sandboxProvider?: SandboxProvider;
}

export interface SafeComputerUseResult {
  computerAction: {
    id: string;
    replayIndex: number;
    evidencePackId?: string | null;
  };
  execution: {
    operation: OperatorComputerUse['operation'];
    environment: OperatorComputerUse['environment'];
    status: Completion['status'];
    cwd?: string;
    command?: string;
    args?: string[];
    path?: string;
    devServerUrl?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
    fileDiff?: string;
    outputHash?: string;
  };
  governance: {
    status: OperatorComputerUseResult['status'];
    decisionId: string;
    policyVersion: string;
    helmDocumentVersionPins: Record<string, string>;
    evidencePackId?: string;
  };
  evidenceIds: string[];
  error?: string;
}

export async function executeSafeComputerUse(
  db: ComputerUseDb,
  req: OperatorComputerUse,
  governance: OperatorComputerUseResult,
  options: SafeComputerUseOptions = {},
): Promise<SafeComputerUseResult> {
  const actionBase = await buildActionBase(req, governance);
  const [record] = await db
    .insert(computerActions)
    .values({
      ...actionBase,
      status: 'running',
      metadata: {
        ...actionBase.metadata,
        evidenceContract: 'computer_safe_action_v1',
      },
    })
    .returning({
      id: computerActions.id,
      replayIndex: computerActions.replayIndex,
      evidencePackId: computerActions.evidencePackId,
    });

  if (!record?.id) {
    throw new Error('operator.computer_use could not persist initial computer action evidence');
  }

  const completion = await completeComputerUse(req, options);
  const auditEventId = randomUUID();
  const evidenceItemId = await db.transaction(async (tx) => {
    const txDb = tx as unknown as ComputerUseTx;
    const auditMetadata = {
      computerActionId: record.id,
      taskId: req.taskId ?? null,
      actionId: req.actionId ?? null,
      operation: req.operation,
      environment: req.environment,
      status: completion.status,
      target: computerActionTarget(req),
      helmDecisionId: governance.receipt.decisionId,
      helmPolicyVersion: governance.receipt.policyVersion,
      helmDocumentVersionPins: actionBase.helmDocumentVersionPins,
      evidencePackId: record.evidencePackId ?? governance.evidencePackId ?? null,
      exitCode: completion.exitCode ?? null,
      durationMs: completion.durationMs ?? null,
      outputHash: completion.outputHash ?? null,
      executionBoundary: 'safe_local_or_sandbox_only_no_unrestricted_desktop',
    };

    await txDb.insert(auditLog).values({
      id: auditEventId,
      workspaceId: req.workspaceId,
      action: 'OPERATOR_COMPUTER_USE',
      actor: req.operatorId ? `operator:${req.operatorId}` : 'agent',
      target: record.id,
      verdict:
        completion.status === 'completed'
          ? 'allow'
          : completion.status === 'denied'
            ? 'deny'
            : 'error',
      reason:
        completion.status === 'completed' ? null : (completion.stderr ?? 'computer action failed'),
      metadata: auditMetadata,
    });

    await txDb
      .update(computerActions)
      .set({
        status: completion.status,
        stdout: completion.stdout ?? null,
        stderr: completion.stderr ?? null,
        exitCode: completion.exitCode ?? null,
        durationMs: completion.durationMs ?? null,
        fileDiff: completion.fileDiff ?? null,
        outputHash: completion.outputHash ?? null,
        metadata: {
          ...actionBase.metadata,
          ...(completion.metadata ?? {}),
          evidenceContract: 'computer_safe_action_v1',
        },
        completedAt: new Date(),
      })
      .where(eq(computerActions.id, record.id));

    const persistedEvidenceItemId = await appendEvidenceItem(txDb, {
      workspaceId: req.workspaceId,
      taskId: req.taskId ?? null,
      actionId: req.actionId ?? null,
      auditEventId,
      evidencePackId: record.evidencePackId ?? governance.evidencePackId ?? null,
      computerActionId: record.id,
      evidenceType: 'computer_action',
      sourceType: 'computer_operator',
      title: `Computer ${req.operation}: ${computerActionTarget(req)}`,
      summary:
        completion.status === 'completed' ? req.objective : (completion.stderr ?? req.objective),
      redactionState: 'redacted',
      sensitivity: 'sensitive',
      contentHash: completion.outputHash ?? null,
      replayRef: `computer:${record.id}:${record.replayIndex ?? 0}`,
      metadata: {
        operation: req.operation,
        environment: req.environment,
        status: completion.status,
        helmDecisionId: governance.receipt.decisionId,
        helmPolicyVersion: governance.receipt.policyVersion,
        helmDocumentVersionPins: actionBase.helmDocumentVersionPins,
        exitCode: completion.exitCode ?? null,
        durationMs: completion.durationMs ?? null,
        executionBoundary: 'safe_local_or_sandbox_only_no_unrestricted_desktop',
      },
    });

    await txDb
      .update(auditLog)
      .set({
        metadata: {
          ...auditMetadata,
          evidenceItemId: persistedEvidenceItemId,
        },
      })
      .where(and(eq(auditLog.workspaceId, req.workspaceId), eq(auditLog.id, auditEventId)));

    return persistedEvidenceItemId;
  });

  const evidenceIds = [
    record.id,
    evidenceItemId,
    ...(governance.evidencePackId ? [governance.evidencePackId] : []),
  ];
  const baseExecution = {
    operation: req.operation,
    environment: req.environment,
    status: completion.status,
    stdout: completion.stdout,
    stderr: completion.stderr,
    exitCode: completion.exitCode,
    durationMs: completion.durationMs,
    fileDiff: completion.fileDiff,
    outputHash: completion.outputHash,
  };

  return {
    computerAction: {
      id: record.id,
      replayIndex: record.replayIndex ?? 0,
      evidencePackId: record.evidencePackId ?? governance.evidencePackId,
    },
    execution: {
      ...baseExecution,
      ...(req.operation === 'terminal_command'
        ? { cwd: actionBase.cwd ?? undefined, command: req.command, args: req.args }
        : {}),
      ...(req.operation === 'file_read' || req.operation === 'file_write'
        ? { path: actionBase.filePath ?? undefined }
        : {}),
      ...(req.operation === 'dev_server_status'
        ? { devServerUrl: actionBase.devServerUrl ?? undefined }
        : {}),
    },
    governance: {
      status: governance.status,
      decisionId: governance.receipt.decisionId,
      policyVersion: governance.receipt.policyVersion,
      helmDocumentVersionPins: actionBase.helmDocumentVersionPins,
      evidencePackId: governance.evidencePackId,
    },
    evidenceIds,
    ...(completion.status === 'completed'
      ? {}
      : { error: completion.stderr ?? 'computer action failed' }),
  };
}

function computerActionTarget(req: OperatorComputerUse): string {
  if (req.operation === 'terminal_command') return req.command;
  if (req.operation === 'file_read' || req.operation === 'file_write') return req.path;
  return req.devServerUrl ?? req.targetUrl ?? 'local-dev-server';
}

async function buildActionBase(req: OperatorComputerUse, governance: OperatorComputerUseResult) {
  const root = await allowedRoot();
  const devServerUrl =
    req.operation === 'dev_server_status' ? (req.devServerUrl ?? req.targetUrl) : undefined;
  const helmDocumentVersionPins = computerHelmDocumentVersionPins(governance.receipt.policyVersion);

  return {
    workspaceId: req.workspaceId,
    taskId: req.taskId ?? null,
    toolActionId: req.actionId ?? null,
    operatorId: req.operatorId ?? null,
    actionType: req.operation,
    environment: req.environment,
    objective: req.objective,
    cwd: req.operation === 'terminal_command' ? req.cwd : null,
    command: req.operation === 'terminal_command' ? req.command : null,
    args: req.operation === 'terminal_command' ? req.args : [],
    filePath: req.operation === 'file_read' || req.operation === 'file_write' ? req.path : null,
    devServerUrl: devServerUrl ?? null,
    policyDecisionId: governance.receipt.decisionId,
    policyVersion: governance.receipt.policyVersion,
    helmDocumentVersionPins,
    evidencePackId: governance.evidencePackId ?? null,
    metadata: {
      helmDecisionId: governance.receipt.decisionId,
      helmPolicyVersion: governance.receipt.policyVersion,
      helmDocumentVersionPins,
      allowedRoot: root,
      restrictedPathPolicy: 'deny_env_git_ssh_credentials_outside_root',
      executionBoundary: 'safe_local_or_sandbox_only_no_unrestricted_desktop',
    },
  };
}

async function completeComputerUse(
  req: OperatorComputerUse,
  options: SafeComputerUseOptions,
): Promise<Completion> {
  const started = Date.now();
  if (req.environment === 'sandbox') {
    return completeSandboxComputerUse(req, options, started);
  }

  try {
    if (req.operation === 'terminal_command') {
      const root = await allowedRoot();
      const cwd = await resolveAllowedExistingDirectory(root, req.cwd).catch((err: unknown) =>
        err instanceof Error ? err : new Error(String(err)),
      );
      if (cwd instanceof Error) return denied(cwd.message, Date.now() - started);
      const commandDenial = validateCommand(req.command, req.args, cwd, root);
      if (commandDenial) return denied(commandDenial, Date.now() - started);

      try {
        const result = await execFileAsync(req.command, req.args, {
          cwd,
          timeout: req.timeoutMs,
          maxBuffer: MAX_CAPTURE_BYTES,
          shell: false,
          env: safeCommandEnv(),
        });
        const stdout = redactAndLimit(result.stdout);
        const stderr = redactAndLimit(result.stderr);
        return {
          status: 'completed',
          stdout,
          stderr,
          exitCode: 0,
          durationMs: Date.now() - started,
          outputHash: hashText(`${stdout}\n${stderr}`),
          metadata: { commandPolicy: 'allowlisted_exec_file_no_shell' },
        };
      } catch (err) {
        const execError = err as {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          code?: string | number;
          message?: string;
        };
        const stdout = redactAndLimit(bufferishToString(execError.stdout));
        const stderr = redactAndLimit(
          bufferishToString(execError.stderr) || execError.message || 'command failed',
        );
        return {
          status: 'failed',
          stdout,
          stderr,
          exitCode: typeof execError.code === 'number' ? execError.code : 1,
          durationMs: Date.now() - started,
          outputHash: hashText(`${stdout}\n${stderr}`),
          metadata: { commandPolicy: 'allowlisted_exec_file_no_shell' },
        };
      }
    }

    if (req.operation === 'file_read') {
      const root = await allowedRoot();
      const filePath = await resolveAllowedFilePath(root, req.path).catch((err: unknown) =>
        err instanceof Error ? err : new Error(String(err)),
      );
      if (filePath instanceof Error) return denied(filePath.message, Date.now() - started);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return denied('file_read target must be a regular file');
      if (fileStat.size > req.maxBytes) {
        return denied(`file_read target exceeds maxBytes (${fileStat.size} > ${req.maxBytes})`);
      }
      const content = await readFile(filePath, 'utf8');
      const stdout = redactAndLimit(content, req.maxBytes);
      return {
        status: 'completed',
        stdout,
        exitCode: 0,
        durationMs: Date.now() - started,
        outputHash: hashText(content),
        metadata: { bytes: Buffer.byteLength(content), fileHash: hashText(content) },
      };
    }

    if (req.operation === 'file_write') {
      const root = await allowedRoot();
      const filePath = await resolveAllowedFilePath(root, req.path).catch((err: unknown) =>
        err instanceof Error ? err : new Error(String(err)),
      );
      if (filePath instanceof Error) return denied(filePath.message, Date.now() - started);
      const before = await readTextIfExists(filePath);
      const beforeHash = before === null ? null : hashText(before);
      if (req.expectedCurrentHash && beforeHash !== req.expectedCurrentHash) {
        return denied('file_write expectedCurrentHash did not match current file hash');
      }
      await writeFile(filePath, req.content, 'utf8');
      const diff = redactAndLimit(buildSimpleDiff(filePath, before ?? '', req.content));
      return {
        status: 'completed',
        stdout: 'file_write completed',
        exitCode: 0,
        durationMs: Date.now() - started,
        fileDiff: diff,
        outputHash: hashText(req.content),
        metadata: {
          beforeHash,
          afterHash: hashText(req.content),
          bytesWritten: Buffer.byteLength(req.content),
        },
      };
    }

    const url = req.devServerUrl ?? req.targetUrl;
    if (!url) return denied('dev_server_status requires targetUrl or devServerUrl');
    const urlDenial = validateLocalDevServerUrl(url);
    if (urlDenial) return denied(urlDenial);
    const status = await fetchDevServerStatus(url, req.timeoutMs);
    return {
      status: status.ok ? 'completed' : 'failed',
      stdout: redactAndLimit(JSON.stringify(status)),
      stderr: status.ok ? undefined : status.error,
      exitCode: status.ok ? 0 : 1,
      durationMs: Date.now() - started,
      outputHash: hashText(JSON.stringify(status)),
      metadata: { devServerUrl: url, httpStatus: status.httpStatus ?? null },
    };
  } catch (err) {
    return {
      status: 'failed',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      durationMs: Date.now() - started,
    };
  }
}

function sandboxPreflight(
  req: OperatorComputerUse,
): { target: { cwd?: string; filePath?: string } } | { denial: string } {
  if (req.operation === 'dev_server_status') {
    return {
      denial:
        'sandbox dev_server_status is not supported for operator.computer_use; use local environment for localhost checks',
    };
  }

  if (req.operation === 'terminal_command') {
    const cwd = resolveSandboxPath(req.cwd);
    if (cwd instanceof Error) return { denial: cwd.message };
    const commandDenial = validateCommand(req.command, req.args, cwd, SANDBOX_ROOT);
    if (commandDenial) return { denial: commandDenial };
    return { target: { cwd } };
  }

  const filePath = resolveSandboxPath(req.path);
  if (filePath instanceof Error) return { denial: filePath.message };
  return { target: { filePath } };
}

async function completeSandboxComputerUse(
  req: OperatorComputerUse,
  options: SafeComputerUseOptions,
  started: number,
): Promise<Completion> {
  const preflight = sandboxPreflight(req);
  if ('denial' in preflight) return denied(preflight.denial, Date.now() - started);

  const provider = options.sandboxProvider ?? createSandbox();
  let handle: Awaited<ReturnType<SandboxProvider['provision']>> | undefined;
  try {
    handle = await provider.provision({
      workspaceId: req.workspaceId,
      timeoutMs: req.operation === 'terminal_command' ? req.timeoutMs : undefined,
    });
    const providerMetadata = {
      sandboxProvider: provider.name,
      sandboxId: handle.id,
      sandboxImage: handle.image,
      sandboxExpiresAt: handle.expiresAt,
    };

    if (req.operation === 'terminal_command') {
      const cwd = preflight.target.cwd;
      if (!cwd)
        return denied('sandbox terminal_command cwd preflight failed', Date.now() - started);
      const result = await provider.exec(handle, {
        cmd: buildSandboxCommand(req.command, req.args),
        language: 'bash',
        cwd,
        timeoutMs: req.timeoutMs,
      });
      const stdout = redactAndLimit(result.stdout);
      const stderr = redactAndLimit(result.stderr);
      return {
        status: result.exitCode === 0 ? 'completed' : 'failed',
        stdout,
        stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputHash: hashText(`${stdout}\n${stderr}`),
        metadata: {
          ...providerMetadata,
          commandPolicy: 'allowlisted_sandbox_provider_no_destructive_shell',
          sandboxTruncated: result.truncated ?? false,
        },
      };
    }

    if (req.operation === 'file_read') {
      const filePath = preflight.target.filePath;
      if (!filePath) return denied('sandbox file_read path preflight failed', Date.now() - started);
      const bytes = await provider.readFile(handle, filePath);
      if (bytes.byteLength > req.maxBytes) {
        return denied(
          `sandbox file_read target exceeds maxBytes (${bytes.byteLength} > ${req.maxBytes})`,
          Date.now() - started,
        );
      }
      const content = Buffer.from(bytes).toString('utf8');
      const stdout = redactAndLimit(content, req.maxBytes);
      return {
        status: 'completed',
        stdout,
        exitCode: 0,
        durationMs: Date.now() - started,
        outputHash: hashText(content),
        metadata: {
          ...providerMetadata,
          bytes: bytes.byteLength,
          fileHash: hashText(content),
        },
      };
    }

    if (req.operation !== 'file_write') {
      return denied(`sandbox operation is unsupported: ${req.operation}`, Date.now() - started);
    }

    const filePath = preflight.target.filePath;
    if (!filePath) return denied('sandbox file_write path preflight failed', Date.now() - started);
    const before = await provider
      .readFile(handle, filePath)
      .then((bytes) => Buffer.from(bytes).toString('utf8'))
      .catch(() => null);
    const beforeHash = before === null ? null : hashText(before);
    if (req.expectedCurrentHash && beforeHash !== req.expectedCurrentHash) {
      return denied(
        'sandbox file_write expectedCurrentHash did not match current file hash',
        Date.now() - started,
      );
    }
    await provider.writeFile(handle, filePath, new TextEncoder().encode(req.content));
    const diff = redactAndLimit(buildSimpleDiff(filePath, before ?? '', req.content));
    return {
      status: 'completed',
      stdout: 'sandbox file_write completed',
      exitCode: 0,
      durationMs: Date.now() - started,
      fileDiff: diff,
      outputHash: hashText(req.content),
      metadata: {
        ...providerMetadata,
        beforeHash,
        afterHash: hashText(req.content),
        bytesWritten: Buffer.byteLength(req.content),
      },
    };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof SandboxError && err.code === 'not_configured' ? 'denied' : 'failed';
    return {
      status,
      stderr,
      exitCode: 1,
      durationMs: Date.now() - started,
      outputHash: hashText(stderr),
      metadata: {
        sandboxProvider: provider.name,
        sandboxErrorCode: err instanceof SandboxError ? err.code : 'unknown',
      },
    };
  } finally {
    if (handle) {
      await provider.destroy(handle).catch(() => undefined);
    }
  }
}

function denied(reason: string, durationMs = 0): Completion {
  return {
    status: 'denied',
    stderr: reason,
    exitCode: 1,
    durationMs,
    outputHash: hashText(reason),
    metadata: { localDenyReason: reason },
  };
}

async function allowedRoot(): Promise<string> {
  const configured = process.env['PILOT_COMPUTER_ALLOWED_ROOT'] ?? process.cwd();
  return realpath(configured).catch(() => resolve(configured));
}

async function resolveAllowedExistingDirectory(root: string, inputPath: string): Promise<string> {
  const candidate = await resolveAllowedPath(root, inputPath);
  const fileStat = await stat(candidate);
  if (!fileStat.isDirectory()) {
    throw new Error(`cwd is not a directory inside the allowed project scope: ${inputPath}`);
  }
  return candidate;
}

async function resolveAllowedFilePath(root: string, inputPath: string): Promise<string> {
  return resolveAllowedPath(root, inputPath);
}

async function resolveAllowedPath(root: string, inputPath: string): Promise<string> {
  const candidate = resolve(root, inputPath);
  if (!isInside(candidate, root)) {
    throw new Error(`path is outside the allowed project scope: ${inputPath}`);
  }
  const restricted = restrictedPathReason(candidate);
  if (restricted) throw new Error(restricted);

  const actual = await realpath(candidate).catch(() => null);
  if (actual) {
    if (!isInside(actual, root)) {
      throw new Error(`path resolves outside the allowed project scope: ${inputPath}`);
    }
    return actual;
  }

  const parent = dirname(candidate);
  const actualParent = await realpath(parent);
  if (!isInside(actualParent, root)) {
    throw new Error(`path parent resolves outside the allowed project scope: ${inputPath}`);
  }
  await access(actualParent, fsConstants.W_OK | fsConstants.R_OK);
  return candidate;
}

function validateCommand(
  command: string,
  args: string[],
  cwd: string,
  root: string,
): string | null {
  if (!/^[A-Za-z0-9._-]+$/u.test(command)) {
    return 'terminal_command executable must be a bare command name, not a path or shell snippet';
  }
  if (DENIED_COMMAND_WORDS.has(command)) {
    return `terminal_command denied destructive executable: ${command}`;
  }
  if (!ALLOWED_COMMANDS.has(command)) {
    return `terminal_command executable is not allowlisted: ${command}`;
  }

  const joined = [command, ...args].join(' ');
  if (/\b(rm|rmdir|chmod|chown|sudo|mkfs|shutdown|reboot)\b/u.test(joined)) {
    return 'terminal_command denied destructive argument';
  }
  if (/[;&|`$<>]/u.test(joined)) {
    return 'terminal_command denied shell metacharacter';
  }
  if (/["'\\\r\n]/u.test(joined)) {
    return 'terminal_command denied unsafe quoting or control character';
  }
  if (command === 'git' && isDeniedGitInvocation(args)) {
    return 'terminal_command denied mutating git invocation';
  }
  if (
    (command === 'npm' || command === 'pnpm' || command === 'yarn') &&
    isDeniedPackageInvocation(args)
  ) {
    return 'terminal_command denied package-manager mutation';
  }

  for (const arg of args) {
    const argReason = validateCommandPathArgument(arg, cwd, root);
    if (argReason) return argReason;
  }
  return null;
}

function resolveSandboxPath(inputPath: string): string | Error {
  const candidate = posix.normalize(
    posix.isAbsolute(inputPath)
      ? inputPath
      : posix.join(SANDBOX_ROOT, inputPath === '.' ? '' : inputPath),
  );
  if (!isInsidePosix(candidate, SANDBOX_ROOT)) {
    return new Error(`sandbox path is outside the allowed project scope: ${inputPath}`);
  }
  const restricted = restrictedPathReason(candidate);
  if (restricted) return new Error(restricted);
  return candidate;
}

function isInsidePosix(path: string, root: string): boolean {
  const rel = posix.relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel));
}

function buildSandboxCommand(command: string, args: string[]): string {
  return [command, ...args.map(shellQuote)].join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function isDeniedGitInvocation(args: string[]): boolean {
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  if (!subcommand) return false;
  return !new Set(['status', 'diff', 'show', 'log', 'rev-parse']).has(subcommand);
}

function isDeniedPackageInvocation(args: string[]): boolean {
  const first = args[0];
  const second = args[1];
  if (!first) return true;
  if (first === 'install' || first === 'add' || first === 'remove' || first === 'publish') {
    return true;
  }
  if (first === 'run') {
    return !new Set(['typecheck', 'lint', 'test', 'build']).has(second ?? '');
  }
  return !new Set(['test']).has(first);
}

function validateCommandPathArgument(arg: string, cwd: string, root: string): string | null {
  if (!arg || arg.startsWith('-')) return null;
  if (!arg.startsWith('/') && !arg.startsWith('.') && !arg.includes('/')) return null;
  const candidate = resolve(cwd, arg);
  if (!isInside(candidate, root)) return `terminal_command path argument is outside scope: ${arg}`;
  return restrictedPathReason(candidate);
}

function validateLocalDevServerUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'dev_server_status URL is invalid';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'dev_server_status only supports http(s) local dev URLs';
  }
  const host = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    return 'dev_server_status only supports localhost, 127.0.0.1, or ::1';
  }
  return null;
}

async function fetchDevServerStatus(value: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(value, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return {
      ok: response.ok,
      httpStatus: response.status,
      url: value,
      title: extractTitle(text),
      bodyHash: hashText(text),
    };
  } catch (err) {
    return {
      ok: false,
      url: value,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function restrictedPathReason(path: string): string | null {
  const parts = path.split(sep).map((part) => part.toLowerCase());
  for (const part of parts) {
    if (part === '.git' || part === '.ssh' || part === '.gnupg' || part === '.aws') {
      return `path denied by restricted credential/source-control boundary: ${path}`;
    }
    if (part === '.env' || part.startsWith('.env.')) {
      return `path denied by restricted environment-file boundary: ${path}`;
    }
    if (/^(id_rsa|id_ed25519|credentials|known_hosts|authorized_keys)$/u.test(part)) {
      return `path denied by restricted credential-file boundary: ${path}`;
    }
  }
  return null;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeCommandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? DEFAULT_PATH,
    CI: '1',
    NODE_ENV: process.env['NODE_ENV'] ?? 'test',
  };
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function buildSimpleDiff(path: string, before: string, after: string): string {
  if (before === after) return `--- ${path}\n+++ ${path}\n@@\n unchanged`;
  return [
    `--- ${path}`,
    `+++ ${path}`,
    '@@',
    ...before
      .split('\n')
      .slice(0, 80)
      .map((line) => `-${line}`),
    ...after
      .split('\n')
      .slice(0, 80)
      .map((line) => `+${line}`),
  ].join('\n');
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]+)<\/title>/iu.exec(html);
  return match?.[1]?.trim().slice(0, 300);
}

function bufferishToString(value: string | Buffer | undefined): string {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /(password|passwd|pwd|token|secret|api[_-]?key|authorization)(\s*[:=]\s*)(["']?)[^"'\s<>&]+/giu,
    '$1$2$3[REDACTED]',
  ],
  [/(sk_(?:live|test)_[A-Za-z0-9]+)/gu, '[REDACTED]'],
  [/([A-Za-z0-9+/]{32,}={0,2})/gu, '[REDACTED]'],
];

function redactAndLimit(text: string, limit = MAX_CAPTURE_BYTES): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.slice(0, limit);
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function computerHelmDocumentVersionPins(policyVersion: string): Record<string, string> {
  return { computerUsePolicy: policyVersion };
}
