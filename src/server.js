const http = require("node:http");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { parseShareText, ParseError } = require("./services/parse-service");
const { fetchWorkDetail } = require("./services/detail-service");
const {
  prepareDownload,
  pipeTicketToResponse,
  matchDownloadFilePath,
} = require("./services/download-service");
const { createLogger } = require("./utils/logger");
const { loadEnvFile, getEnv, getEnvNumber } = require("./utils/env");

loadEnvFile();

const HOST = getEnv("HOST", "0.0.0.0");
const PORT = getEnvNumber("PORT", 8787);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }

  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }

  if (ext === ".js") {
    return "application/javascript; charset=utf-8";
  }

  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }

  if (ext === ".png") {
    return "image/png";
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }

  if (ext === ".webp") {
    return "image/webp";
  }

  return "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStaticFile(res, relativePath) {
  const normalized = relativePath === "/" ? "/index.html" : relativePath;
  const target = path.resolve(PUBLIC_DIR, `.${normalized}`);

  if (!target.startsWith(PUBLIC_DIR)) {
    throw new ParseError("STATIC_PATH_INVALID", "非法静态资源路径", 400);
  }

  const file = await fs.readFile(target);
  res.writeHead(200, {
    "Content-Type": getMimeType(target),
    "Content-Length": file.byteLength,
  });
  res.end(file);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1024 * 1024) {
        reject(new ParseError("PAYLOAD_TOO_LARGE", "请求体不能超过 1MB", 413));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new ParseError("INVALID_JSON", "请求体必须是合法 JSON", 400));
      }
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

function getRequestContext(req) {
  return {
    requestId: randomUUID(),
    ip:
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown",
    userAgent: req.headers["user-agent"] || "",
  };
}

async function handleParse(req, res) {
  const context = getRequestContext(req);
  const logger = createLogger({
    requestId: context.requestId,
    route: "/api/parse",
  });
  const body = await readJsonBody(req);
  const text = typeof body.text === "string" ? body.text : "";
  const options = {
    resolveRedirect: body.resolveRedirect !== false,
    includeDebug: body.includeDebug === true,
  };

  logger.info("parse.start", {
    ip: context.ip,
    textLength: text.length,
    resolveRedirect: options.resolveRedirect,
    includeDebug: options.includeDebug,
    fetchMetadata: body.fetchMetadata === true,
  });

  const result = await parseShareText(text, {
    ...options,
    logger,
  });
  const fetchMetadata = body.fetchMetadata === true;

  if (fetchMetadata && result.resolved.resourceId) {
    result.metadata = await fetchWorkDetail(
      {
        platform: result.platform,
        resourceId: result.resolved.resourceId,
        awemeId: result.resolved.awemeId,
        bvid: result.resolved.bvid,
        aid: result.resolved.aid,
        page: result.resolved.page,
        resolvedUrl: result.resolved.finalUrl,
        typeHint: result.resolved.resourceTypeHint,
      },
      {
        includeDebug: body.includeDebug === true,
        logger,
      },
    );
  }

  logger.info("parse.success", {
    platform: result.platform,
    status: result.status,
    resourceId: result.resolved.resourceId,
    awemeId: result.resolved.awemeId,
    resourceTypeHint: result.resolved.resourceTypeHint,
    metadataIncluded: Boolean(result.metadata),
  });

  sendJson(res, 200, {
    success: true,
    requestId: context.requestId,
    data: result,
  });
}

