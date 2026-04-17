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
import { HandlerResponse } from './debuggingHandler';
import { OutputRingBuffer } from './utils/outputRingBuffer';
import { logger } from './utils/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Emits a distinctive stderr token on EADDRINUSE so wrappers can fail fast instead of
// waiting for a readiness timeout. Writes to stderr directly because the extension host
// shadows global console; `log` is injectable for tests.
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

    constructor(port: number, timeoutInSeconds: number, outputBuffer?: OutputRingBuffer) {
        const executor = new DebuggingExecutor();
        if (outputBuffer) executor.setOutputBuffer(outputBuffer);
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
    private wrapResponse(r: HandlerResponse) {
        return {
            content: [{ type: 'text' as const, text: r.text }],
            structuredContent: r.structuredContent as Record<string, unknown>,
            ...(r.isError ? { isError: true } : {}),
        };
    }

    private delegate<A>(fn: (a: A) => Promise<HandlerResponse>): (a: A) => Promise<ReturnType<DebugMCPServer['wrapResponse']>> {
        return async (a: A) => this.wrapResponse(await fn(a));
    }

    private setupTools() {
        this.mcpServer!.registerTool('get_debug_instructions', {
            description: 'Return the DebugMCP debugging guide: breakpoint strategies, root-cause framework, best practices.',
        }, async () => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return { content: [{ type: 'text' as const, text: content }] };
        });

        this.mcpServer!.registerTool('start_debugging', {
            description:
                'Launch a C++ executable under the cppvsdbg debugger. Builds a launch config from the fields below (no launch.json is read). `type` is always `cppvsdbg`, `request` always `launch`.',
            inputSchema: {
                program: z.string().describe(
                    "Absolute path to the .exe, or a path using ${workspaceFolder}. Required."
                ),
                args: z.array(z.string()).optional().describe(
                    "Program arguments, one argv token per array element (no shell splitting)."
                ),
                cwd: z.string().optional().describe(
                    "Working directory for the program. ${workspaceFolder} is supported. Defaults to the workspace root."
                ),
                environment: z.record(z.string()).optional().describe(
                    "Environment variables as a record, e.g. { \"VAR\": \"value\" }. " +
                    "Values support ${workspaceFolder} and ${env:VAR}."
                ),
                console: z.enum([
                    "integratedTerminal", "internalConsole", "externalTerminal", "newExternalWindow",
                ]).optional().describe(
                    "Destination for the program's stdout/stdin. Defaults to 'internalConsole'."
                ),
                stopAtEntry: z.boolean().optional().describe(
                    "If true, break on program entry (main)."
                ),
                extraConfig: z.record(z.unknown()).optional().describe(
                    "Additional cppvsdbg fields merged into the launch config. Use for sourceFileMap, symbolSearchPath, etc. Cannot override type, request, or name."
                ),
                waitForBreakpointSeconds: z.number().int().positive().optional().describe(
                    "Max seconds to wait for a breakpoint or entry-stop before returning the attached-but-running result. Defaults to 30."
                ),
            },
        }, this.delegate((args: any) => this.debuggingHandler.handleStartDebugging(args)));

        this.mcpServer!.registerTool('stop_debugging', {
            description: 'End the active debug session.',
        }, this.delegate(() => this.debuggingHandler.handleStopDebugging()));

        this.mcpServer!.registerTool('step_over', {
            description: 'Step over the current line; do not enter called functions. Requires a paused session (otherwise `isError` with `reason="no_session"` or `"not_paused"`).',
        }, this.delegate(() => this.debuggingHandler.handleStepOver()));

        this.mcpServer!.registerTool('step_into', {
            description: 'Step into the call on the current line; step over if none. Requires a paused session (otherwise `isError` with `reason="no_session"` or `"not_paused"`).',
        }, this.delegate(() => this.debuggingHandler.handleStepInto()));

        this.mcpServer!.registerTool('step_out', {
            description: 'Run until the current function returns, then pause in the caller. Requires a paused session (otherwise `isError` with `reason="no_session"` or `"not_paused"`). Note: step_out from `main` ends the session — the program exits.',
        }, this.delegate(() => this.debuggingHandler.handleStepOut()));

        this.mcpServer!.registerTool('continue_execution', {
            description: 'Resume execution until the next breakpoint or program exit. Requires a paused session (otherwise `isError` with `reason="no_session"` or `"not_paused"`).',
        }, this.delegate(() => this.debuggingHandler.handleContinue()));

        this.mcpServer!.registerTool('restart_debugging', {
            description: 'Restart the active debug session with the same configuration. Requires an active session (otherwise `isError` with `reason="no_session"`).',
        }, this.delegate(() => this.debuggingHandler.handleRestart()));

        this.mcpServer!.registerTool('add_breakpoint', {
            description: 'Set a breakpoint. Provide either `line` or `lineContent` (not both). If `lineContent` matches multiple lines, set `allowMultiple` to accept all matches. Failure returns `isError` with `reason` in `{bad_input, no_match, multi_match}`. Breakpoints persist across sessions.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the source file.'),
                line: z.number().int().positive().optional().describe('1-based line number.'),
                lineContent: z.string().optional().describe('Content substring used to locate the line.'),
                condition: z.string().optional().describe('DAP condition expression (e.g., "i > 5").'),
                hitCondition: z.string().optional().describe('Hit-count expression (e.g., ">= 5", "% 10").'),
                logMessage: z.string().optional().describe('Logpoint: print this message instead of pausing. Supports {expr} substitution per DAP.'),
                allowMultiple: z.boolean().optional().describe('If true and `lineContent` matches multiple lines, set breakpoints on every match. Default false.'),
            },
        }, this.delegate((args: any) => this.debuggingHandler.handleAddBreakpoint(args)));

        this.mcpServer!.registerTool('remove_breakpoint', {
            description: 'Remove a breakpoint. Provide either `line` or `lineContent` (not both). Failure returns `isError` with `reason` in `{bad_input, no_match}`.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the source file.'),
                line: z.number().int().positive().optional().describe('1-based line number.'),
                lineContent: z.string().optional().describe('Content substring used to locate the line.'),
            },
        }, this.delegate((args: any) => this.debuggingHandler.handleRemoveBreakpoint(args)));

        this.mcpServer!.registerTool('clear_all_breakpoints', {
            description: 'Clear every breakpoint in every file.',
        }, this.delegate(() => this.debuggingHandler.handleClearAllBreakpoints()));

        this.mcpServer!.registerTool('list_breakpoints', {
            description: 'List every active breakpoint with file and line.',
        }, this.delegate(() => this.debuggingHandler.handleListBreakpoints()));

        this.mcpServer!.registerTool('get_variables', {
            description: 'List variables in scope at the current stack frame. Requires a paused session (otherwise `isError` with `reason="no_session"` or `"not_paused"`).',
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("`local`, `global`, or `all`. Default `all`."),
            },
        }, this.delegate((args: any) => this.debuggingHandler.handleGetVariables(args)));

        this.mcpServer!.registerTool('get_debug_state', {
            description: 'Return the paused-state snapshot: file, line, frame, stack, active breakpoints. Requires a paused session (otherwise `isError` with `reason="no_session"` or `"not_paused"`).',
        }, this.delegate(() => this.debuggingHandler.handleGetDebugState()));

        this.mcpServer!.registerTool('get_program_output', {
            description: 'Read captured stdout/stderr from the program under debug. Buffer resets on each start_debugging.',
            inputSchema: {
                tail: z.number().int().positive().optional().describe(
                    "If set, return only the last N lines of captured output."
                ),
            },
        }, this.delegate((args: any) => this.debuggingHandler.handleGetProgramOutput(args)));

        this.mcpServer!.registerTool('evaluate_expression', {
            description: 'Evaluate a C++ expression in the current stack frame. Requires a paused session (otherwise `isError` with `reason="no_session"` or `"not_paused"`). An unevaluatable expression returns `reason="evaluate_failed"`.',
            inputSchema: {
                expression: z.string().describe('Expression to evaluate in the current frame.'),
            },
        }, this.delegate((args: any) => this.debuggingHandler.handleEvaluateExpression(args)));
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