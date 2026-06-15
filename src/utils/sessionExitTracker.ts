// Tracks the DAP `exited` event for debug sessions so a launch that runs to
// completion (no breakpoint hit, no fault) can be reported as a clean run with
// its exit code, instead of being misclassified as "never attached".

import * as vscode from 'vscode';

interface ExitInfo {
    exitCode: number | undefined;
    atMs: number;
    sessionId: string;
}

let lastExit: ExitInfo | undefined;

export function registerSessionExitTracker(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('*', {
            createDebugAdapterTracker(session: vscode.DebugSession) {
                return {
                    onDidSendMessage(m: any) {
                        if (m?.type === 'event' && m.event === 'exited') {
                            lastExit = {
                                exitCode: m.body?.exitCode,
                                atMs: Date.now(),
                                sessionId: session.id,
                            };
                        }
                    },
                };
            },
        }),
    );
}

/**
 * The most recent DAP `exited` event at or after `sinceMs`, else undefined.
 * DebugMCP enforces a single active session, so an exit recorded after a launch
 * began unambiguously belongs to that launch.
 */
export function getExitSince(sinceMs: number): { exitCode: number | undefined } | undefined {
    return lastExit && lastExit.atMs >= sinceMs ? { exitCode: lastExit.exitCode } : undefined;
}
