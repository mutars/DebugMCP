// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugMCPServer } from './debugMCPServer';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { logger, LogLevel } from './utils/logger';
import { resolvePort } from './utils/portResolver';
import { OutputRingBuffer } from './utils/outputRingBuffer';
import { registerOutputTracker, OUTPUT_BUFFER_CAPACITY } from './utils/debugOutputTracker';

let mcpServer: DebugMCPServer | null = null;
let agentConfigManager: AgentConfigurationManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logging first
    logger.info('DebugMCP extension is now active!');
    logger.logSystemInfo();
    logger.logEnvironment();

    const config = vscode.workspace.getConfiguration('debugmcp');
    const timeoutInSeconds = config.get<number>('timeoutInSeconds', 180);
    const configuredPort = config.get<number>('serverPort', 3001);
    const serverPort = resolvePort(process.env, configuredPort);
    const headless = config.get<boolean>('headless', false);

    logger.info(`Using timeoutInSeconds: ${timeoutInSeconds} seconds`);
    logger.info(`Using serverPort: ${serverPort}`);
    if (headless) {
        logger.info('DebugMCP running in headless mode: UX prompts suppressed');
    }

    // Initialize Agent Configuration Manager
    agentConfigManager = new AgentConfigurationManager(context, timeoutInSeconds, serverPort, headless);

    const outputBuffer = new OutputRingBuffer(OUTPUT_BUFFER_CAPACITY);
    registerOutputTracker(context, outputBuffer);

    // Migrate existing SSE configurations to streamableHttp (for backward compatibility)
    if (!headless) {
        try {
            await agentConfigManager.migrateExistingConfigurations();
        } catch (error) {
            logger.error('Error migrating existing configurations', error);
        }
    }

    // Initialize MCP Server
    try {
        logger.info('Starting MCP server initialization...');

        mcpServer = new DebugMCPServer(serverPort, timeoutInSeconds, outputBuffer);
        await mcpServer.initialize();
        await mcpServer.start();

        const endpoint = mcpServer.getEndpoint();
        logger.info(`DebugMCP server running at: ${endpoint}`);
        if (!headless) {
            vscode.window.showInformationMessage(`DebugMCP server running on ${endpoint}`);
        }
    } catch (error) {
        logger.error('Failed to initialize MCP server', error);
        if (!headless) {
            vscode.window.showErrorMessage(`Failed to initialize MCP server: ${error}`);
        }
    }

    // Register commands
    registerCommands(context);

    // Show post-install popup if needed (with slight delay to allow VS Code to fully load)
    if (!headless) {
        setTimeout(async () => {
            try {
                if (agentConfigManager && await agentConfigManager.shouldShowPopup()) {
                    await agentConfigManager.showAgentSelectionPopup();
                }
            } catch (error) {
                logger.error('Error showing post-install popup', error);
            }
        }, 2000);
    }

    logger.info('DebugMCP extension activated successfully');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Command to manually configure DebugMCP for agents
    const configureAgentsCommand = vscode.commands.registerCommand(
        'debugmcp.configureAgents',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showManualConfiguration();
            }
        }
    );

    // Command to show agent selection popup again
    const showPopupCommand = vscode.commands.registerCommand(
        'debugmcp.showAgentSelectionPopup',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        }
    );

    // Command to reset popup state (for development/testing)
    const resetPopupCommand = vscode.commands.registerCommand(
        'debugmcp.resetPopupState',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.resetPopupState();
                vscode.window.showInformationMessage('DebugMCP popup state has been reset.');
            }
        }
    );

    context.subscriptions.push(
        configureAgentsCommand,
        showPopupCommand,
        resetPopupCommand
        );
}

export async function deactivate() {
    logger.info('DebugMCP extension deactivating...');
    
    // Clean up MCP server
    if (mcpServer) {
        mcpServer.stop().catch(error => {
            logger.error('Error stopping MCP server', error);
        });
        mcpServer = null;
    }
    
    logger.info('DebugMCP extension deactivated');
}
