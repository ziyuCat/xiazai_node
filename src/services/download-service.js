const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");

const { ParseError } = require("./parse-service");
const { fetchWorkDetail } = require("./detail-service");
const { loadEnvFile, getEnv } = require("../utils/env");

const DEFAULT_TICKET_TTL_MS = 10 * 60 * 1000;

loadEnvFile();

const DEFAULT_HOST = getEnv("PUBLIC_BASE_URL", "http://127.0.0.1:8787");

const ticketStore = new Map();

function cleanupExpiredTickets() {
  const now = Date.now();

  for (const [ticket, payload] of ticketStore.entries()) {
    if (payload.expiresAt <= now) {
      ticketStore.delete(ticket);
    }
  }
}

function sanitizeFileName(input) {
  const base = String(input || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return base || "download";
}

function ensureExtension(fileName, extension) {
  if (!extension) {
    return fileName;
  }

  if (fileName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    return fileName;
  }

  return `${fileName}.${extension}`;
}

function inferExtensionFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/u);
    if (match) {
      return match[1].toLowerCase();
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function buildVideoFileName(detail, source) {
  const title = sanitizeFileName(detail.title || detail.resourceId || detail.awemeId);
  const pageSuffix =
    detail.platform === "bilibili" && detail.page
      ? `-p${detail.page}${detail.part && detail.part !== detail.title ? `-${sanitizeFileName(detail.part)}` : ""}`
      : "";
  const sourceSuffix = source.label ? `-${sanitizeFileName(source.label)}` : "";

  return ensureExtension(`${title}${pageSuffix}${sourceSuffix}`, "mp4");
}

function buildImageFileName(detail, image, index) {
  const title = sanitizeFileName(detail.title || detail.resourceId || detail.awemeId);
  const ext = inferExtensionFromUrl(image.downloadUrl || image.url, "jpg");
  return ensureExtension(`${title}-${index + 1}`, ext);
}

function chooseAsset(detail, body) {
  if (detail.mediaType === "video") {
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
    const source = sourceId
      ? detail.sources.find((item) => item.id === sourceId)
      : detail.sources[0];

    if (!source) {
      throw new ParseError("SOURCE_NOT_FOUND", "The requested video source was not found.", 404, {
        sourceId,
      });
    }

    if (!source.url) {
      throw new ParseError(
        "SOURCE_URL_MISSING",
        "The selected video source does not include a download URL.",
        502,
        {
          sourceId: source.id,
        },
      );
    }

    return {
      assetType: "video",
      assetId: source.id,
      upstreamUrl: source.url,
      fileName: buildVideoFileName(detail, source),
      contentTypeHint: "video/mp4",
      label: source.label,
      metadata: source,
    };
  }

  const imageId = typeof body.imageId === "string" ? body.imageId : "";
  const image = imageId
    ? detail.images.find((item) => item.id === imageId)
    : detail.images[0];

  if (!image) {
    throw new ParseError("IMAGE_NOT_FOUND", "The requested image was not found.", 404, {
      imageId,
    });
  }

  const downloadUrl = image.downloadUrl || image.url;
  if (!downloadUrl) {
    throw new ParseError(
      "IMAGE_URL_MISSING",
      "The selected image does not include a download URL.",
      502,
      {
        imageId: image.id,
      },
    );
  }

  const index = detail.images.findIndex((item) => item.id === image.id);

  return {
    assetType: "image",
    assetId: image.id,
    upstreamUrl: downloadUrl,
    fileName: buildImageFileName(detail, image, Math.max(index, 0)),
    contentTypeHint: "image/jpeg",
    label: image.id,
    metadata: image,
  };
}

function buildDownloadUrl(ticket) {
  return `${DEFAULT_HOST}/api/download/file/${ticket}`;
}

function createTicketPayload(detail, asset, ttlMs) {
  const now = Date.now();
  const ticket = `dl_${randomUUID().replace(/-/g, "")}`;
  const expiresAt = now + ttlMs;

  const payload = {
    ticket,
    createdAt: now,
    expiresAt,
    platform: detail.platform || "douyin",
    resourceId: detail.resourceId || detail.awemeId,
    awemeId: detail.awemeId,
    bvid: detail.bvid || "",
    aid: detail.aid || "",
    page: detail.page || null,
    mediaType: detail.mediaType,
    title: detail.title,
    part: detail.part || "",
    author: detail.author?.nickname || "",
    sharePage: detail.sharePage,
    asset,
  };

  ticketStore.set(ticket, payload);
  cleanupExpiredTickets();

  return payload;
}

async function prepareDownload(body, options = {}) {
  const awemeId = String(body.awemeId || body.resourceId || "").trim();
  const resolvedUrl = String(body.resolvedUrl || "").trim();
  const typeHint = String(body.typeHint || body.resourceTypeHint || "").trim();
  const platform = String(body.platform || "").trim().toLowerCase();
  const bvid = String(body.bvid || "").trim();
  const aid = String(body.aid || "").trim();
  const page =
    Number.isInteger(body.page) && body.page > 0
      ? body.page
      : Number.parseInt(String(body.page || ""), 10) || null;
  const logger = options.logger;
  const ttlMs =
    Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_TICKET_TTL_MS;

  logger?.info("download.prepare.detail_fetch", {
    platform,
    awemeId,
    bvid,
    aid,
    page,
    typeHint,
    hasResolvedUrl: Boolean(resolvedUrl),
  });

  const detail = await fetchWorkDetail(
    {
      platform,
      awemeId,
      resourceId: awemeId,
      resolvedUrl,
      typeHint,
      bvid,
      aid,
      page,
    },
    {
      includeDebug: false,
      logger,
    },
  );

  const asset = chooseAsset(detail, body);
  const ticketPayload = createTicketPayload(detail, asset, ttlMs);

  logger?.info("download.prepare.ticket_created", {
    platform: detail.platform,
    resourceId: detail.resourceId,
    mediaType: detail.mediaType,
    assetType: asset.assetType,
    assetId: asset.assetId,
    ticket: ticketPayload.ticket,
    expiresAt: ticketPayload.expiresAt,
  });

  return {
    ticket: ticketPayload.ticket,
    platform: detail.platform,
    resourceId: detail.resourceId,
    awemeId: detail.awemeId,
    bvid: detail.bvid || "",
    aid: detail.aid || "",
    page: detail.page || null,
    mediaType: detail.mediaType,
    assetType: asset.assetType,
    assetId: asset.assetId,
    fileName: asset.fileName,
    expiresAt: ticketPayload.expiresAt,
    downloadUrl: buildDownloadUrl(ticketPayload.ticket),
    source: {
      label: asset.label,
      contentTypeHint: asset.contentTypeHint,
    },
  };
}

function getTicketOrThrow(ticket) {
  cleanupExpiredTickets();

  const payload = ticketStore.get(ticket);
  if (!payload) {
    throw new ParseError("TICKET_NOT_FOUND", "The download ticket does not exist or has expired.", 404);
  }

  if (payload.expiresAt <= Date.now()) {
    ticketStore.delete(ticket);
    throw new ParseError("TICKET_EXPIRED", "The download ticket expired. Please create a new one.", 410);
  }

  return payload;
}

function setDownloadHeaders(res, upstreamResponse, payload) {
  const upstreamType = upstreamResponse.headers.get("content-type");
  const upstreamLength = upstreamResponse.headers.get("content-length");
  const type = upstreamType || payload.asset.contentTypeHint || "application/octet-stream";

  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(payload.asset.fileName)}`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Download-Ticket", payload.ticket);

  if (upstreamLength) {
    res.setHeader("Content-Length", upstreamLength);
  }
}

function buildDownloadHeaders(payload) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    referer:
      payload.sharePage?.pageUrl ||
      payload.sharePage?.sourceUrl ||
      (payload.platform === "bilibili"
        ? "https://www.bilibili.com/"
        : "https://www.iesdouyin.com/"),
  };

  if (payload.platform === "bilibili") {
    headers.origin = "https://www.bilibili.com";
  }

  return headers;
}

async function pipeTicketToResponse(ticket, res, options = {}) {
  const logger = options.logger;
  const payload = getTicketOrThrow(ticket);
  logger?.info("download.proxy.start", {
    ticket,
    platform: payload.platform,
    resourceId: payload.resourceId,
    assetType: payload.asset.assetType,
    assetId: payload.asset.assetId,
  });

  const upstreamResponse = await fetch(payload.asset.upstreamUrl, {
    headers: buildDownloadHeaders(payload),
    redirect: "follow",
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    logger?.warn("download.proxy.upstream_failed", {
      ticket,
      status: upstreamResponse.status,
      upstreamUrl: payload.asset.upstreamUrl,
    });
    throw new ParseError("DOWNLOAD_UPSTREAM_FAILED", "The upstream download URL is unavailable.", 502, {
      status: upstreamResponse.status,
      url: payload.asset.upstreamUrl,
    });
  }

  setDownloadHeaders(res, upstreamResponse, payload);
  logger?.info("download.proxy.headers_ready", {
    ticket,
    contentType: upstreamResponse.headers.get("content-type"),
    contentLength: upstreamResponse.headers.get("content-length"),
    fileName: payload.asset.fileName,
  });
  Readable.fromWeb(upstreamResponse.body).pipe(res);
}

function matchDownloadFilePath(pathname) {
  const match = pathname.match(/^\/api\/download\/file\/([a-zA-Z0-9_]+)$/u);
  return match ? match[1] : null;
}

module.exports = {
  prepareDownload,
  pipeTicketToResponse,
  matchDownloadFilePath,
  _internal: {
    sanitizeFileName,
    buildVideoFileName,
    buildImageFileName,
    cleanupExpiredTickets,
    getTicketOrThrow,
  },
};
