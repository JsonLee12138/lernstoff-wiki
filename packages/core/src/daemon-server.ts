import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  type LernstoffConfig,
  getConfigPath,
  loadConfig,
  saveConfig,
  LERNSTOFF_DIR,
} from "./config.js";
import { QmdBridge } from "./qmd-bridge.js";
import { VaultWatcher } from "./vault-watcher.js";
import { VaultOps } from "./vault-ops.js";
import { HippocampalPipeline } from "./hippocampal-pipeline.js";
import { createLernstoffMcpServer } from "./mcp-server.js";

export interface DaemonServerOptions {
  vaultPath: string;
  config?: LernstoffConfig;
  qmdBridge?: QmdBridge;
  watcher?: VaultWatcher;
  vaultOps?: VaultOps;
  pipeline?: HippocampalPipeline;
}

export class DaemonServer {
  public vaultPath: string;
  public config: LernstoffConfig;
  public port = 8188;
  public requestedPort = 8188;
  public qmdBridge: QmdBridge;
  public watcher: VaultWatcher;
  public vaultOps: VaultOps;
  public pipeline: HippocampalPipeline;

  private server: HttpServer | null = null;
  private sseClients: Set<ServerResponse> = new Set();
  private mcpHandler: any;
  private isClosing = false;

  constructor(options: DaemonServerOptions) {
    this.vaultPath = resolve(options.vaultPath);
    this.config = options.config || loadConfig(this.vaultPath);
    this.qmdBridge =
      options.qmdBridge || new QmdBridge({ vaultPath: this.vaultPath, config: this.config });
    this.watcher =
      options.watcher ||
      new VaultWatcher(this.vaultPath, this.config, {
        onWikiChanged: async (rel) => {
          try {
            await this.qmdBridge.update();
            this.broadcast("status_updated", { path: rel, event: "wiki_changed" });
          } catch {
            // ignore
          }
        },
        onInquiriesChanged: () => {
          this.broadcast("inquiries_changed", { timestamp: Date.now() });
        },
      });
    this.vaultOps =
      options.vaultOps || new VaultOps(this.vaultPath, this.qmdBridge, this.watcher, this.config);
    this.pipeline =
      options.pipeline || new HippocampalPipeline(this.vaultPath, this.qmdBridge, this.config);

    // Initialize MCP HTTP handler
    this.mcpHandler = createMcpHandler(() =>
      createLernstoffMcpServer({
        vaultPath: this.vaultPath,
        config: this.config,
        qmdBridge: this.qmdBridge,
        vaultOps: this.vaultOps,
        pipeline: this.pipeline,
        watcher: this.watcher,
      }),
    );
  }

  /**
   * Start HTTP and SSE Daemon, binding to configured port with auto-increment on external conflict.
   * If occupied by an existing daemon for the same vault, prevents duplicate instance and throws.
   */
  public async start(): Promise<number> {
    const desiredPort = this.config.server.port;
    this.requestedPort = desiredPort;
    const maxPort = desiredPort + 100;

    for (let p = desiredPort; p <= maxPort; p++) {
      try {
        await this.bindPort(p);
        this.port = p;
        break;
      } catch (err: any) {
        if (err.code === "EADDRINUSE") {
          const isSameVault = await this.isSameVaultRunningOnPort(p);
          if (isSameVault) {
            throw new Error(
              `Lernstoff daemon for vault "${this.vaultPath}" is already running on port ${p}. Preventing duplicate instance.`,
            );
          }
          if (p < maxPort) {
            continue;
          }
        }
        throw err;
      }
    }

    const lernstoffDir = join(this.vaultPath, LERNSTOFF_DIR);
    mkdirSync(lernstoffDir, { recursive: true });

    const configPath = getConfigPath(this.vaultPath);
    const persistedPortDiffers =
      existsSync(configPath) && loadConfig(this.vaultPath).server.port !== this.port;
    if (this.port !== desiredPort || persistedPortDiffers) {
      saveConfig(this.vaultPath, {
        server: { ...this.config.server, port: this.port },
      });
      this.config.server.port = this.port;
    }

    writeFileSync(join(lernstoffDir, "daemon.port"), String(this.port), "utf-8");
    writeFileSync(join(lernstoffDir, "daemon.pid"), String(process.pid), "utf-8");

    this.watcher.start();
    // Warm up QMD index in background
    this.qmdBridge.update().catch(() => {});
    return this.port;
  }

