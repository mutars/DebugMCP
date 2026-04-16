// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as http from 'http';
import { AgentConfigurationManager } from '../utils/agentConfigurationManager';
import { DebugMCPServer } from '../debugMCPServer';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('AgentConfigurationManager.shouldShowPopup headless gate', () => {
    function makeContext(popupShown: boolean) {
        return {
            globalState: {
                get: (_key: string, def: boolean) => popupShown ?? def,
            },
        } as any;
    }

    test('returns false when headless is true, even if popup unshown', async () => {
        const mgr = new AgentConfigurationManager(makeContext(false), 180, 3001, true);
        assert.strictEqual(await mgr.shouldShowPopup(), false);
    });

    test('returns true when headless is false and popup not yet shown', async () => {
        const mgr = new AgentConfigurationManager(makeContext(false), 180, 3001, false);
        assert.strictEqual(await mgr.shouldShowPopup(), true);
    });
});

suite('logBindFailure helper', () => {
    test('emits DEBUGMCP_BIND_FAILED token for EADDRINUSE errors', () => {
        const { logBindFailure } = require('../debugMCPServer');
        const captured: string[] = [];
        const err = Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
        logBindFailure(54321, err, (msg: string) => captured.push(msg));
        assert.strictEqual(captured.length, 1);
        assert.ok(captured[0].includes('DEBUGMCP_BIND_FAILED port=54321'),
            `expected token, got: ${captured[0]}`);
    });

    test('does not emit token for non-EADDRINUSE errors', () => {
        const { logBindFailure } = require('../debugMCPServer');
        const captured: string[] = [];
        const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        logBindFailure(54321, err, (msg: string) => captured.push(msg));
        assert.strictEqual(captured.length, 0);
    });
});
