import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSyllabusRequest } from "../server/parseSyllabusRequest";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

type JsonRequest = IncomingMessage & { body?: unknown; method?: string };

function requestBody(req: JsonRequest): unknown {
  if (typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  return {};
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req: JsonRequest, res: ServerResponse) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const body = requestBody(req) as { text?: unknown };
    const result = await parseSyllabusRequest(body.text, process.env.GROQ_API_KEY || "");
    sendJson(res, result.status, result.body);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to parse syllabus.";
    sendJson(res, 502, { error: message });
  }
}
