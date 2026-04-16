// Copyright (c) Microsoft Corporation.

import * as path from 'path';

/**
 * Structural mirror of vscode.DebugConfiguration, kept vscode-runtime-free so
 * this module can be unit-tested from a plain Node/vitest harness.
 */
export interface DebugConfigurationLike {
    type: string;
    request: string;
    name: string;
    [key: string]: unknown;
}

export type ConsoleMode =
    | "integratedTerminal"
    | "internalConsole"
    | "externalTerminal"
    | "newExternalWindow";

export interface StartDebuggingArgs {
    program: string;
    args?: string[];
    cwd?: string;
    environment?: Array<{ name: string; value: string }>;
    console?: ConsoleMode;
    stopAtEntry?: boolean;
    extraConfig?: Record<string, unknown>;
    waitForBreakpointSeconds?: number;
}

/**
 * Build a cppvsdbg DebugConfiguration from tool-call args.
 *
 * Merge order (later wins):
 *   1. extraConfig (escape hatch)
 *   2. explicit fields (with defaults filled in)
 *   3. hardcoded type/request/name
 */
export function buildCppvsdbgConfig(
    args: StartDebuggingArgs,
    workspaceRoot: string,
): DebugConfigurationLike {
    return {
        ...(args.extraConfig ?? {}),
        program: args.program,
        args: args.args ?? [],
        cwd: args.cwd ?? workspaceRoot,
        environment: args.environment ?? [],
        console: args.console ?? "integratedTerminal",
        stopAtEntry: args.stopAtEntry ?? false,
        type: "cppvsdbg",
        request: "launch",
        name: `DebugMCP: ${path.basename(args.program)}`,
    };
}
