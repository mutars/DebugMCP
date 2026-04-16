// Copyright (c) Microsoft Corporation.

export function resolvePort(env: NodeJS.ProcessEnv, configured: number): number {
    const raw = env.DEBUGMCP_PORT;
    if (raw === undefined || raw === '') return configured;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return configured;
    return parsed;
}
