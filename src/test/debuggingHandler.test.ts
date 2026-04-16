// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { DebugState } from '../debugState';
import { DebuggingHandler } from '../debuggingHandler';

/**
 * Test suite for DebuggingHandler state change detection
 */
suite('DebuggingHandler State Change Detection', () => {
    
    test('hasStateChanged should detect line number changes', () => {
        const handler = new DebuggingHandler({} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        beforeState.updateContext(1, 1);
        beforeState.updateFrameName('main');
        
        const afterState = beforeState.clone();
        afterState.updateLocation('/test/file.js', 'file.js', 11, 'let y = 10;', []);
        
        // Use reflection to access the private method for testing
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should detect file changes', () => {
        const handler = new DebuggingHandler({} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file1.js', 'file1.js', 10, 'let x = 5;', []);
        beforeState.updateContext(1, 1);
        
        const afterState = beforeState.clone();
        afterState.updateLocation('/test/file2.js', 'file2.js', 10, 'let x = 5;', []);
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should detect session status changes', () => {
        const handler = new DebuggingHandler({} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        
        const afterState = beforeState.clone();
        afterState.sessionActive = false;
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should detect frame name changes', () => {
        const handler = new DebuggingHandler({} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        beforeState.updateFrameName('main');
        
        const afterState = beforeState.clone();
        afterState.updateFrameName('helper');
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should return false for identical states', () => {
        const handler = new DebuggingHandler({} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        beforeState.updateContext(1, 1);
        beforeState.updateFrameName('main');
        
        const afterState = beforeState.clone();
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, false);
    });
    
    test('hasStateChanged should handle states without location info', () => {
        const handler = new DebuggingHandler({} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        // No location info
        
        const afterState = new DebugState();
        afterState.sessionActive = true;
        afterState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
});
