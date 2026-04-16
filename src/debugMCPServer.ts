// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import {
    DebuggingExecutor,
    DebuggingHandler,
    IDebuggingHandler
} from '.';
import { logger } from './utils/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Distinctive stderr token emitted when the HTTP server fails to bind with EADDRINUSE.
 * Headless wrappers can scrape VS Code server stderr for this to fail fast instead of
 * waiting for a full readiness timeout.
 *
 * The `log` parameter is injectable for testing (extension-host environments shadow
 * global console); production callers pass no argument and get the default stderr path.
 */
export function logBindFailure(
    port: number,
    err: NodeJS.ErrnoException,
    log: (msg: string) => void = (msg) => process.stderr.write(msg + '\n')
): void {
    if (err.code === 'EADDRINUSE') {
        log(`DEBUGMCP_BIND_FAILED port=${port}`);
    }
}

/**
 * Main MCP server class that exposes debugging functionality as tools and resources.
 * Uses the official @modelcontextprotocol/sdk with SSE transport over express.
 */
export class DebugMCPServer {
    private mcpServer: McpServer | null = null;
    private httpServer: http.Server | null = null;
    private port: number;
    private initialized: boolean = false;
    private debuggingHandler: IDebuggingHandler;
    private transports: Map<string, StreamableHTTPServerTransport> = new Map();

    constructor(port: number, timeoutInSeconds: number) {
        // Initialize the debugging components with dependency injection
        const executor = new DebuggingExecutor();
        this.debuggingHandler = new DebuggingHandler(executor, timeoutInSeconds);
        this.port = port;
    }

    /**
     * Initialize the MCP server
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        this.mcpServer = new McpServer({
            name: 'debugmcp',
            version: '1.0.0',
        });

        this.setupTools();
        this.setupResources();
        this.initialized = true;
    }

    /**
     * Setup MCP tools that delegate to the debugging handler
     */
    private setupTools() {
        // Get debug instructions tool (for clients that don't support MCP resources like GitHub Copilot)
        this.mcpServer!.registerTool('get_debug_instructions', {
            description: 'Get the debugging guide with step-by-step instructions for effective debugging. ' +
                'Returns comprehensive guidance including breakpoint strategies, root cause analysis framework, ' +
                'and best practices. Call this before starting a debug session.',
        }, async () => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return { content: [{ type: 'text' as const, text: content }] };
        });

