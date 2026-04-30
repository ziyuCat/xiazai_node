const { randomUUID } = require("node:crypto");

const DOUYIN_HOSTS = new Set([
  "v.douyin.com",
  "www.douyin.com",
  "douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com",
]);

const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？、）】]+/gi;
const TRAILING_PUNCTUATION = /[)\]}>,.!?;:'"，。！？、）】]+$/g;

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
  const bracketMatch = text.match(/【([^】]+)】/);
  if (bracketMatch) {
    return bracketMatch[1].trim();
  }

  const quoteMatch = text.match(/["“](.+?)["”]/);
  return quoteMatch ? quoteMatch[1].trim() : "";
}

function extractResourceTypeFromUrl(url) {
  try {
    const parsed = new URL(url);

    if (/\/video\/\d+/.test(parsed.pathname)) {
      return "video";
    }

    if (/\/note\/\d+/.test(parsed.pathname)) {
      return "note";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

// 平台识别放在最前面做，后面每一层都只处理自己支持的平台，
// 这样错误会更早暴露，不会把奇怪的链接一路带到详情抓取或下载层。
function detectPlatform(url) {
  try {
    const parsed = new URL(url);
    if (DOUYIN_HOSTS.has(parsed.hostname)) {
      return "douyin";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

function getBestUrl(urls) {
  const douyinUrl = urls.find((url) => detectPlatform(url) === "douyin");
  return douyinUrl || urls[0] || null;
}

function pickShareCode(text) {
  const match = text.match(/(^|\s)(\d+\.\d{1,2})\s/);
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

    const videoMatch = parsed.pathname.match(/\/video\/(\d+)/);
    if (videoMatch) {
      return videoMatch[1];
    }

    const noteMatch = parsed.pathname.match(/\/note\/(\d+)/);
    if (noteMatch) {
      return noteMatch[1];
    }

    const queryKeys = ["modal_id", "item_ids", "group_id", "aweme_id"];
    for (const key of queryKeys) {
      const value = parsed.searchParams.get(key);
      if (value && /^\d+$/.test(value)) {
        return value;
      }
    }
  } catch {
    return "";
  }

  return "";
}

function buildResponse({
  text,
  selectedUrl,
  resolvedUrl,
  title,
  shareCode,
  awemeId,
  redirectInfo,
  includeDebug,
}) {
  const platform = selectedUrl ? detectPlatform(selectedUrl) : "unknown";
  const finalUrl = resolvedUrl || selectedUrl || "";
  const resourceTypeHint = extractResourceTypeFromUrl(finalUrl);

  const data = {
    parseId: `parse_${Date.now()}_${randomUUID().slice(0, 8)}`,
    platform,
    type:
      resourceTypeHint !== "unknown"
        ? resourceTypeHint
        : awemeId
          ? "video_or_note"
          : "unknown",
    input: {
      rawText: text,
      shareCode,
      shareUrl: selectedUrl,
    },
    resolved: {
      finalUrl,
      awemeId,
      title: title || "",
      resourceTypeHint,
    },
    status: awemeId ? "resolved" : "partial",
    nextStep: awemeId
      ? "可以继续调用作品详情抓取模块"
      : "已提取链接，但还需要作品详情抓取模块补全信息",
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
    throw new ParseError("EMPTY_TEXT", "请输入抖音分享文案");
  }

  const urls = extractUrls(text);
  logger?.info("parse.extract_urls", {
    extractedUrlCount: urls.length,
  });

  if (urls.length === 0) {
    throw new ParseError("NO_URL_FOUND", "未在文案中找到可解析链接");
  }

  const selectedUrl = getBestUrl(urls);
  if (!selectedUrl) {
    throw new ParseError("NO_SUPPORTED_URL", "没有可用的分享链接");
  }

  const platform = detectPlatform(selectedUrl);
  if (platform !== "douyin") {
    throw new ParseError("UNSUPPORTED_PLATFORM", "当前版本仅支持抖音链接", 400, {
      selectedUrl,
      platform,
    });
  }

  const title = extractQuotedTitle(text);
  const shareCode = pickShareCode(text);
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

  const awemeId = extractAwemeIdFromUrl(resolvedUrl) || extractAwemeIdFromUrl(selectedUrl);
  logger?.info("parse.aweme_id_result", {
    selectedUrl,
    resolvedUrl,
    awemeId,
    resourceTypeHint: extractResourceTypeFromUrl(resolvedUrl),
    titleFound: Boolean(title),
    shareCodeFound: Boolean(shareCode),
  });

  return buildResponse({
    text,
    selectedUrl,
    resolvedUrl,
    title,
    shareCode,
    awemeId,
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
    detectPlatform,
    getBestUrl,
    pickShareCode,
    extractAwemeIdFromUrl,
    extractResourceTypeFromUrl,
  },
};