async function handleDetail(req, res) {
  const context = getRequestContext(req);
  const logger = createLogger({
    requestId: context.requestId,
    route: "/api/detail",
  });
  const body = await readJsonBody(req);

  const platform = typeof body.platform === "string" ? body.platform : "";
  const awemeId =
    typeof body.awemeId === "string"
      ? body.awemeId
      : typeof body.resourceId === "string"
        ? body.resourceId
        : "";
  const bvid = typeof body.bvid === "string" ? body.bvid : "";
  const aid = typeof body.aid === "string" ? body.aid : "";
  const page =
    Number.isInteger(body.page) && body.page > 0
      ? body.page
      : Number.parseInt(String(body.page || ""), 10) || null;
  const resolvedUrl = typeof body.resolvedUrl === "string" ? body.resolvedUrl : "";
  const typeHint = typeof body.typeHint === "string" ? body.typeHint : "";

  logger.info("detail.start", {
    ip: context.ip,
    platform,
    awemeId,
    bvid,
    aid,
    page,
    typeHint,
    hasResolvedUrl: Boolean(resolvedUrl),
    includeDebug: body.includeDebug === true,
  });

  const detail = await fetchWorkDetail(
    {
      platform,
      resourceId: awemeId,
      awemeId,
      bvid,
      aid,
      page,
      resolvedUrl,
      typeHint,
    },
    {
      includeDebug: body.includeDebug === true,
      logger,
    },
  );

  logger.info("detail.success", {
    platform: detail.platform,
    resourceId: detail.resourceId,
    awemeId: detail.awemeId,
    mediaType: detail.mediaType,
    sourceCount: detail.sources.length,
    imageCount: detail.images.length,
  });

  sendJson(res, 200, {
    success: true,
    requestId: context.requestId,
    data: detail,
  });
}

async function handleDownloadPrepare(req, res) {
  const context = getRequestContext(req);
  const logger = createLogger({
    requestId: context.requestId,
    route: "/api/download/prepare",
  });
  const body = await readJsonBody(req);

  logger.info("download.prepare.start", {
    ip: context.ip,
    platform: body.platform || "",
    awemeId: body.awemeId || body.resourceId || "",
    bvid: body.bvid || "",
    aid: body.aid || "",
    page: body.page || "",
    sourceId: body.sourceId || "",
    imageId: body.imageId || "",
    typeHint: body.typeHint || "",
  });

  const result = await prepareDownload(body, {
    logger,
  });

  logger.info("download.prepare.success", {
    platform: result.platform,
    resourceId: result.resourceId,
    awemeId: result.awemeId,
    assetType: result.assetType,
    assetId: result.assetId,
    expiresAt: result.expiresAt,
  });

  sendJson(res, 200, {
    success: true,
    requestId: context.requestId,
    data: result,
  });
}

function handleHealth(_, res) {
  sendJson(res, 200, {
    success: true,
    data: {
      service: "universal-downloader-backend",
      status: "ok",
      now: new Date().toISOString(),
    },
  });
}

function handleNotFound(req, res) {
  sendJson(res, 404, {
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `未找到路由 ${req.method} ${req.url}`,
    },
  });
}

function handleError(error, res) {
  const logger = createLogger();

  if (error && error.code === "ENOENT") {
    sendJson(res, 404, {
      success: false,
      error: {
        code: "STATIC_NOT_FOUND",
        message: "静态资源不存在",
      },
    });
    return;
  }

  if (error instanceof ParseError) {
    logger.warn("request.failed", {
      error,
    });
    sendJson(res, error.statusCode, {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details || null,
      },
    });
    return;
  }

  logger.error("request.crashed", {
    error,
  });
  sendJson(res, 500, {
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "服务内部错误",
      details: error.message,
    },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = requestUrl.pathname;
    const requestLogger = createLogger({
      method: req.method,
      pathname,
    });

    if (req.method === "GET" && pathname === "/health") {
      handleHealth(req, res);
      return;
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      await serveStaticFile(res, "/index.html");
      return;
    }

    if (req.method === "GET" && (pathname === "/styles.css" || pathname === "/app.js")) {
      await serveStaticFile(res, pathname);
      return;
    }

    if (req.method === "POST" && pathname === "/api/parse") {
      await handleParse(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/detail") {
      await handleDetail(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/download/prepare") {
      await handleDownloadPrepare(req, res);
      return;
    }

    if (req.method === "GET") {
      const ticket = matchDownloadFilePath(pathname);
      if (ticket) {
        await pipeTicketToResponse(ticket, res, {
          logger: requestLogger,
          pathname,
        });
        return;
      }
    }

    handleNotFound(req, res);
  } catch (error) {
    handleError(error, res);
  }
});

server.listen(PORT, HOST, () => {
  // Keep startup output short so it's easy to spot in terminals and logs.
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