        // Start debugging tool
        this.mcpServer!.registerTool('start_debugging', {
            description:
                'IMPORTANT DEBUGGING TOOL - Launch a C++ binary under the cppvsdbg debugger.\n\n' +
                'USE THIS WHEN:\n' +
                '• You need to launch a Windows C++ executable for debugging\n' +
                '• Any bug, error, or unexpected behavior occurs in a C++ program\n\n' +
                'The tool builds a launch configuration from the fields below. No launch.json ' +
                'is read or written. `type` is always "cppvsdbg" and `request` is always "launch".\n\n' +
                '⚠️ Before first use in a project, read resource debugmcp://docs/debug_instructions.',
            inputSchema: {
                program: z.string().describe(
                    "Absolute path to the .exe to launch, or a path using ${workspaceFolder}. " +
                    "Examples: 'C:/repo/build/app.exe', '${workspaceFolder}/bin/x64/app_d.exe'. Required."
                ),
                args: z.array(z.string()).optional().describe(
                    "Arguments passed to the program. Each element is one argv token (no shell splitting). " +
                    "Defaults to []."
                ),
                cwd: z.string().optional().describe(
                    "Working directory for the program. Supports ${workspaceFolder}. " +
                    "Defaults to the workspace root."
                ),
                environment: z.array(z.object({
                    name: z.string(),
                    value: z.string(),
                })).optional().describe(
                    "Environment variables as {name, value} pairs. Values support ${workspaceFolder} " +
                    "and ${env:VAR}. Defaults to []."
                ),
                console: z.enum([
                    "integratedTerminal", "internalConsole", "externalTerminal", "newExternalWindow",
                ]).optional().describe(
                    "Where the program's stdout/stdin go. Defaults to 'integratedTerminal'."
                ),
                stopAtEntry: z.boolean().optional().describe(
                    "If true, break on program entry (main). Defaults to false."
                ),
                extraConfig: z.record(z.unknown()).optional().describe(
                    "Escape hatch: additional cppvsdbg fields merged into the final DebugConfiguration. " +
                    "Use for rarely-needed fields like sourceFileMap, symbolSearchPath, visualizerFile, " +
                    "enableDebugHeap, logging. Values here override defaults but NOT the explicit fields " +
                    "above. Hardcoded type/request/name cannot be overridden."
                ),
                waitForBreakpointSeconds: z.number().int().positive().optional().describe(
                    "How long to wait for a breakpoint (or entry) to be hit before returning the " +
                    "'attached-but-running' success result. Defaults to 30."
                ),
            },
        }, async (args) => {
            const result = await this.debuggingHandler.handleStartDebugging(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Stop debugging tool
        this.mcpServer!.registerTool('stop_debugging', {
            description: 'Stop the current debug session',
        }, async () => {
            const result = await this.debuggingHandler.handleStopDebugging();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step over tool
        this.mcpServer!.registerTool('step_over', {
            description: 'Execute the current line of code without diving into it.',
        }, async () => {
            const result = await this.debuggingHandler.handleStepOver();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step into tool
        this.mcpServer!.registerTool('step_into', {
            description: 'Dive into the current line of code.',
        }, async () => {
            const result = await this.debuggingHandler.handleStepInto();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step out tool
        this.mcpServer!.registerTool('step_out', {
            description: 'Step out of the current function',
        }, async () => {
            const result = await this.debuggingHandler.handleStepOut();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Continue execution tool
        this.mcpServer!.registerTool('continue_execution', {
            description: 'Resume program execution until the next breakpoint is hit or the program completes.',
        }, async () => {
            const result = await this.debuggingHandler.handleContinue();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Restart debugging tool
        this.mcpServer!.registerTool('restart_debugging', {
            description: 'Restart the debug session from the beginning with the same configuration.',
        }, async () => {
            const result = await this.debuggingHandler.handleRestart();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Add breakpoint tool
        this.mcpServer!.registerTool('add_breakpoint', {
            description: 'Set a breakpoint to pause execution at a critical line of code. Essential for debugging: pause before potential errors, examine state at decision points, or verify code paths. Breakpoints let you inspect variables and control flow at exact moments.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                lineContent: z.string().describe('Line content'),
            },
        }, async (args: { fileFullPath: string; lineContent: string }) => {
            const result = await this.debuggingHandler.handleAddBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Remove breakpoint tool
        this.mcpServer!.registerTool('remove_breakpoint', {
            description: 'Remove a breakpoint that is no longer needed.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().describe('Line number (1-based)'),
            },
        }, async (args: { fileFullPath: string; line: number }) => {
            const result = await this.debuggingHandler.handleRemoveBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Clear all breakpoints tool
        this.mcpServer!.registerTool('clear_all_breakpoints', {
            description: 'Clear all breakpoints at once. Use this after verifying the root cause to clean up before moving on to the next task.',
        }, async () => {
            const result = await this.debuggingHandler.handleClearAllBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // List breakpoints tool
        this.mcpServer!.registerTool('list_breakpoints', {
            description: 'View all currently set breakpoints across all files.',
        }, async () => {
            const result = await this.debuggingHandler.handleListBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get variables tool
        this.mcpServer!.registerTool('get_variables_values', {
            description: 'Inspect all variable values at the current execution point. This is your window into program state - see what data looks like at runtime, verify assumptions, identify unexpected values, and understand why code behaves as it does.',
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
            },
        }, async (args: { scope?: 'local' | 'global' | 'all' }) => {
            const result = await this.debuggingHandler.handleGetVariables(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Evaluate expression tool
        this.mcpServer!.registerTool('evaluate_expression', {
            description: 'Powerful runtime expression evaluator: Test hypotheses, check computed values, call methods, or inspect object properties in the live debug context. Goes beyond simple variable inspection - evaluate any valid expression in the target language.',
            inputSchema: {
                expression: z.string().describe('Expression to evaluate in the current programming language context'),
            },
        }, async (args: { expression: string }) => {
            const result = await this.debuggingHandler.handleEvaluateExpression(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });
    }

    /**
     * Setup MCP resources for documentation
     */
    private setupResources() {
        // Add MCP resources for debugging documentation
        this.mcpServer!.registerResource('Debugging Instructions Guide', 'debugmcp://docs/debug_instructions', {
            description: 'Step-by-step instructions for debugging with DebugMCP',
            mimeType: 'text/markdown',
        }, async (uri: URL) => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text: content,
                }]
            };
        });

        // Add language-specific resources
        const languages = ['python', 'javascript', 'java', 'csharp'];
        const languageTitles: Record<string, string> = {
            'python': 'Python Debugging Tips',
            'javascript': 'JavaScript Debugging Tips',
            'java': 'Java Debugging Tips',
            'csharp': 'C# Debugging Tips'
        };

        languages.forEach(language => {
            this.mcpServer!.registerResource(
                languageTitles[language],
                `debugmcp://docs/troubleshooting/${language}`,
                {
                    description: `Debugging tips specific to ${language}`,
                    mimeType: 'text/markdown',
                },
                async (uri: URL) => {
                    const content = await this.loadMarkdownFile(`agent-resources/troubleshooting/${language}.md`);
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'text/markdown',
                            text: content,
                        }]
                    };
                }
            );
        });
    }

    /**
     * Load content from a Markdown file in the docs directory
     */
    private async loadMarkdownFile(relativePath: string): Promise<string> {
        try {
            // Get the extension's installation directory
            const extensionPath = __dirname; // This points to the compiled extension's directory
            const docsPath = path.join(extensionPath, '..', 'docs', relativePath);

            console.log(`Loading markdown file from: ${docsPath}`);

            // Read the file content
            const content = await fs.promises.readFile(docsPath, 'utf8');
            console.log(`Successfully loaded ${relativePath}, content length: ${content.length}`);

            return content;
        } catch (error) {
            console.error(`Failed to load ${relativePath}:`, error);
            return `Error loading documentation from ${relativePath}: ${error}`;
        }
    }

    /**
     * Check if the server is already running
     */
    private async isServerRunning(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const request = http.request({
                hostname: 'localhost',
                port: this.port,
                path: '/',
                method: 'GET',
                timeout: 1000
            }, () => {
                resolve(true); // Server is responding
            });

            request.on('error', () => {
                resolve(false); // Server is not running
            });

            request.on('timeout', () => {
                request.destroy();
                resolve(false); // Server is not responding
            });

            request.end();
        });
    }

    /**
     * Start the MCP server with SSE transport over HTTP
     */
    async start(): Promise<void> {
        // First check if server is already running
        const isRunning = await this.isServerRunning();
        if (isRunning) {
            logger.info(`DebugMCP server is already running on port ${this.port}`);
            return;
        }

        try {
            logger.info(`Starting DebugMCP server on port ${this.port}...`);

            // Dynamically import express (ES module)
            const expressModule = await import('express');
            const express = expressModule.default;
            const app = express();

            // Parse JSON body for incoming requests
            app.use(express.json());

            // Streamable HTTP endpoint — handles MCP protocol messages
            app.post('/mcp', async (req: any, res: any) => {
                logger.info('New MCP request received');
                
                // Create a new transport for each request (stateless mode)
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined, // Stateless mode - no session management
                });

                // Clean up transport when response closes
                res.on('close', () => {
                    transport.close();
                    logger.info('MCP transport closed');
                });

                // Connect the MCP server to this transport
                await this.mcpServer!.connect(transport);
                
                // Handle the incoming request
                await transport.handleRequest(req, res, req.body);
            });

            // Legacy SSE endpoint for backward compatibility
            // Redirects to the new /mcp endpoint with appropriate headers
            app.get('/sse', async (req: any, res: any) => {
                res.status(410).json({ 
                    error: 'SSE endpoint deprecated', 
                    message: 'Please use POST /mcp endpoint instead',
                    newEndpoint: '/mcp'
                });
            });

            // Start HTTP server
            await new Promise<void>((resolve, reject) => {
                this.httpServer = app.listen(this.port, () => {
                    resolve();
                });
                this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
                    logBindFailure(this.port, err);
                    reject(err);
                });
            });

            logger.info(`DebugMCP server started successfully on port ${this.port}`);

        } catch (error) {
            logger.error(`Failed to start DebugMCP server`, error);
            throw new Error(`Failed to start DebugMCP server: ${error}`);
        }
    }

    /**
     * Stop the MCP server
     */
    async stop() {
        // Note: With stateless StreamableHTTPServerTransport, transports are closed per-request
        // No need to track and close them manually
        this.transports.clear();

        // Close the HTTP server
        if (this.httpServer) {
            await new Promise<void>((resolve) => {
                this.httpServer!.close(() => resolve());
            });
            this.httpServer = null;
        }

        logger.info('DebugMCP server stopped');
    }

    /**
     * Get the server endpoint
     */
    getEndpoint(): string {
        return `http://localhost:${this.port}`;
    }

    /**
     * Get the debugging handler (for testing purposes)
     */
    getDebuggingHandler(): IDebuggingHandler {
        return this.debuggingHandler;
    }

    /**
     * Check if the server is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}