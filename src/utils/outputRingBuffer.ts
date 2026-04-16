// Copyright (c) Microsoft Corporation.

export interface OutputRead {
    content: string;
    truncated: boolean;
}

// Byte-accurate eviction — truncation may split a line mid-way.
export class OutputRingBuffer {
    private chunks: string[] = [];
    private size = 0;
    private evicted = false;

    constructor(private readonly capacityBytes: number) {}

    public append(text: string): void {
        if (!text) return;
        this.chunks.push(text);
        this.size += text.length;
        while (this.size > this.capacityBytes && this.chunks.length > 0) {
            const head = this.chunks[0];
            const overflow = this.size - this.capacityBytes;
            if (head.length <= overflow) {
                this.size -= head.length;
                this.chunks.shift();
            } else {
                this.chunks[0] = head.slice(overflow);
                this.size -= overflow;
            }
            this.evicted = true;
        }
    }

    public read(): OutputRead {
        return { content: this.chunks.join(""), truncated: this.evicted };
    }

    public tail(lines: number): OutputRead {
        if (lines <= 0) return { content: "", truncated: this.evicted };
        const full = this.chunks.join("");
        const parts = full.split(/(?<=\n)/);
        const tailContent = parts.slice(-lines).join("");
        return { content: tailContent, truncated: this.evicted };
    }

    public clear(): void {
        this.chunks = [];
        this.size = 0;
        this.evicted = false;
    }
}
