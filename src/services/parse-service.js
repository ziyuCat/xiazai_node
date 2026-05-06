const { randomUUID } = require("node:crypto");

const DOUYIN_HOSTS = new Set([
  "v.douyin.com",
  "www.douyin.com",
  "douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com",
]);

const BILIBILI_HOSTS = new Set([
  "b23.tv",
  "www.b23.tv",
  "bili2233.cn",
  "www.bili2233.cn",
  "www.bilibili.com",
  "bilibili.com",
  "m.bilibili.com",
]);

const URL_PATTERN = /https?:\/\/[^\s<>"'\u3000]+/giu;
const TRAILING_PUNCTUATION =
  /[)\]}>,.!?;:'"\u3002\uff0c\uff01\uff1f\u3001\u300b\u300d]+$/gu;
const BILIBILI_TITLE_SUFFIX = /\s*[-_]\s*(?:哔哩哔哩|bilibili)\s*$/iu;

class ParseError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = "ParseError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function normalizeText(input) {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

function extractUrls(text) {
  const matches = text.match(URL_PATTERN) || [];
  return matches.map((url) => url.replace(TRAILING_PUNCTUATION, ""));
}

function extractQuotedTitle(text) {
  const patterns = [
    /【([^】]+)】/u,
    /「([^」]+)」/u,
    /『([^』]+)』/u,
    /“([^”]+)”/u,
    /"([^"]+)"/u,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function normalizeShareTitle(title, platform) {
  const normalized = String(title || "").trim();
  if (!normalized) {
    return "";
  }

  if (platform === "bilibili") {
    return normalized.replace(BILIBILI_TITLE_SUFFIX, "").trim();
  }

  return normalized;
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

function isDouyinHost(hostname) {
  const normalized = normalizeHostname(hostname);
  return DOUYIN_HOSTS.has(normalized) || normalized.endsWith(".douyin.com");
}

function isBilibiliHost(hostname) {
  const normalized = normalizeHostname(hostname);
  return (
    BILIBILI_HOSTS.has(normalized) ||
    normalized.endsWith(".bilibili.com") ||
    normalized.endsWith(".b23.tv")
  );
}

