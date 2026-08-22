// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DebugState } from './debugState';
import { IDebuggingExecutor } from './debuggingExecutor';
import { logger } from './utils/logger';
import { buildCppvsdbgConfig, buildCppvsdbgAttachConfig, StartDebuggingArgs, AttachDebuggingArgs } from './utils/cppvsdbgConfig';
import { buildProsperoLaunchConfig, buildProsperoAttachConfig, ProsperoLaunchArgs, ProsperoElfPathFormat } from './utils/prosperoConfig';
import { isPs5Available, listKitProcessesRaw } from './utils/ps5';
import { getExitSince } from './utils/sessionExitTracker';
import { classifySessionState, gateErrorFor, handlerError, requireNoActiveSession } from './utils/sessionGate';
import { enumerateProcesses, findProcessByName } from './utils/processEnum';

export interface HandlerResponse<T = unknown> {
    text: string;
    structuredContent: T;
    isError?: boolean;
}

export interface AddBreakpointArgs {
    fileFullPath: string;
    line?: number;
    lineContent?: string;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
    allowMultiple?: boolean;
}

export interface RemoveBreakpointArgs {
    fileFullPath: string;
    line?: number;
    lineContent?: string;
}

export interface AddressBreakpointArgs {
    address: string;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
}

export interface AttachToProcessArgs {
    processId?: number | string;
    processName?: string;
    location?: 'local' | 'remote';
    target?: string;
    extraConfig?: Record<string, unknown>;
    waitForBreakpointSeconds?: number;
}

// Unified launch request: cppvsdbg (default, local) and prospero (PS5 kit) fields.
// The `debugger` discriminator selects the config builder; fields for the other
// adapter are ignored.
export interface StartDebuggingRequest extends Partial<StartDebuggingArgs> {
    debugger?: 'cppvsdbg' | 'prospero';
    elfPath?: string;
    elfPathFormat?: ProsperoElfPathFormat;
    target?: string;
    workingDirectory?: string;
    stopOnEntry?: boolean;
    extraLaunchOptions?: Record<string, unknown>;
}

export interface ListProcessesArgs {
    filter?: string;
}

// Outcome of waiting for a launch/attach to settle. `exited` means the debuggee
// ran to completion without ever pausing (no breakpoint, no fault) — a real run,
// not a failure to attach.
type SessionOutcome =
    | { kind: 'paused' }
    | { kind: 'attached' }
    | { kind: 'never-attached' }
    | { kind: 'exited'; exitCode: number | undefined };

export interface IDebuggingHandler {
    handleStartDebugging(args: StartDebuggingRequest): Promise<HandlerResponse>;
    handleAttachToProcess(args: AttachToProcessArgs): Promise<HandlerResponse>;
    handleStopDebugging(args?: { terminate?: boolean }): Promise<HandlerResponse>;
    handlePause(): Promise<HandlerResponse>;
    handleStepOver(args?: { steps?: number }): Promise<HandlerResponse>;
    handleStepInto(): Promise<HandlerResponse>;
    handleStepOut(): Promise<HandlerResponse>;
    handleContinue(): Promise<HandlerResponse>;
    handleRestart(): Promise<HandlerResponse>;
    handleAddBreakpoint(args: AddBreakpointArgs): Promise<HandlerResponse>;
    handleRemoveBreakpoint(args: RemoveBreakpointArgs): Promise<HandlerResponse>;
    handleAddAddressBreakpoint(args: AddressBreakpointArgs): Promise<HandlerResponse>;
    handleRemoveAddressBreakpoint(args: { address: string }): Promise<HandlerResponse>;
    handleClearAllBreakpoints(): Promise<HandlerResponse>;
    handleListBreakpoints(): Promise<HandlerResponse>;
    handleListProcesses(args: ListProcessesArgs): Promise<HandlerResponse>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<HandlerResponse>;
    handleEvaluateExpression(args: { expression: string }): Promise<HandlerResponse>;
    handleGetProgramOutput(args: { tail?: number }): Promise<HandlerResponse>;
    handleGetDebugState(): Promise<HandlerResponse>;
    handleGetExceptionInfo(): Promise<HandlerResponse>;
    handleListKitProcesses(args: { target?: string }): Promise<HandlerResponse>;
}

