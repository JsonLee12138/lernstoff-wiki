import { createInterface } from "node:readline";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLernstoffMcpServer } from "@lernstoff/core";
import { getRunningDaemonInfo } from "./daemon-pid.js";

/**
 * Runs MCP over stdio.
 * If the Vault's background daemon is already running, proxies JSON-RPC over HTTP
 * with zero memory footprint; otherwise boots an in-process MCP server instance.
 */
export async function runMcpStdio(vaultPath: string): Promise<void> {
  const daemonInfo = getRunningDaemonInfo(vaultPath);

  if (daemonInfo) {
    // Mode A: Stdio-to-HTTP Proxy (0 Memory Overhead)
    const daemonUrl = `http://127.0.0.1:${daemonInfo.port}/mcp`;

    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const res = await fetch(daemonUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: trimmed,
        });

        const contentType = res.headers.get("content-type") || "";
        const bodyText = await res.text();

        if (contentType.includes("text/event-stream") || bodyText.includes("data:")) {
          // Unwrap Server-Sent Events (SSE) data lines to yield pure JSON-RPC onto stdout
          const lines = bodyText.split("\n");
          for (const rawLine of lines) {
            const trimmedLine = rawLine.trim();
            if (trimmedLine.startsWith("data:")) {
              const dataContent = trimmedLine.slice(5).trim();
              if (dataContent && dataContent !== "[DONE]") {
                process.stdout.write(`${dataContent}\n`);
              }
            }
          }
        } else if (bodyText.trim()) {
          process.stdout.write(`${bodyText.trim()}\n`);
        }
      } catch (err: any) {
        const errorRpc = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: `Daemon proxy error: ${err.message}`,
          },
        };
        process.stdout.write(`${JSON.stringify(errorRpc)}\n`);
      }
    });

    return;
  }

  // Mode B: Direct in-process Stdio MCP Server
  const server = createLernstoffMcpServer({ vaultPath });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
