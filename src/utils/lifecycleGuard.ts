// Copyright (c) Microsoft Corporation.

/**
 * Idle-timer state machine. Pure module — no vscode import; callers own
 * the event subscriptions that drive arm/disarm.
 *
 * `touch()` only refreshes an *armed* timer so that tool calls between
 * sessions don't accidentally schedule a stop on nothing.
 */
export class LifecycleGuard {
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly idleMs: number,
        private readonly stopFn: () => Promise<void>,
    ) {}

    arm(): void {
        this.clearTimer();
        this.timer = setTimeout(() => this.fire(), this.idleMs);
    }

    touch(): void {
        if (this.timer === null) return;
        this.arm();
    }

    disarm(): void {
        this.clearTimer();
    }

    dispose(): void {
        this.clearTimer();
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private fire(): void {
        this.timer = null;
        this.stopFn().catch(() => {
            // Swallow — caller logs at the integration site.
        });
    }
}
