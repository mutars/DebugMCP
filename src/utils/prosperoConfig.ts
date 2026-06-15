// PlayStation(R)5 ("prospero") DAP launch/attach configuration builder.
//
// Produces the vscode.DebugConfiguration object passed to
// `vscode.debug.startDebugging({ type: "prospero", ... })`. The `prospero` debug
// type, its config schema, and the debug adapter are all owned by the installed,
// as-shipped Sony `vscode-prospero-debug` extension — this file only builds the
// conforming config OBJECT (it reproduces none of Sony's schema). Field shapes
// follow the proven on-kit DAP client (scripts/ps5/ps5_dap_debug.js).

import * as path from 'path';

/** Mirror of vscode.DebugConfiguration, runtime-free so unit tests don't need the host. */
export interface ProsperoConfigurationLike {
    type: string;
    request: string;
    name: string;
    [key: string]: unknown;
}

export type ProsperoElfPathFormat = "local" | "workspace" | "package";

export interface ProsperoLaunchArgs {
    /** Path to the ELF to launch. Host path when elfPathFormat="local". */
    elfPath: string;
    /** argv passed to the launched ELF (one token per element). */
    args?: string[];
    /** Kit name / hostname / IP. Omitted → the SDK default target is used. */
    target?: string;
    /** local (host path) | workspace | package. Default "local". */
    elfPathFormat?: ProsperoElfPathFormat;
    /** Working Directory (/app0/) override. */
    workingDirectory?: string;
    /** Break at the program entry point before anything runs. */
    stopOnEntry?: boolean;
    /** Less-common launchOptions fields (gp5File, app, saveDataRootDirectory, ...) merged in; explicit fields win. */
    extraLaunchOptions?: Record<string, unknown>;
    /** Budget for the launch + attach + first-break cycle. */
    waitForBreakpointSeconds?: number;
}

export interface ProsperoAttachArgs {
    /** Kit-side process id (a string, per the prospero attach schema). */
    processId: string;
    /** Kit name / hostname / IP. Omitted → the SDK default target is used. */
    target?: string;
    /** Extra attachOptions merged in; explicit fields win. */
    extraAttachOptions?: Record<string, unknown>;
    waitForBreakpointSeconds?: number;
}

// Merge order (later wins): extraLaunchOptions → explicit fields. type/request/name are hardcoded.
export function buildProsperoLaunchConfig(args: ProsperoLaunchArgs): ProsperoConfigurationLike {
    const launchOptions: Record<string, unknown> = {
        ...(args.extraLaunchOptions ?? {}),
        elfPath: args.elfPath,
        elfPathFormat: args.elfPathFormat ?? "local",
        args: args.args ?? [],
    };
    if (args.target) launchOptions.target = args.target;
    if (args.workingDirectory !== undefined) launchOptions.workingDirectory = args.workingDirectory;

    return {
        launchOptions,
        debuggerOptions: { stopOnEntry: args.stopOnEntry ?? false },
        type: "prospero",
        request: "launch",
        name: `DebugMCP: ${path.basename(args.elfPath)} (PS5)`,
    };
}

export function buildProsperoAttachConfig(args: ProsperoAttachArgs): ProsperoConfigurationLike {
    const attachOptions: Record<string, unknown> = {
        ...(args.extraAttachOptions ?? {}),
        processId: args.processId,
    };
    if (args.target) attachOptions.target = args.target;

    return {
        attachOptions,
        type: "prospero",
        request: "attach",
        name: `DebugMCP: Attach PS5 PID ${args.processId}`,
    };
}
