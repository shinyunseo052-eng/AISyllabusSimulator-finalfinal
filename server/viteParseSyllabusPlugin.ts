import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { loadEnv } from "vite";
import { parseSyllabusWithGroq } from "./parseSyllabus";

const ROUTE = "/api/parse-syllabus";
const MAX_BODY_BYTES = 256 * 1024;

function groqApiKey(mode: string): string {
  const env = loadEnv(mode, process.cwd(), "");
  return env.GROQ_API_KEY || process.env.GROQ_API_KEY || "";
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function attachParseSyllabusRoute(middlewares: Connect.Server, mode: string) {
  middlewares.use(async (req, res, next) => {
    const url = req.url?.split("?")[0];
    if (url !== ROUTE) return next();
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    try {
      const apiKey = groqApiKey(mode);
      if (!apiKey) {
        sendJson(res, 500, { error: "Syllabus parsing is not configured." });
        return;
      }

      const body = (await readJsonBody(req)) as { text?: unknown };
      if (typeof body.text !== "string" || !body.text.trim()) {
        sendJson(res, 400, { error: "Syllabus text is required." });
        return;
      }

      const parsed = await parseSyllabusWithGroq(body.text, apiKey);
      sendJson(res, 200, parsed);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to parse syllabus.";
      sendJson(res, 502, { error: message });
    }
  });
}

export function parseSyllabusApiPlugin(): Plugin {
  return {
    name: "parse-syllabus-api",
    configureServer(server: ViteDevServer) {
      attachParseSyllabusRoute(server.middlewares, server.config.mode);
    },
    configurePreviewServer(server) {
      attachParseSyllabusRoute(server.middlewares, "production");
    },
  };
}
