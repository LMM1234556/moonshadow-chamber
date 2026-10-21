import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import dotenv from "dotenv";
import { modelConfiguration, requestModelDecision } from "./server/modelDecision.js";

dotenv.config({ path: resolve(".env.local"), quiet: true });
dotenv.config({ path: resolve(".env"), quiet: true });

const projectRoot = resolve(".");
const webRoot = resolve(projectRoot, "web");
const sourceRoot = resolve(projectRoot, "src");
const port = Number(process.env.PORT ?? 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error("请求体超过64KB限制");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeStaticPath(pathname) {
  if (pathname.startsWith("/src/")) {
    const candidate = resolve(sourceRoot, pathname.slice("/src/".length));
    return candidate.startsWith(`${sourceRoot}${sep}`) ? candidate : null;
  }
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(webRoot, relative);
  return candidate === webRoot || candidate.startsWith(`${webRoot}${sep}`) ? candidate : null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/api/model/status") {
    return sendJson(response, 200, modelConfiguration());
  }

  if (request.method === "POST" && url.pathname === "/api/model/decision") {
    try {
      const body = await readJson(request);
      const result = await requestModelDecision(body.observation);
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      const isConfiguration = error.code === "MODEL_NOT_CONFIGURED";
      const isInput = [
        "PAYLOAD_TOO_LARGE",
        "INVALID_OBSERVATION",
        "INVALID_ACTION",
        "INVALID_DECISION",
        "ACTION_MISMATCH",
        "INVALID_SPEECH",
        "SPEECH_TOO_LONG",
        "ILLEGAL_TARGET",
      ].includes(error.code);
      const timeout = error.name === "TimeoutError" || error.name === "AbortError";
      return sendJson(response, isConfiguration ? 503 : isInput ? 400 : timeout ? 504 : 502, {
        ok: false,
        code: isConfiguration ? error.code : timeout ? "MODEL_TIMEOUT" : isInput ? error.code : "MODEL_FAILURE",
        message: isConfiguration
          ? "大模型模式尚未配置，客户端应降级到规则机器人。"
          : timeout
            ? "模型请求超时，客户端应降级到规则机器人。"
            : isInput
              ? error.message
              : "模型请求失败，客户端应降级到规则机器人。",
      });
    }
  }

  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET, POST" });
    return response.end("Method Not Allowed");
  }

  const filePath = safeStaticPath(decodeURIComponent(url.pathname));
  if (!filePath) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    return response.end(content);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500);
    return response.end(error.code === "ENOENT" ? "Not Found" : "Internal Server Error");
  }
});

server.listen(port, "127.0.0.1", () => {
  const config = modelConfiguration();
  console.log(`狼人杀教学局已启动：http://127.0.0.1:${port}`);
  console.log(config.configured
    ? `阿里云百炼模式已配置：${config.model}，超时 ${config.timeoutMs}ms`
    : `阿里云百炼模式未配置（缺少：${config.missing.join("、")}）；选择该模式时会明确降级到规则机器人。`
  );
});