export class DebuggingHandler implements IDebuggingHandler {
    private readonly numNextLines: number = 3;
    private readonly executionDelay: number = 300;
    private readonly timeoutInSeconds: number;
    private static readonly DEFAULT_ATTACH_TIMEOUT_SECONDS = 30;
    // PS5 kit launch (deploy + spawn over the network) is slower than a local .exe.
    private static readonly DEFAULT_PROSPERO_TIMEOUT_SECONDS = 90;

    constructor(
        private readonly executor: IDebuggingExecutor,
        timeoutInSeconds: number,
    ) {
        this.timeoutInSeconds = timeoutInSeconds;
    }

    private stateToEnvelope(state: DebugState): HandlerResponse {
        return {
            text: state.toString(),
            structuredContent: state.toJSON(),
        };
    }

    // Session-gate prologue shared by every paused-only handler.
    private async requirePausedSession(): Promise<HandlerResponse | null> {
        const reason = await classifySessionState(this.executor);
        if (reason !== 'ok') return gateErrorFor(reason);
        return null;
    }

    private sourceBreakpointToSummary(
        bp: vscode.SourceBreakpoint,
        opts: { includeModifiers?: boolean } = {},
    ): Record<string, unknown> {
        const line = bp.location.range.start.line + 1;
        const base: Record<string, unknown> = {
            file: bp.location.uri.fsPath,
            line,
        };
        if (opts.includeModifiers) {
            if (bp.condition) base.condition = bp.condition;
            if (bp.hitCondition) base.hitCondition = bp.hitCondition;
            if (bp.logMessage) base.logMessage = bp.logMessage;
        }
        return base;
    }

