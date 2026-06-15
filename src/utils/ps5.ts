// PlayStation(R)5 ("prospero") availability detection + SDK tool access.
//
// Powers the feature-gate for the PS5 tool surface: when the PS5 SDK is present
// (SCE_ROOT_DIR set and Sony's debug server exists on disk) the wrapper installs
// Sony's `vscode-prospero-debug` extension as-shipped and DebugMCP exposes the
// PS5 tools; otherwise the PS5 tools are not registered and only the cppvsdbg
// surface shows. Reproduces none of Sony's code — these are plain path lookups
// against the documented SDK layout.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function sceRoot(): string {
    return process.env.SCE_ROOT_DIR ?? '';
}

function existsOrNull(p: string): string | null {
    try {
        return fs.existsSync(p) ? p : null;
    } catch {
        return null;
    }
}

/** Path to Sony's DAP debug server, or null if the SDK is absent. */
export function prosperoDebugserverPath(): string | null {
    const root = sceRoot();
    if (!root) return null;
    return existsOrNull(path.join(
        root, 'Prospero', 'Tools', 'Debugger', 'bin', 'x64', 'prospero-debugserver-x64.exe',
    ));
}

/** Path to prospero-ctrl (kit + process control), or null if the SDK is absent. */
export function prosperoCtrlPath(): string | null {
    const root = sceRoot();
    if (!root) return null;
    return existsOrNull(path.join(
        root, 'Prospero', 'Tools', 'Target Manager Server', 'bin', 'prospero-ctrl.exe',
    ));
}

/** True when the PS5 SDK debug stack is present and the PS5 tools should be exposed. */
export function isPs5Available(): boolean {
    return prosperoDebugserverPath() !== null;
}

/**
 * Run `prospero-ctrl process list [/target:<t>]` and return its raw stdout — the
 * kit-side process table (hex PID + name + path) needed to find a PID for a
 * remote attach. Returned raw (not column-parsed) until the exact on-kit output
 * format is confirmed; callers surface it as text for the agent to read.
 */
export function listKitProcessesRaw(target?: string): string {
    const ctrl = prosperoCtrlPath();
    if (!ctrl) {
        throw new Error('prospero-ctrl not found (PS5 SDK not installed / SCE_ROOT_DIR unset).');
    }
    const args = ['process', 'list'];
    if (target) args.push(`/target:${target}`);
    return execFileSync(ctrl, args, { encoding: 'utf-8', timeout: 30000 });
}
