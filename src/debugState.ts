// Copyright (c) Microsoft Corporation.

/**
 * Represents a single stack frame in the call stack
 */
export interface StackFrame {
    name: string;
    source?: string;
    line?: number;
    column?: number;
}

/**
 * Represents the current state of a debugging session
 */
export class DebugState {
    public sessionActive: boolean;
    public fileFullPath: string | null;
    public fileName: string | null;
    public currentLine: number | null;
    public currentLineContent: string | null;
    public nextLines: string[];
    public frameId: number | null;
    public threadId: number | null;
    public frameName: string | null;
    public stackTrace: StackFrame[];
    public configurationName: string | null;
    public breakpoints: string[];
    
    constructor() {
        this.sessionActive = false;
        this.fileFullPath = null;
        this.fileName = null;
        this.currentLine = null;
        this.currentLineContent = null;
        this.nextLines = [];
        this.frameId = null;
        this.threadId = null;
        this.frameName = null;
        this.stackTrace = [];
        this.configurationName = null;
        this.breakpoints = [];
    }

    /**
     * Reset the debug state to initial values
     */
    public reset(): void {
        this.sessionActive = false;
        this.fileFullPath = null;
        this.fileName = null;
        this.currentLine = null;
        this.currentLineContent = null;
        this.nextLines = [];
        this.frameId = null;
        this.threadId = null;
        this.frameName = null;
        this.stackTrace = [];
        this.configurationName = null;
        this.breakpoints = [];
    }

    /**
     * Check if the debug session has valid execution context
     */
    public hasValidContext(): boolean {
        return this.sessionActive && 
               this.frameId !== null && 
               this.threadId !== null;
    }

    /**
     * Check if location information is available
     */
    public hasLocationInfo(): boolean {
        return this.fileName !== null && 
               this.currentLine !== null;
    }

    /**
     * Update the current execution context
     */
    public updateContext(frameId: number, threadId: number): void {
        this.frameId = frameId;
        this.threadId = threadId;
    }

    /**
     * Update the current execution location
     */
    public updateLocation(
        fileFullPath: string,
        fileName: string,
        currentLine: number,
        currentLineContent: string,
        nextLines: string[]
    ): void {
        this.fileFullPath = fileFullPath;
        this.fileName = fileName;
        this.currentLine = currentLine;
        this.currentLineContent = currentLineContent;
        this.nextLines = [...nextLines];
    }

    /**
     * Update frame name context
     */
    public updateFrameName(frameName: string | null): void {
        this.frameName = frameName;
    }

    /**
     * Update stack trace
     */
    public updateStackTrace(stackTrace: StackFrame[]): void {
        this.stackTrace = [...stackTrace];
    }

    /**
     * Check if frame name is available
     */
    public hasFrameName(): boolean {
        return this.frameName !== null;
    }

    /**
     * Update the configuration name
     */
    public updateConfigurationName(configurationName: string | null): void {
        this.configurationName = configurationName;
    }

    /**
     * Update breakpoints list (formatted as "fileName:line" strings)
     */
    public updateBreakpoints(breakpoints: string[]): void {
        this.breakpoints = [...breakpoints];
    }

    public clone(): DebugState {
        const cloned = new DebugState();
        cloned.sessionActive = this.sessionActive;
        cloned.fileFullPath = this.fileFullPath;
        cloned.fileName = this.fileName;
        cloned.currentLine = this.currentLine;
        cloned.currentLineContent = this.currentLineContent;
        cloned.nextLines = [...this.nextLines];
        cloned.frameId = this.frameId;
        cloned.threadId = this.threadId;
        cloned.frameName = this.frameName;
        cloned.stackTrace = [...this.stackTrace];
        cloned.configurationName = this.configurationName;
        cloned.breakpoints = [...this.breakpoints];
        return cloned;
    }

    public toJSON(): Record<string, unknown> {
        const paused = this.sessionActive && this.hasLocationInfo();
        const base: Record<string, unknown> = {
            sessionActive: this.sessionActive,
            paused,
        };
        if (!paused) return base;
        base.configurationName = this.configurationName;
        base.stackTrace = this.stackTrace.map((f) => `${f.name}:${f.line ?? '?'}`);
        base.breakpoints = this.breakpoints;
        base.fileFullPath = this.fileFullPath;
        base.fileName = this.fileName;
        base.currentLine = this.currentLine;
        base.currentLineContent = this.currentLineContent;
        base.nextLines = this.nextLines;
        base.frameId = this.frameId;
        base.threadId = this.threadId;
        base.frameName = this.frameName;
        return base;
    }

    public toString(): string {
        return JSON.stringify(this.toJSON(), null, 2);
    }
}