    public async handleStartDebugging(args: StartDebuggingRequest): Promise<HandlerResponse> {
        const sessionGuard = requireNoActiveSession(this.executor);
        if (sessionGuard) return sessionGuard;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return handlerError("no_workspace", "No workspace folder open.");
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // Adapter routing: cppvsdbg (default, local Windows) vs prospero (PS5 kit).
        // Only the config build, pre-flight target, and default timeout differ; the
        // launch / attach-wait / outcome handling below is debugger-agnostic.
        let config: vscode.DebugConfiguration;
        let preflightPath: string | undefined;
        let defaultTimeout: number;
        if (args.debugger === 'prospero') {
            if (!isPs5Available()) {
                return handlerError("bad_input", "debugger='prospero' requested but the PlayStation 5 SDK debug server was not found (set SCE_ROOT_DIR).");
            }
            if (!args.elfPath) {
                return handlerError("bad_input", "debugger='prospero' requires 'elfPath'.");
            }
            config = buildProsperoLaunchConfig(args as ProsperoLaunchArgs) as unknown as vscode.DebugConfiguration;
            // Only a local host ELF path is checkable on disk; workspace/package paths live on the kit.
            preflightPath = (args.elfPathFormat ?? 'local') === 'local' ? args.elfPath : undefined;
            defaultTimeout = DebuggingHandler.DEFAULT_PROSPERO_TIMEOUT_SECONDS;
        } else {
            if (!args.program) {
                return handlerError("bad_input", "start_debugging requires 'program' (the .exe path) for the cppvsdbg debugger.");
            }
            config = buildCppvsdbgConfig(args as StartDebuggingArgs, workspaceRoot);
            preflightPath = args.program;
            defaultTimeout = DebuggingHandler.DEFAULT_ATTACH_TIMEOUT_SECONDS;
        }

        const timeoutSeconds = args.waitForBreakpointSeconds ?? defaultTimeout;
        const timeoutMs = timeoutSeconds * 1000;

        // Pre-flight: catch the missing-binary case before the debugger hangs.
        // Skip when the path contains a variable reference — those are resolved
        // later by VS Code's variable substitution layer.
        if (preflightPath && !preflightPath.includes('${')) {
            try {
                await fs.promises.access(preflightPath, fs.constants.F_OK);
            } catch {
                return handlerError(
                    "bad_input",
                    `Program not found: ${preflightPath}`,
                    { program: preflightPath },
                );
            }
        }

        // One shared deadline for the whole launch+attach+first-break cycle,
        // so the launch race and waitForSessionOutcome don't each consume the
        // full waitForBreakpointSeconds budget.
        const launchStartMs = Date.now();
        const deadline = launchStartMs + timeoutMs;

        // Race startDebugging against the deadline — headless VS Code can hang
        // on non-launchable configs that pre-flight can't detect (e.g. a file
        // that exists but isn't a valid PE binary).
        let launchTimer: ReturnType<typeof setTimeout> | undefined;
        const launchTimeout = new Promise<'timeout'>((resolve) => {
            launchTimer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const launchResult = await Promise.race([
            this.executor.startDebugging(workspaceRoot, config).then<'ok' | 'rejected'>(
                (ok) => (ok ? 'ok' : 'rejected'),
            ),
            launchTimeout,
        ]);
        if (launchTimer) clearTimeout(launchTimer);

        if (launchResult === 'rejected') {
            return handlerError(
                "launch_rejected",
                "vscode.debug.startDebugging returned false.",
            );
        }
        if (launchResult === 'timeout') {
            this.executor.stopDebugging().catch(() => undefined);
            return handlerError(
                "attach_failed",
                `Launch did not complete within ${timeoutSeconds}s.`,
                { timeoutSeconds },
            );
        }

        const remainingMs = Math.max(0, deadline - Date.now());
        const outcome = await this.waitForSessionOutcome(remainingMs, launchStartMs);

        switch (outcome.kind) {
            case 'paused': {
                const state = await this.executor.getCurrentDebugState(this.numNextLines);
                return {
                    text: `Paused at ${state.fileName}:${state.currentLine} in ${state.frameName ?? '<unknown>'}.`,
                    structuredContent: state.toJSON(),
                };
            }
            case 'exited': {
                return {
                    text: `Launched; ran to completion and exited with code ${outcome.exitCode ?? '<unknown>'}.`,
                    structuredContent: { outcome: 'exited', exitCode: outcome.exitCode ?? null },
                };
            }
            case 'attached': {
                const activeBreakpoints = vscode.debug.breakpoints
                    .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
                    .map((bp) => this.sourceBreakpointToSummary(bp));
                return {
                    text: `Attached; running. No breakpoint hit within ${timeoutSeconds}s.`,
                    structuredContent: {
                        outcome: 'running',
                        elapsedSeconds: timeoutSeconds,
                        activeBreakpoints,
                    },
                };
            }
            case 'never-attached':
                return handlerError(
                    "attach_failed",
                    `Debug session never attached within ${timeoutSeconds}s.`,
                    { timeoutSeconds },
                );
        }
    }

    public async handleAttachToProcess(args: AttachToProcessArgs): Promise<HandlerResponse> {
        const sessionGuard = requireNoActiveSession(this.executor);
        if (sessionGuard) return sessionGuard;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return handlerError("no_workspace", "No workspace folder open.");
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // Adapter routing: local cppvsdbg (Windows PID, enumerated here) vs remote
        // prospero (a kit-side PID string, taken as-is — no local enumeration).
        let config: vscode.DebugConfiguration;
        let pidLabel: string;
        let defaultTimeout: number;
        if (args.location === 'remote') {
            if (!isPs5Available()) {
                return handlerError("bad_input", "location='remote' requested but the PlayStation 5 SDK debug server was not found (set SCE_ROOT_DIR).");
            }
            if (args.processId === undefined) {
                return handlerError("bad_input", "Remote attach requires 'processId' (the kit-side PID, e.g. from list_kit_processes).");
            }
            const kitPid = String(args.processId);
            config = buildProsperoAttachConfig({
                processId: kitPid,
                target: args.target,
                extraAttachOptions: args.extraConfig,
            }) as unknown as vscode.DebugConfiguration;
            pidLabel = kitPid;
            defaultTimeout = DebuggingHandler.DEFAULT_PROSPERO_TIMEOUT_SECONDS;
        } else {
            if (args.processId === undefined && args.processName === undefined) {
                return handlerError("bad_input", "Provide either processId or processName.");
            }
            let pid: number;
            if (args.processId !== undefined) {
                pid = typeof args.processId === 'string' ? parseInt(args.processId, 10) : args.processId;
            } else {
                const matches = findProcessByName(args.processName!);
                if (matches.length === 0) {
                    return handlerError("bad_input", `No process found matching "${args.processName}".`);
                }
                if (matches.length > 1) {
                    return handlerError(
                        "bad_input",
                        `Multiple processes match "${args.processName}": ${matches.map((p) => `${p.name} (PID ${p.pid})`).join(', ')}. Specify processId instead.`,
                        { matches },
                    );
                }
                pid = matches[0].pid;
            }
            config = buildCppvsdbgAttachConfig({
                processId: pid,
                extraConfig: args.extraConfig,
            });
            pidLabel = String(pid);
            defaultTimeout = DebuggingHandler.DEFAULT_ATTACH_TIMEOUT_SECONDS;
        }

        const timeoutSeconds = args.waitForBreakpointSeconds ?? defaultTimeout;
        const timeoutMs = timeoutSeconds * 1000;
        const launchStartMs = Date.now();
        const deadline = launchStartMs + timeoutMs;

        let launchTimer: ReturnType<typeof setTimeout> | undefined;
        const launchTimeout = new Promise<'timeout'>((resolve) => {
            launchTimer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const launchResult = await Promise.race([
            this.executor.startDebugging(workspaceRoot, config).then<'ok' | 'rejected'>(
                (ok) => (ok ? 'ok' : 'rejected'),
            ),
            launchTimeout,
        ]);
        if (launchTimer) clearTimeout(launchTimer);

        if (launchResult === 'rejected') {
            return handlerError("launch_rejected", `Failed to attach to PID ${pidLabel}.`);
        }
        if (launchResult === 'timeout') {
            this.executor.stopDebugging().catch(() => undefined);
            return handlerError(
                "attach_failed",
                `Attach to PID ${pidLabel} did not complete within ${timeoutSeconds}s.`,
                { timeoutSeconds, processId: pidLabel },
            );
        }

        const remainingMs = Math.max(0, deadline - Date.now());
        const outcome = await this.waitForSessionOutcome(remainingMs, launchStartMs);

        switch (outcome.kind) {
            case 'paused': {
                const state = await this.executor.getCurrentDebugState(this.numNextLines);
                return {
                    text: `Attached to PID ${pidLabel}, paused at ${state.fileName}:${state.currentLine}.`,
                    structuredContent: state.toJSON(),
                };
            }
            case 'exited': {
                return {
                    text: `Attached to PID ${pidLabel}; the process exited with code ${outcome.exitCode ?? '<unknown>'}.`,
                    structuredContent: { outcome: 'exited', processId: pidLabel, exitCode: outcome.exitCode ?? null },
                };
            }
            case 'attached': {
                return {
                    text: `Attached to PID ${pidLabel}; running. Use add_breakpoint or add_address_breakpoint then continue_execution to pause.`,
                    structuredContent: { outcome: 'running', processId: pidLabel },
                };
            }
            case 'never-attached':
                return handlerError(
                    "attach_failed",
                    `Debug session never attached to PID ${pidLabel} within ${timeoutSeconds}s.`,
                    { timeoutSeconds, processId: pidLabel },
                );
        }
    }

    public async handleStopDebugging(
        args: { terminate?: boolean } = {},
    ): Promise<HandlerResponse> {
        const terminate = args.terminate ?? true;
        if (!this.executor.hasAttachedSession()) {
            return {
                text: 'No active debug session.',
                structuredContent: {},
            };
        }
        await this.executor.stopDebugging(undefined, { terminate });
        return {
            text: terminate
                ? 'Debug session stopped; process terminated.'
                : 'Debug session disconnected; process left running.',
            structuredContent: {},
        };
    }

    public async handleClearAllBreakpoints(): Promise<HandlerResponse> {
        const breakpointCount = this.executor.getBreakpoints().length;
        const instrCount = this.executor.getInstructionBreakpoints().size;
        const total = breakpointCount + instrCount;
        if (total === 0) {
            return { text: 'No breakpoints to clear.', structuredContent: { cleared: 0 } };
        }
        this.executor.clearAllBreakpoints();
        if (instrCount > 0) {
            await this.executor.clearInstructionBreakpoints();
        }
        return {
            text: `Cleared ${total} breakpoint${total === 1 ? '' : 's'} (${breakpointCount} source, ${instrCount} address).`,
            structuredContent: { cleared: total, source: breakpointCount, address: instrCount },
        };
    }

    private async runSteppingCommand(cmd: () => Promise<void>, verb: string): Promise<HandlerResponse> {
        const gate = await this.requirePausedSession();
        if (gate) return gate;

        const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);
        try {
            await cmd();
        } catch (error) {
            return handlerError(
                "debug_adapter_error",
                `Error executing ${verb}: ${error}`,
                { operation: verb, cause: String(error) },
            );
        }
        const afterState = await this.waitForStateChange(beforeState);
        return this.stateToEnvelope(afterState);
    }

    public async handlePause(): Promise<HandlerResponse> {
        if (!this.executor.hasAttachedSession()) {
            return handlerError("no_session", "No active debug session.");
        }
        try {
            await this.executor.pause();
        } catch (error) {
            return handlerError(
                "debug_adapter_error",
                `Failed to pause: ${error}`,
                { operation: "pause", cause: String(error) },
            );
        }
        const state = await this.waitForPausedState(Math.min(this.timeoutInSeconds * 1000, 5000));
        return this.stateToEnvelope(state);
    }

    public async handleStepOver(_args?: { steps?: number }): Promise<HandlerResponse> {
        return this.runSteppingCommand(() => this.executor.stepOver(), 'step over');
    }

    public async handleStepInto(): Promise<HandlerResponse> {
        return this.runSteppingCommand(() => this.executor.stepInto(), 'step into');
    }

    public async handleStepOut(): Promise<HandlerResponse> {
        return this.runSteppingCommand(() => this.executor.stepOut(), 'step out');
    }

    public async handleContinue(): Promise<HandlerResponse> {
        return this.runSteppingCommand(() => this.executor.continue(), 'continue');
    }

    public async handleRestart(): Promise<HandlerResponse> {
        if (!(await this.executor.hasActiveSession())) {
            return gateErrorFor('no_session');
        }
        try {
            await this.executor.restart();
            await new Promise(resolve => setTimeout(resolve, this.executionDelay));
            return {
                text: 'Debug session restarted.',
                structuredContent: {},
            };
        } catch (error) {
            return handlerError(
                "debug_adapter_error",
                `Error restarting debug session: ${error}`,
                { operation: "restart", cause: String(error) },
            );
        }
    }

    private async resolveTargetLines(
        fileFullPath: string,
        line: number | undefined,
        lineContent: string | undefined,
    ): Promise<number[] | HandlerResponse> {
        if ((line === undefined) === (lineContent === undefined)) {
            return handlerError("bad_input", "Provide exactly one of 'line' or 'lineContent'.");
        }
        if (line !== undefined) return [line];

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
        const matched: number[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            if (document.lineAt(i).text.includes(lineContent!)) matched.push(i + 1);
        }
        return matched;
    }

    public async handleAddBreakpoint(args: AddBreakpointArgs): Promise<HandlerResponse> {
        const { fileFullPath, line, lineContent, condition, hitCondition, logMessage, allowMultiple } = args;

        const resolved = await this.resolveTargetLines(fileFullPath, line, lineContent);
        if (!Array.isArray(resolved)) return resolved;
        const targetLines = resolved;

        if (lineContent !== undefined) {
            if (targetLines.length === 0) {
                return handlerError("no_match", `No lines in ${fileFullPath} contain: ${lineContent}`);
            }
            if (targetLines.length > 1 && !allowMultiple) {
                return handlerError(
                    "multi_match",
                    `lineContent matched ${targetLines.length} lines; pass allowMultiple=true to accept.`,
                    { matchedLines: targetLines },
                );
            }
        }

        const uri = vscode.Uri.file(fileFullPath);
        const set = targetLines.map((ln) => ({
            file: fileFullPath,
            line: ln,
            ...(condition ? { condition } : {}),
            ...(hitCondition ? { hitCondition } : {}),
            ...(logMessage ? { logMessage } : {}),
        }));
        await Promise.all(targetLines.map((ln) =>
            this.executor.addBreakpoint(uri, ln, { condition, hitCondition, logMessage }),
        ));

        const textOut = set.length === 1
            ? `Breakpoint added at ${fileFullPath}:${targetLines[0]}`
            : `Breakpoints added at ${set.length} locations in ${fileFullPath}: lines ${targetLines.join(', ')}`;

        return { text: textOut, structuredContent: { set } };
    }

    public async handleRemoveBreakpoint(args: RemoveBreakpointArgs): Promise<HandlerResponse> {
        const { fileFullPath, line, lineContent } = args;

        const resolved = await this.resolveTargetLines(fileFullPath, line, lineContent);
        if (!Array.isArray(resolved)) return resolved;
        const targetLines = resolved;

        const uri = vscode.Uri.file(fileFullPath);
        const uriStr = uri.toString();
        const targetSet = new Set(targetLines.map((ln) => ln - 1));
        const toRemove = this.executor.getBreakpoints().filter((bp): bp is vscode.SourceBreakpoint =>
            bp instanceof vscode.SourceBreakpoint &&
            bp.location.uri.toString() === uriStr &&
            targetSet.has(bp.location.range.start.line),
        );

        if (toRemove.length === 0) {
            return handlerError(
                "no_match",
                `No matching breakpoint found in ${fileFullPath}.`,
                { removed: 0 },
            );
        }

        vscode.debug.removeBreakpoints(toRemove);
        return {
            text: `Removed ${toRemove.length} breakpoint(s) in ${fileFullPath}`,
            structuredContent: { removed: toRemove.length },
        };
    }

    public async handleAddAddressBreakpoint(args: AddressBreakpointArgs): Promise<HandlerResponse> {
        if (!this.executor.hasAttachedSession()) {
            return handlerError("no_session", "No active debug session. Attach or launch first.");
        }

        if (!/^(0x)?[0-9a-fA-F]+$/.test(args.address)) {
            return handlerError("bad_input", `Invalid hex address: ${args.address}`);
        }

        try {
            await this.executor.addInstructionBreakpoint(args.address, {
                condition: args.condition,
                hitCondition: args.hitCondition,
                logMessage: args.logMessage,
            });
        } catch (error) {
            return handlerError(
                "debug_adapter_error",
                `Failed to set instruction breakpoint at ${args.address}: ${error}`,
                { address: args.address, cause: String(error) },
            );
        }

        const normalized = args.address.replace(/^0x/i, '');
        const display = '0x' + normalized.toUpperCase();
        return {
            text: `Address breakpoint set at ${display}.`,
            structuredContent: { address: display },
        };
    }

    public async handleRemoveAddressBreakpoint(args: { address: string }): Promise<HandlerResponse> {
        if (!this.executor.hasAttachedSession()) {
            return handlerError("no_session", "No active debug session.");
        }

        try {
            await this.executor.removeInstructionBreakpoint(args.address);
        } catch (error) {
            return handlerError(
                "no_match",
                `No instruction breakpoint at ${args.address}.`,
                { address: args.address },
            );
        }

        const normalized = args.address.replace(/^0x/i, '');
        const display = '0x' + normalized.toUpperCase();
        return {
            text: `Address breakpoint removed at ${display}.`,
            structuredContent: { address: display },
        };
    }

    public async handleListProcesses(args: ListProcessesArgs): Promise<HandlerResponse> {
        try {
            let processes = enumerateProcesses();
            if (args.filter) {
                const lower = args.filter.toLowerCase();
                processes = processes.filter((p) => p.name.toLowerCase().includes(lower));
            }
            const textOut = processes.length === 0
                ? 'No matching processes found.'
                : processes.map((p) => `${p.pid}\t${p.name}`).join('\n');
            return { text: textOut, structuredContent: { processes } };
        } catch (error) {
            return handlerError(
                "debug_adapter_error",
                `Failed to enumerate processes: ${error}`,
                { cause: String(error) },
            );
        }
    }

    public async handleListBreakpoints(): Promise<HandlerResponse> {
        const breakpoints = this.executor.getBreakpoints();
        const instrBps = this.executor.getInstructionBreakpoints();

        if (breakpoints.length === 0 && instrBps.size === 0) {
            return {
                text: 'No breakpoints currently set',
                structuredContent: { breakpoints: [], addressBreakpoints: [] },
            };
        }

        const structured: Array<Record<string, unknown>> = [];
        const addressStructured: Array<Record<string, unknown>> = [];
        let textOut = 'Active Breakpoints:\n';
        let idx = 1;

        breakpoints.forEach((bp) => {
            if (bp instanceof vscode.SourceBreakpoint) {
                const fileName = path.basename(bp.location.uri.fsPath);
                const line = bp.location.range.start.line + 1;
                textOut += `${idx++}. ${fileName}:${line}\n`;
                structured.push(this.sourceBreakpointToSummary(bp, { includeModifiers: true }));
            } else if (bp instanceof vscode.FunctionBreakpoint) {
                textOut += `${idx++}. Function: ${bp.functionName}\n`;
                structured.push({ functionName: bp.functionName });
            }
        });

        for (const entry of instrBps.values()) {
            textOut += `${idx++}. Address: ${entry.address}\n`;
            const item: Record<string, unknown> = { address: entry.address };
            if (entry.condition) item.condition = entry.condition;
            if (entry.hitCondition) item.hitCondition = entry.hitCondition;
            if (entry.logMessage) item.logMessage = entry.logMessage;
            addressStructured.push(item);
        }

        return { text: textOut, structuredContent: { breakpoints: structured, addressBreakpoints: addressStructured } };
    }

    public async handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<HandlerResponse> {
        const { scope = 'all' } = args;
        const gate = await this.requirePausedSession();
        if (gate) return gate;

        const activeStackItem = vscode.debug.activeStackItem;
        if (!activeStackItem || !('frameId' in activeStackItem)) {
            return gateErrorFor('not_paused');
        }

        const variablesData = await this.executor.getVariables(activeStackItem.frameId, scope);

        if (!variablesData.scopes || variablesData.scopes.length === 0) {
            return {
                text: 'No variable scopes available at current execution point.',
                structuredContent: { scopes: [] },
            };
        }

        const frameLabel = String(activeStackItem.frameId);
        let variablesInfo = `Variables at ${frameLabel}:\n`;
        for (const scopeItem of variablesData.scopes) {
            variablesInfo += `${scopeItem.name}:\n`;
            if (scopeItem.error) {
                variablesInfo += `  (error: ${scopeItem.error})\n`;
            } else if (scopeItem.variables && scopeItem.variables.length > 0) {
                for (const variable of scopeItem.variables) {
                    variablesInfo += `  ${variable.name}: ${variable.value}`;
                    if (variable.type) variablesInfo += ` (${variable.type})`;
                    variablesInfo += '\n';
                }
            } else {
                variablesInfo += '  (empty)\n';
            }
            variablesInfo += '\n';
        }

        return { text: variablesInfo.trimEnd(), structuredContent: variablesData };
    }

    public async handleEvaluateExpression(args: { expression: string }): Promise<HandlerResponse> {
        const gate = await this.requirePausedSession();
        if (gate) return gate;

        const activeStackItem = vscode.debug.activeStackItem;
        if (!activeStackItem || !('frameId' in activeStackItem)) {
            return gateErrorFor('not_paused');
        }

        const response = await this.executor.evaluateExpression(args.expression, activeStackItem.frameId);
        if (!response || response.result === undefined) {
            return handlerError(
                "evaluate_failed",
                "Failed to evaluate expression.",
                { expression: args.expression },
            );
        }

        const textOut = `Expression: ${args.expression}\nResult: ${response.result}${response.type ? ` (${response.type})` : ''}`;
        return {
            text: textOut,
            structuredContent: {
                expression: args.expression,
                result: response.result,
                type: response.type ?? null,
            },
        };
    }

    public async handleGetDebugState(): Promise<HandlerResponse> {
        const gate = await this.requirePausedSession();
        if (gate) return gate;
        const state = await this.executor.getCurrentDebugState(this.numNextLines);
        return this.stateToEnvelope(state);
    }

    public async handleGetExceptionInfo(): Promise<HandlerResponse> {
        const session = this.executor.getActiveSession();
        if (!session) {
            return handlerError("no_session", "No active debug session.");
        }
        const activeStackItem = vscode.debug.activeStackItem;
        const threadId = activeStackItem && 'threadId' in activeStackItem
            ? activeStackItem.threadId
            : undefined;
        if (threadId === undefined) {
            return gateErrorFor('not_paused');
        }
        try {
            // DAP exceptionInfo → { exceptionId, description?, breakMode, details? }.
            // For a PS5 SIGSEGV this carries the signal + faulting address / access type.
            const info = await session.customRequest('exceptionInfo', { threadId });
            const detailMsg = info?.details?.message ? `\n${info.details.message}` : '';
            const text = `Exception: ${info?.exceptionId ?? '<unknown>'}` +
                (info?.description ? ` — ${info.description}` : '') + detailMsg;
            return { text, structuredContent: info ?? {} };
        } catch (error) {
            return handlerError(
                "debug_adapter_error",
                `exceptionInfo request failed (the adapter may not support it, or the stop was not an exception): ${error}`,
                { cause: String(error) },
            );
        }
    }

    public async handleListKitProcesses(args: { target?: string }): Promise<HandlerResponse> {
        if (!isPs5Available()) {
            return handlerError("bad_input", "PlayStation 5 SDK not found (set SCE_ROOT_DIR); list_kit_processes is unavailable.");
        }
        try {
            const raw = listKitProcessesRaw(args.target);
            return {
                text: raw.trim() || '(no processes reported)',
                structuredContent: { raw, target: args.target ?? null },
            };
        } catch (error) {
            return handlerError(
                "debug_adapter_error",
                `prospero-ctrl process list failed: ${error}`,
                { cause: String(error) },
            );
        }
    }

    public async handleGetProgramOutput(args: { tail?: number }): Promise<HandlerResponse> {
        const buffer = this.executor.getOutputBuffer();
        if (!buffer) {
            return { text: '', structuredContent: { content: '', truncated: false } };
        }
        const read = typeof args.tail === 'number' && args.tail > 0
            ? buffer.tail(args.tail)
            : buffer.read();
        return { text: read.content, structuredContent: read };
    }

    public async getCurrentDebugState(): Promise<DebugState> {
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    public async isDebuggingActive(): Promise<boolean> {
        return await this.executor.hasActiveSession();
    }

    private async waitForPausedState(timeoutMs: number): Promise<DebugState> {
        const pollMs = 100;
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const state = await this.executor.getCurrentDebugState(this.numNextLines);
            if (state.isPaused()) {
                return state;
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    private async waitForSessionOutcome(
        timeoutMs: number,
        launchStartMs: number,
    ): Promise<SessionOutcome> {
        const baseDelay = 1000;
        const maxDelay = 10000;
        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < timeoutMs) {
            if (await this.executor.hasActiveSession()) {
                logger.info('Debug session reached paused state.');
                return { kind: 'paused' };
            }
            // No paused session and nothing attached → the debuggee may have run to
            // completion without pausing. Report its exit code rather than a misleading
            // "never attached".
            if (!this.executor.hasAttachedSession()) {
                const exit = getExitSince(launchStartMs);
                if (exit) {
                    logger.info(`Debug session exited with code ${exit.exitCode}.`);
                    return { kind: 'exited', exitCode: exit.exitCode };
                }
            }
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            const jitteredDelay = delay + Math.random() * 200;
            await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
            attempt++;
        }

        const exit = getExitSince(launchStartMs);
        if (exit) return { kind: 'exited', exitCode: exit.exitCode };
        return this.executor.hasAttachedSession() ? { kind: 'attached' } : { kind: 'never-attached' };
    }

    private async waitForStateChange(beforeState: DebugState): Promise<DebugState> {
        const pollMs = 1000;
        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < this.timeoutInSeconds * 1000) {
            const currentState = await this.executor.getCurrentDebugState(this.numNextLines);

            if (this.hasStateChanged(beforeState, currentState)) {
                return currentState;
            }

            if (!currentState.sessionActive) {
                return currentState;
            }

            logger.info(`[Attempt ${attempt + 1}] Waiting for debugger state to change...`);
            await new Promise((resolve) => setTimeout(resolve, pollMs + Math.random() * 200));
            attempt++;
        }

        logger.info('State change detection timed out, returning current state');
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    private hasStateChanged(beforeState: DebugState, afterState: DebugState): boolean {
        if (beforeState.hasLocationInfo() && !afterState.hasLocationInfo() && afterState.sessionActive) {
            return false;
        }
        if (beforeState.sessionActive !== afterState.sessionActive) return true;
        if (!afterState.sessionActive) return true;
        if (!beforeState.hasLocationInfo() || !afterState.hasLocationInfo()) {
            return beforeState.hasLocationInfo() !== afterState.hasLocationInfo();
        }
        if (beforeState.fileFullPath !== afterState.fileFullPath) return true;
        if (beforeState.currentLine !== afterState.currentLine) return true;
        if (beforeState.frameName !== afterState.frameName) return true;
        if (beforeState.frameId !== afterState.frameId) return true;
        return false;
    }

}
