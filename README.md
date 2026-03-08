# DebugMCP - Empowering AI Agents with Multi-Language Debugging Capabilities

A VSCode extension that provides comprehensive multi-language debugging capabilities and automatically exposes itself as an MCP (Model Context Protocol) server for seamless integration with AI assistants.

> **📢 Beta Version Notice**: This is a beta version of DebugMCP maintained by [ozzafar@microsoft.com](mailto:ozzafar@microsoft.com) and [orbarila@microsoft.com](mailto:orbarila@microsoft.com). We welcome feedback and contributions to help improve this extension.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104.0+-blue.svg)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-1.0.8-green.svg)](https://github.com/microsoft/DebugMCP)
[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-Install-blue.svg)](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)

## 🚀 Quick Install

**[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)** or use the direct link: `vscode:extension/ozzafar.debugmcpextension`

## Table of Contents
- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Supported Languages](#supported-languages)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

DebugMCP bridges the gap between professional debugging and AI-assisted development by providing a powerful debugging interface that AI assistants can use to help you identify and fix issues in your code. DebugMCP enables AI assistants to perform sophisticated debugging operations on your behalf.

## Features

### 🔧 Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| **get_debug_instructions** | Get the debugging guide with best practices and workflow instructions | None |
| **start_debugging** | Start a debug session for a source code file | `fileFullPath` (required)<br>`workingDirectory` (required)<br>`testName` (optional)<br>`configurationName` (optional) |
| **stop_debugging** | Stop the current debug session | None |
| **step_over** | Execute the next line (step over function calls) | None |
| **step_into** | Step into function calls | None |
| **step_out** | Step out of the current function | None |
| **continue_execution** | Continue until next breakpoint | None |
| **restart_debugging** | Restart the current debug session | None |
| **add_breakpoint** | Add a breakpoint at a specific line | `fileFullPath` (required)<br>`lineContent` (required) |
| **remove_breakpoint** | Remove a breakpoint from a specific line | `fileFullPath` (required)<br>`line` (required) |
| **clear_all_breakpoints** | Remove all breakpoints at once | None |
| **list_breakpoints** | List all active breakpoints | None |
| **get_variables_values** | Get variables and their values at current execution point | `scope` (optional: 'local', 'global', 'all') |
| **evaluate_expression** | Evaluate an expression in debug context | `expression` (required) |

> **Note:** The `get_debug_instructions` tool is particularly useful for AI clients like GitHub Copilot that don't support MCP resources. It provides the same debugging guide content that is also available as an MCP resource.

### 🎯 Debugging Best Practices

DebugMCP follows systematic debugging practices for effective issue resolution:

- **Start with Entry Points**: Begin debugging at function entry points or main execution paths
- **Follow the Execution Flow**: Use step-by-step execution to understand code flow
- **Root Cause Analysis**: Don't stop at symptoms - find the underlying cause

### 🛡️ Security & Reliability
- **Secure Communication**: All MCP communications use secure protocols
- **Local Operation**: The MCP server runs 100% locally with no external communications and requires no credentials
- **State Validation**: Robust validation of debugging states and operations

## Installation

### Quick Install Options

**Option 1: Direct Link** (Fastest)
- Click this link: [vscode:extension/ozzafar.debugmcpextension](vscode:extension/ozzafar.debugmcpextension)
- Or copy and paste in your browser: `vscode:extension/ozzafar.debugmcpextension`

**Option 2: VS Code Marketplace**
- Visit: [https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)
- Click "Install"

**Option 3: Within VS Code**
1. Open VSCode
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "DebugMCP"
4. Click Install
5. The extension automatically activates and registers as an MCP server

### Verification
After installation, you should see:
- DebugMCP extension in your installed extensions
- MCP server automatically running on port 3001 (configurable)
- Debug tools available to connected AI assistants

> **📝 Note**: No additional debugging rule instructions are needed - the extension works out of the box.

> **💡 Tip**: Enable auto-approval for all debugmcp tools in your AI assistant to create seamless debugging workflows without constant approval interruptions.

## Quick Start

1. **Install the extension** (see [Installation](#installation))
2. **Open your project** in VSCode
3. **Ask your AI to debug** - it can now set breakpoints, start debugging, and analyze your code!

## Supported Languages

DebugMCP supports debugging for the following languages with their respective VSCode extensions:

| Language | Extension Required | File Extensions | Status |
|----------|-------------------|-----------------|---------|
| **Python** | [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) | `.py` | ✅ Fully Supported |
| **JavaScript/TypeScript** | Built-in / [JS Debugger](https://marketplace.visualstudio.com/items?itemName=ms-vscode.js-debug) | `.js`, `.ts`, `.jsx`, `.tsx` | ✅ Fully Supported |
| **Java** | [Extension Pack for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-pack) | `.java` | ✅ Fully Supported |
| **C/C++** | [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) | `.c`, `.cpp`, `.cc` | ✅ Fully Supported |
| **Go** | [Go](https://marketplace.visualstudio.com/items?itemName=golang.Go) | `.go` | ✅ Fully Supported |
| **Rust** | [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) | `.rs` | ✅ Fully Supported |
| **PHP** | [PHP Debug](https://marketplace.visualstudio.com/items?itemName=xdebug.php-debug) | `.php` | ✅ Fully Supported |
| **Ruby** | [Ruby](https://marketplace.visualstudio.com/items?itemName=rebornix.ruby) | `.rb` | ✅ Fully Supported |
| **C#/.NET** | [C#](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) | `.cs` | ✅ Fully Supported |

## Configuration

### MCP Server Configuration (Recommended)

The extension runs an MCP server automatically. It will pop up a message to auto-register the MCP server in your AI assistant.

### Manual MCP Server Registration (Optional)

> **🔄 Auto-Migration**: If you previously configured DebugMCP with SSE transport, the extension will automatically migrate your configuration to the new Streamable HTTP transport on activation.

#### Cline
Add to your Cline settings or `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "debugmcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp",
      "description": "DebugMCP - AI-powered debugging assistant"
    }
  }
}
```

#### GitHub Copilot
Add to your VS Code settings (`settings.json`):
```json
{
  "mcp": {
    "servers": {
      "debugmcp": {
        "type": "http",
        "url": "http://localhost:3001/mcp",
        "description": "DebugMCP - Multi-language debugging support"
      }
    }
  }
}
```

#### Cursor
Add to Cursor's MCP settings:
```json
{
  "mcpServers": {
    "debugmcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp",
      "description": "DebugMCP - Debugging tools for AI assistants"
    }
  }
}
```

### Extension Settings

Configure DebugMCP behavior in VSCode settings:

```json
{
  "debugmcp.serverPort": 3001,
  "debugmcp.timeoutInSeconds": 180
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `debugmcp.serverPort` | `3001` | Port number for the MCP server |
| `debugmcp.timeoutInSeconds` | `180` | Timeout for debugging operations |


## Troubleshooting

### Common Issues

#### MCP Server Not Starting
- **Symptom**: AI assistant can't connect to DebugMCP
- **Solution**: 
  - Check if port 3001 is available
  - Restart VSCode
  - Verify extension is installed and activated

## How It Works

### Launch Configuration Integration
The extension handles debug configurations intelligently:

- **Existing launch.json**: If a `.vscode/launch.json` file exists, it will:
   - Search for a relevant configuration
   - Use a specific configuration if found

- **Default Configuration**: If no launch.json exists or no relevant config, it creates an appropriate default configurations for each language based on file extension detection


## Requirements

- VSCode with appropriate language extensions installed:
  - **Python**: [Python extension](vscode:extension/ms-python.debugpy) for `.py` files
  - **JavaScript/TypeScript**: Built-in Node.js debugger or [JavaScript Debugger extension](vscode:extension/ms-vscode.js-debug)
  - **Java**: [Extension Pack for Java](vscode:extension/vscjava.vscode-java-pack)
  - **C#/.NET**: [C# extension](vscode:extension/ms-dotnettools.csharp)
  - **C/C++**: [C/C++ extension](vscode:extension/ms-vscode.cpptools)
  - **Go**: [Go extension](vscode:extension/golang.go)
  - **Rust**: [rust-analyzer extension](vscode:extension/rust-lang.rust-analyzer)
  - **PHP**: [PHP Debug extension](vscode:extension/xdebug.php-debug)
  - **Ruby**: [Ruby extension](vscode:extension/rebornix.ruby) with debug support
- MCP-compatible AI assistant (Copilot, Cline, Roo..)

## Demo

<video width="800" controls>
  <source src="assets/DebugMCP.mp4" type="video/mp4">
  Your browser does not support the video tag. <a href="assets/DebugMCP.mp4">Download the demo video</a>
</video>

> Watch to see DebugMCP in action, showing the integration between the VSCode extension and an AI assistant using the MCP protocol.

## Development

To build the extension:

```bash
npm install
npm run compile
```

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Security

Security vulnerabilities should be reported following the guidance at [https://aka.ms/SECURITY.md](https://aka.ms/SECURITY.md).
Please do not report security vulnerabilities through public GitHub issues.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft 
trademarks or logos is subject to and must follow 
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.

## License

MIT License - See [LICENSE](LICENSE.txt) for details

This extension was created by **Oz Zafar**, **Ori Bar-Ilan** and **Karin Brisker**.
