// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { resolvePort } from '../utils/portResolver';

suite('resolvePort', () => {
    test('DEBUGMCP_PORT env var wins over configured setting', () => {
        const port = resolvePort({ DEBUGMCP_PORT: '54321' }, 3001);
        assert.strictEqual(port, 54321);
    });

    test('falls back to configured setting when env unset', () => {
        const port = resolvePort({}, 4000);
        assert.strictEqual(port, 4000);
    });

    test('ignores env var if not a finite number', () => {
        assert.strictEqual(resolvePort({ DEBUGMCP_PORT: '' }, 4000), 4000);
        assert.strictEqual(resolvePort({ DEBUGMCP_PORT: 'abc' }, 4000), 4000);
        assert.strictEqual(resolvePort({ DEBUGMCP_PORT: 'NaN' }, 4000), 4000);
    });

    test('accepts env var "0" as valid (ephemeral)', () => {
        assert.strictEqual(resolvePort({ DEBUGMCP_PORT: '0' }, 3001), 0);
    });
});
