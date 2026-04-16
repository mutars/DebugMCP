// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { OutputRingBuffer } from './outputRingBuffer';

const CAPACITY_BYTES = 1_000_000;

export function createOutputTrackerFactory(buffer: OutputRingBuffer): vscode.DebugAdapterTrackerFactory {
    return {
        createDebugAdapterTracker(_session: vscode.DebugSession): vscode.DebugAdapterTracker {
            return {
                onWillStartSession() { buffer.clear(); },
                onDidSendMessage(message: any) {
                    if (message?.type === 'event' && message.event === 'output') {
                        const body = message.body ?? {};
                        const text = typeof body.output === 'string' ? body.output : '';
                        const category: string | undefined = body.category;
                        if (text && (category === 'stdout' || category === 'stderr' || !category)) {
                            buffer.append(text);
                        }
                    }
                },
            };
        },
    };
}

export function registerOutputTracker(
    context: vscode.ExtensionContext,
    buffer: OutputRingBuffer,
): void {
    const factory = createOutputTrackerFactory(buffer);
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('cppvsdbg', factory),
    );
}

export const OUTPUT_BUFFER_CAPACITY = CAPACITY_BYTES;
