// Copyright (c) Microsoft Corporation.

import * as path from 'path';

/** Mirror of vscode.DebugConfiguration, vscode-runtime-free so unit tests don't need the host. */
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
    environment?: Record<string, string>;
    console?: ConsoleMode;
    stopAtEntry?: boolean;
    extraConfig?: Record<string, unknown>;
    waitForBreakpointSeconds?: number;
}

// Merge order (later wins): extraConfig → explicit fields + defaults → hardcoded type/request/name.
export function buildCppvsdbgConfig(
    args: StartDebuggingArgs,
    workspaceRoot: string,
): DebugConfigurationLike {
    const envRecord = args.environment ?? {};
    const environment = Object.entries(envRecord).map(([name, value]) => ({ name, value }));
    return {
        ...(args.extraConfig ?? {}),
        program: args.program,
        args: args.args ?? [],
        cwd: args.cwd ?? workspaceRoot,
        environment,
        console: args.console ?? "internalConsole",
        stopAtEntry: args.stopAtEntry ?? false,
        type: "cppvsdbg",
        request: "launch",
        name: `DebugMCP: ${path.basename(args.program)}`,
    };
}
