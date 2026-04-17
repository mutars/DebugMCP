// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DebugState } from './debugState';
import { IDebuggingExecutor } from './debuggingExecutor';
import { logger } from './utils/logger';
import { buildCppvsdbgConfig, StartDebuggingArgs } from './utils/cppvsdbgConfig';
import { classifySessionState, gateErrorFor, handlerError, requireNoActiveSession } from './utils/sessionGate';

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

export interface IDebuggingHandler {
    handleStartDebugging(args: StartDebuggingArgs): Promise<HandlerResponse>;
    handleStopDebugging(args?: { terminate?: boolean }): Promise<HandlerResponse>;
    handleStepOver(args?: { steps?: number }): Promise<HandlerResponse>;
    handleStepInto(): Promise<HandlerResponse>;
    handleStepOut(): Promise<HandlerResponse>;
    handleContinue(): Promise<HandlerResponse>;
    handleRestart(): Promise<HandlerResponse>;
    handleAddBreakpoint(args: AddBreakpointArgs): Promise<HandlerResponse>;
    handleRemoveBreakpoint(args: RemoveBreakpointArgs): Promise<HandlerResponse>;
    handleClearAllBreakpoints(): Promise<HandlerResponse>;
    handleListBreakpoints(): Promise<HandlerResponse>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<HandlerResponse>;
    handleEvaluateExpression(args: { expression: string }): Promise<HandlerResponse>;
    handleGetProgramOutput(args: { tail?: number }): Promise<HandlerResponse>;
    handleGetDebugState(): Promise<HandlerResponse>;
}

export class DebuggingHandler implements IDebuggingHandler {
    private readonly numNextLines: number = 3;
    private readonly executionDelay: number = 300;
    private readonly timeoutInSeconds: number;
    private static readonly DEFAULT_ATTACH_TIMEOUT_SECONDS = 30;

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

    public async handleStartDebugging(args: StartDebuggingArgs): Promise<HandlerResponse> {
        const sessionGuard = requireNoActiveSession(this.executor);
        if (sessionGuard) return sessionGuard;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return handlerError("no_workspace", "No workspace folder open.");
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        const config = buildCppvsdbgConfig(args, workspaceRoot);
        const timeoutSeconds =
            args.waitForBreakpointSeconds ?? DebuggingHandler.DEFAULT_ATTACH_TIMEOUT_SECONDS;
        const timeoutMs = timeoutSeconds * 1000;

        // Pre-flight: catch the common typo case before the debugger hangs.
        // Skip when the path contains a variable reference — those are resolved
        // later by VS Code's variable substitution layer.
        if (!args.program.includes('${')) {
            try {
                await fs.promises.access(args.program, fs.constants.F_OK);
            } catch {
                return handlerError(
                    "bad_input",
                    `Program not found: ${args.program}`,
                    { program: args.program },
                );
            }
        }

        // One shared deadline for the whole launch+attach+first-break cycle,
        // so the launch race and waitForSessionOutcome don't each consume the
        // full waitForBreakpointSeconds budget.
        const deadline = Date.now() + timeoutMs;

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
        const outcome = await this.waitForSessionOutcome(remainingMs);

        switch (outcome) {
            case 'paused': {
                const state = await this.executor.getCurrentDebugState(this.numNextLines);
                return {
                    text: `Paused at ${state.fileName}:${state.currentLine} in ${state.frameName ?? '<unknown>'}.`,
                    structuredContent: state.toJSON(),
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
        if (breakpointCount === 0) {
            return { text: 'No breakpoints to clear.', structuredContent: { cleared: 0 } };
        }
        this.executor.clearAllBreakpoints();
        return {
            text: `Cleared ${breakpointCount} breakpoint${breakpointCount === 1 ? '' : 's'}.`,
            structuredContent: { cleared: breakpointCount },
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

    public async handleListBreakpoints(): Promise<HandlerResponse> {
        const breakpoints = this.executor.getBreakpoints();
        if (breakpoints.length === 0) {
            return {
                text: 'No breakpoints currently set',
                structuredContent: { breakpoints: [] },
            };
        }

        const structured: Array<Record<string, unknown>> = [];
        let textOut = 'Active Breakpoints:\n';
        breakpoints.forEach((bp, index) => {
            if (bp instanceof vscode.SourceBreakpoint) {
                const fileName = path.basename(bp.location.uri.fsPath);
                const line = bp.location.range.start.line + 1;
                textOut += `${index + 1}. ${fileName}:${line}\n`;
                structured.push(this.sourceBreakpointToSummary(bp, { includeModifiers: true }));
            } else if (bp instanceof vscode.FunctionBreakpoint) {
                textOut += `${index + 1}. Function: ${bp.functionName}\n`;
                structured.push({ functionName: bp.functionName });
            }
        });

        return { text: textOut, structuredContent: { breakpoints: structured } };
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

    private async waitForSessionOutcome(
        timeoutMs: number,
    ): Promise<'paused' | 'attached' | 'never-attached'> {
        const baseDelay = 1000;
        const maxDelay = 10000;
        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < timeoutMs) {
            if (await this.executor.hasActiveSession()) {
                logger.info('Debug session reached paused state.');
                return 'paused';
            }
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            const jitteredDelay = delay + Math.random() * 200;
            await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
            attempt++;
        }

        return this.executor.hasAttachedSession() ? 'attached' : 'never-attached';
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
