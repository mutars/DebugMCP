// Copyright (c) Microsoft Corporation.

export type SessionReason = "ok" | "no_session" | "not_paused";

/**
 * Minimal surface the classifier needs. Narrow interface so the util can be
 * unit-tested without a full IDebuggingExecutor mock.
 */
export interface SessionProbe {
    hasActiveSession(): Promise<boolean>;  // paused at a location
    hasAttachedSession(): boolean;         // session object exists (may be running)
}

export async function classifySessionState(probe: SessionProbe): Promise<SessionReason> {
    if (await probe.hasActiveSession()) return "ok";
    return probe.hasAttachedSession() ? "not_paused" : "no_session";
}

export interface GateErrorResponse {
    isError: true;
    text: string;
    structuredContent: { reason: Exclude<SessionReason, "ok"> };
}

export function gateErrorFor(reason: Exclude<SessionReason, "ok">): GateErrorResponse {
    const text =
        reason === "no_session"
            ? "No active debug session."
            : "Debug session is active but not paused.";
    return { isError: true, text, structuredContent: { reason } };
}