  private async isSameVaultRunningOnPort(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data && data.status === "ok" && data.vault) {
          return resolve(String(data.vault)) === resolve(this.vaultPath);
        }
      }
    } catch {
      // not reachable or not a Lernstoff health endpoint
    } finally {
      clearTimeout(timeout);
    }
    return false;
  }

  public updateConfig(newConfig: LernstoffConfig): void {
    this.config = newConfig;
    this.pipeline.updateConfig(newConfig);
    this.vaultOps.updateConfig(newConfig);
    this.qmdBridge.updateConfig(newConfig);
    this.watcher.updateConfig(newConfig);
  }

  private bindPort(port: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const s = createServer((req, res) => this.handleRequest(req, res));

      s.once("error", (err) => {
        s.close();
        reject(err);
      });

      s.listen(port, "127.0.0.1", () => {
        this.server = s;
        resolvePromise();
      });
    });
  }

  /**
   * Graceful shutdown: unlinks pid/port files, stops watcher, closes SSE connections and HTTP server.
   */
  public async stop(): Promise<void> {
    if (this.isClosing) return;
    this.isClosing = true;

    const lernstoffDir = join(this.vaultPath, LERNSTOFF_DIR);
    try {
      const portFile = join(lernstoffDir, "daemon.port");
      if (existsSync(portFile)) unlinkSync(portFile);
    } catch {}

    try {
      const pidFile = join(lernstoffDir, "daemon.pid");
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch {}

    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {}
    }
    this.sseClients.clear();

    this.watcher.stop();
    await this.qmdBridge.close();

    if (this.server) {
      await new Promise<void>((resolveClose) => {
        this.server?.close(() => resolveClose());
      });
      this.server = null;
    }
  }

  /**
   * Broadcast real-time SSE events to connected Obsidian clients or external tools.
   */
  public broadcast(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;

    // CORS headers for local connections
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // 1. Health check
    if (pathname === "/health" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: process.uptime(),
          port: this.port,
          requestedPort: this.requestedPort,
          pid: process.pid,
          vault: this.vaultPath,
          version: this.config.version,
        }),
      );
      return;
    }

    // 2. Server-Sent Events (SSE)
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      res.write(
        `event: connected\ndata: ${JSON.stringify({ port: this.port, pid: process.pid })}\n\n`,
      );

      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // 3. REST endpoints (/api/*)
    if (pathname.startsWith("/api/")) {
      await this.handleApiRequest(pathname, req, res);
      return;
    }

    // 4. Streamable HTTP MCP (POST /mcp or subroutes)
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      await this.handleMcpRequest(req, res);
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not Found", pathname }));
  }

  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = `http://127.0.0.1:${this.port}${req.url}`;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body = ["GET", "HEAD"].includes(req.method || "") ? undefined : Buffer.concat(chunks);

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers[key] = Array.isArray(value) ? value.join(", ") : value;
        }
      }

      const webReq = new Request(url, {
        method: req.method,
        headers,
        body,
      });

      const webRes = await this.mcpHandler.fetch(webReq);

      res.statusCode = webRes.status;
      webRes.headers.forEach((val: string, key: string) => {
        res.setHeader(key, val);
      });

      if (webRes.body) {
        const reader = webRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err: any) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleApiRequest(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readJsonBody(req);

      if (pathname === "/api/reload-config" && req.method === "POST") {
        this.config = loadConfig(this.vaultPath);
        this.updateConfig(this.config);
        this.broadcast("config_reloaded", this.config);
        this.jsonResponse(res, 200, { success: true, config: this.config });
        return;
      }

      if (pathname === "/api/index-maint" && req.method === "POST") {
        const action = body.action || "update";
        if (action === "update") {
          await this.qmdBridge.update();
        } else if (action === "embed") {
          await this.qmdBridge.embed();
        } else if (action === "cleanup") {
          await this.vaultOps.consolidateScratchpad({ action: "gc" });
        }
        this.broadcast("status_updated", { action });
        this.jsonResponse(res, 200, { success: true, action });
        return;
      }

      if (pathname === "/api/status" && req.method === "GET") {
        let qmdStatus: any = { status: "unknown" };
        try {
          qmdStatus = await this.qmdBridge.getStatus();
        } catch {
          qmdStatus = { status: "offline" };
        }

        const conceptsDir = join(this.vaultPath, this.config.paths.conceptsDir);
        const conceptCount = existsSync(conceptsDir)
          ? readdirSync(conceptsDir).filter((f) => f.endsWith(".md")).length
          : 0;

        const inquiries = await this.vaultOps.manageInquiries({ action: "list" });
        const scratchpad = await this.vaultOps.consolidateScratchpad({ action: "inspect" });

        let noiseFilteredRatio = 0;
        const logFile = join(this.vaultPath, this.config.paths.logFile);
        if (existsSync(logFile)) {
          try {
            const logText = readFileSync(logFile, "utf-8");
            const matches = [...logText.matchAll(/noise_filtered_ratio:?\s*([0-9.]+)/g)];
            if (matches.length > 0) {
              const lastVal = parseFloat(matches[matches.length - 1]![1]!);
              if (!isNaN(lastVal)) noiseFilteredRatio = lastVal;
            }
          } catch {}
        }

        this.jsonResponse(res, 200, {
          version: this.config.version,
          port: this.port,
          pid: process.pid,
          qmd: qmdStatus,
          metrics: {
            conceptNotes: conceptCount,
            totalInquiries: inquiries.length,
            openInquiries: inquiries.filter((i: any) => i.status === "OPEN").length,
            scratchpadTotal: scratchpad.activeCount,
            scratchpadPromotionsReady: scratchpad.promotions.length,
            noiseFilteredRatio,
          },
          config: this.config,
        });
        return;
      }

      if (pathname === "/api/probe-delta" && req.method === "POST") {
        const result = await this.pipeline.probeDelta(body);
        if (result.stats.deferredScratchpad > 0) {
          this.broadcast("scratchpad_updated", { count: result.stats.deferredScratchpad });
        }
        this.jsonResponse(res, 200, result);
        return;
      }

      if (pathname === "/api/crystallize" && req.method === "POST") {
        const result = await this.vaultOps.crystallizeNote(body);
        this.broadcast("note_crystallized", result);
        this.jsonResponse(res, 200, result);
        return;
      }

      if (pathname === "/api/inquiries" && req.method === "POST") {
        const result = await this.vaultOps.manageInquiries(body);
        this.broadcast("inquiries_changed", result);
        this.jsonResponse(res, 200, result);
        return;
      }

      if (pathname === "/api/scratchpad" && req.method === "POST") {
        const result = await this.vaultOps.consolidateScratchpad(body);
        this.jsonResponse(res, 200, result);
        return;
      }

      if (pathname === "/api/lint" && req.method === "POST") {
        const result = await this.vaultOps.lintWiki(body);
        this.jsonResponse(res, 200, result);
        return;
      }

      if (pathname === "/api/search" && req.method === "POST") {
        const result = await this.qmdBridge.search(body);
        this.jsonResponse(res, 200, result);
        return;
      }

      this.jsonResponse(res, 404, { error: `Endpoint ${pathname} not found` });
    } catch (err: any) {
      this.jsonResponse(res, 500, { error: err.message });
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<any> {
    if (req.method === "GET" || req.method === "HEAD") return {};
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const text = Buffer.concat(chunks).toString("utf-8");
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  private jsonResponse(res: ServerResponse, status: number, data: any): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  }
}