function detectPlatform(url) {
  try {
    const parsed = new URL(url);
    if (isDouyinHost(parsed.hostname)) {
      return "douyin";
    }

    if (isBilibiliHost(parsed.hostname)) {
      return "bilibili";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function isSupportedPlatform(platform) {
  return platform === "douyin" || platform === "bilibili";
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function extractResourceTypeFromUrl(url) {
  try {
    const parsed = new URL(url);
    const platform = detectPlatform(url);

    if (platform === "douyin") {
      if (/\/video\/\d+/u.test(parsed.pathname)) {
        return "video";
      }

      if (/\/note\/\d+/u.test(parsed.pathname)) {
        return "note";
      }
    }

    if (platform === "bilibili" && /\/video\//iu.test(parsed.pathname)) {
      return "video";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function getBestUrl(urls) {
  const supportedUrl = urls.find((url) => isSupportedPlatform(detectPlatform(url)));
  return supportedUrl || urls[0] || null;
}

function pickShareCode(text) {
  const match = text.match(/(^|\s)(\d+\.\d{1,2})\s/u);
  return match ? match[2] : "";
}

async function followRedirects(inputUrl, maxHops = 5) {
  let currentUrl = inputUrl;
  const hops = [];

  for (let index = 0; index < maxHops; index += 1) {
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const location = response.headers.get("location");
    hops.push({
      url: currentUrl,
      status: response.status,
      location: location || null,
    });

    if (!location || response.status < 300 || response.status >= 400) {
      return {
        finalUrl: currentUrl,
        hops,
        stoppedBy: "terminal-response",
      };
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  return {
    finalUrl: currentUrl,
    hops,
    stoppedBy: "max-hops",
  };
}

function extractAwemeIdFromUrl(url) {
  try {
    const parsed = new URL(url);

    const videoMatch = parsed.pathname.match(/\/video\/(\d+)/u);
    if (videoMatch) {
      return videoMatch[1];
    }

    const noteMatch = parsed.pathname.match(/\/note\/(\d+)/u);
    if (noteMatch) {
      return noteMatch[1];
    }

    const queryKeys = ["modal_id", "item_ids", "group_id", "aweme_id"];
    for (const key of queryKeys) {
      const value = parsed.searchParams.get(key);
      if (value && /^\d+$/u.test(value)) {
        return value;
      }
    }
  } catch {
    return "";
  }

  return "";
}

function extractBilibiliIdsFromUrl(url) {
  const fallback = {
    bvid: "",
    aid: "",
    page: 1,
  };

  try {
    const parsed = new URL(url);
    const bvidMatch = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/iu);
    const aidMatch = parsed.pathname.match(/\/video\/av(\d+)/iu);

    return {
      bvid: bvidMatch ? bvidMatch[1] : "",
      aid: aidMatch ? aidMatch[1] : "",
      page: normalizePositiveInteger(parsed.searchParams.get("p"), 1),
    };
  } catch {
    return fallback;
  }
}

function normalizeResolvedUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const platform = detectPlatform(raw);
    if (platform === "bilibili") {
      const { bvid, aid, page } = extractBilibiliIdsFromUrl(raw);
      const resourceId = bvid || (aid ? `av${aid}` : "");
      if (resourceId) {
        const canonical = new URL(`https://www.bilibili.com/video/${resourceId}`);
        canonical.searchParams.set("p", String(page || 1));
        return canonical.toString();
      }
    }

    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function buildResolvedInfo({ selectedUrl, resolvedUrl, title }) {
  const finalUrl = normalizeResolvedUrl(resolvedUrl || selectedUrl || "");
  const platform =
    detectPlatform(finalUrl) !== "unknown"
      ? detectPlatform(finalUrl)
      : detectPlatform(selectedUrl);
  const resourceTypeHint = extractResourceTypeFromUrl(finalUrl || selectedUrl);
  const awemeId = extractAwemeIdFromUrl(finalUrl) || extractAwemeIdFromUrl(selectedUrl);
  const bilibiliFromFinalUrl = extractBilibiliIdsFromUrl(finalUrl);
  const bilibiliFromSelectedUrl = extractBilibiliIdsFromUrl(selectedUrl);
  const bilibiliInfo =
    bilibiliFromFinalUrl.bvid || bilibiliFromFinalUrl.aid
      ? bilibiliFromFinalUrl
      : bilibiliFromSelectedUrl;
  const resourceId =
    platform === "douyin" ? awemeId : bilibiliInfo.bvid || bilibiliInfo.aid || "";

  return {
    platform,
    finalUrl,
    resourceId,
    awemeId: platform === "douyin" ? awemeId : resourceId,
    bvid: bilibiliInfo.bvid,
    aid: bilibiliInfo.aid,
    page: platform === "bilibili" ? bilibiliInfo.page : null,
    title: normalizeShareTitle(title, platform),
    resourceTypeHint,
  };
}

function buildResponse({
  text,
  selectedUrl,
  resolvedUrl,
  title,
  shareCode,
  redirectInfo,
  includeDebug,
}) {
  const resolved = buildResolvedInfo({
    selectedUrl,
    resolvedUrl,
    title,
  });

  const hasResourceId = Boolean(resolved.resourceId);
  const type =
    resolved.resourceTypeHint !== "unknown"
      ? resolved.resourceTypeHint
      : hasResourceId && resolved.platform === "douyin"
        ? "video_or_note"
        : hasResourceId
          ? "video"
          : "unknown";

  const data = {
    parseId: `parse_${Date.now()}_${randomUUID().slice(0, 8)}`,
    platform:
      detectPlatform(resolved.finalUrl) !== "unknown"
        ? detectPlatform(resolved.finalUrl)
        : detectPlatform(selectedUrl),
    type,
    input: {
      rawText: text,
      shareCode,
      shareUrl: selectedUrl,
    },
    resolved,
    status: hasResourceId ? "resolved" : "partial",
    nextStep: hasResourceId
      ? "You can continue to fetch metadata or prepare a download."
      : "The share URL was extracted, but the resource id is still missing.",
  };

  if (includeDebug) {
    data.debug = {
      redirectInfo,
    };
  }

  return data;
}

async function parseShareText(inputText, options = {}) {
  const text = normalizeText(inputText);
  const includeDebug = options.includeDebug === true;
  const logger = options.logger;

  if (!text) {
    throw new ParseError("EMPTY_TEXT", "Please provide share text.");
  }

  const urls = extractUrls(text);
  logger?.info("parse.extract_urls", {
    extractedUrlCount: urls.length,
  });

  if (urls.length === 0) {
    throw new ParseError("NO_URL_FOUND", "No share URL was found in the text.");
  }

  const selectedUrl = getBestUrl(urls);
  if (!selectedUrl) {
    throw new ParseError("NO_SUPPORTED_URL", "No usable share URL was found.");
  }

  const platform = detectPlatform(selectedUrl);
  if (!isSupportedPlatform(platform)) {
    throw new ParseError(
      "UNSUPPORTED_PLATFORM",
      "This version only supports Douyin and Bilibili share links.",
      400,
      {
        selectedUrl,
        platform,
      },
    );
  }

  const title = extractQuotedTitle(text);
  const shareCode = platform === "douyin" ? pickShareCode(text) : "";
  let resolvedUrl = selectedUrl;
  let redirectInfo = {
    finalUrl: selectedUrl,
    hops: [],
    stoppedBy: "skipped",
  };

  if (options.resolveRedirect !== false) {
    try {
      logger?.info("parse.redirect.start", {
        selectedUrl,
      });
      redirectInfo = await followRedirects(selectedUrl);
      resolvedUrl = redirectInfo.finalUrl || selectedUrl;
      logger?.info("parse.redirect.success", {
        selectedUrl,
        finalUrl: resolvedUrl,
        hopCount: redirectInfo.hops.length,
        stoppedBy: redirectInfo.stoppedBy,
      });
    } catch (error) {
      logger?.warn("parse.redirect.failed", {
        selectedUrl,
        error,
      });
      if (includeDebug) {
        redirectInfo = {
          finalUrl: selectedUrl,
          hops: [],
          stoppedBy: "network-error",
          error: error.message,
        };
      }
    }
  }

  const resolved = buildResolvedInfo({
    selectedUrl,
    resolvedUrl,
    title,
  });

  logger?.info("parse.resource_id_result", {
    selectedUrl,
    resolvedUrl,
    platform,
    resourceId: resolved.resourceId,
    awemeId: resolved.awemeId,
    bvid: resolved.bvid,
    aid: resolved.aid,
    page: resolved.page,
    resourceTypeHint: resolved.resourceTypeHint,
    titleFound: Boolean(resolved.title),
    shareCodeFound: Boolean(shareCode),
  });

  return buildResponse({
    text,
    selectedUrl,
    resolvedUrl,
    title,
    shareCode,
    redirectInfo,
    includeDebug,
  });
}

module.exports = {
  parseShareText,
  ParseError,
  _internal: {
    normalizeText,
    extractUrls,
    extractQuotedTitle,
    normalizeShareTitle,
    detectPlatform,
    isSupportedPlatform,
    getBestUrl,
    pickShareCode,
    followRedirects,
    extractAwemeIdFromUrl,
    extractBilibiliIdsFromUrl,
    normalizeResolvedUrl,
    extractResourceTypeFromUrl,
  },
};
