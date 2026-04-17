// Copyright (c) Microsoft Corporation.

export type SessionReason = "ok" | "no_session" | "not_paused";

export type HandlerErrorReason =
    | "no_session"
    | "not_paused"
    | "session_active"
    | "bad_input"
    | "no_match"
    | "multi_match"
    | "no_workspace"
    | "launch_rejected"
    | "attach_failed"
    | "debug_adapter_error"
    | "evaluate_failed";

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

export interface HandlerErrorResponse {
    isError: true;
    text: string;
    structuredContent: { reason: HandlerErrorReason } & Record<string, unknown>;
}

export function gateErrorFor(reason: Exclude<SessionReason, "ok">): HandlerErrorResponse {
    const text =
        reason === "no_session"
            ? "No active debug session."
            : "Debug session is active but not paused.";
    return handlerError(reason, text);
}

export function handlerError(
    reason: HandlerErrorReason,
    text: string,
    details: Record<string, unknown> = {},
): HandlerErrorResponse {
    return {
        isError: true,
        text,
        structuredContent: { reason, ...details },
    };
}

export function gateErrorForActive(): HandlerErrorResponse {
    return handlerError(
        "session_active",
        "A debug session is already active. Call `stop_debugging` to end it before starting a new one.",
    );
}

/**
 * Pre-check helper for handlers that must NOT have an active session
 * (currently only `start_debugging`). Returns `null` when clear, or the
 * canonical error envelope when a session is already attached.
 */
export function requireNoActiveSession(
    probe: { hasAttachedSession: () => boolean },
): HandlerErrorResponse | null {
    return probe.hasAttachedSession() ? gateErrorForActive() : null;
}
