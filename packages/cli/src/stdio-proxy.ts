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
        if (contentType.includes("json")) {
          const bodyText = await res.text();
          if (bodyText) {
            process.stdout.write(`${bodyText}\n`);
          }
        } else {
          // Streamable response
          const reader = res.body?.getReader();
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              process.stdout.write(value);
            }
          }
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
