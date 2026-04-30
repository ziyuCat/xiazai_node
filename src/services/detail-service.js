const { ParseError, _internal } = require("./parse-service");

const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

// 这里优先走 iesdouyin 的分享页，而不是 douyin 的桌面页。
// 原因很现实：分享页里的 SSR 数据更稳定，直接带 window._ROUTER_DATA，
// 对“工具型后端”来说比解析桌面页脚本更省心，也更容易维护。
function inferResourceType(typeHint, resolvedUrl) {
  if (typeHint === "video" || typeHint === "note") {
    return typeHint;
  }

  return _internal.extractResourceTypeFromUrl(resolvedUrl || "");
}

function buildCandidateShareUrls(awemeId, resourceType) {
  if (!awemeId) {
    throw new ParseError("MISSING_AWEME_ID", "抓取作品详情时必须提供 awemeId");
  }

  if (resourceType === "video") {
    return [`https://www.iesdouyin.com/share/video/${awemeId}/`];
  }

  if (resourceType === "note") {
    return [`https://www.iesdouyin.com/share/note/${awemeId}/`];
  }

  return [
    `https://www.iesdouyin.com/share/video/${awemeId}/`,
    `https://www.iesdouyin.com/share/note/${awemeId}/`,
  ];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": MOBILE_USER_AGENT,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new ParseError(
      "UPSTREAM_FETCH_FAILED",
      "抓取作品详情页面失败",
      502,
      {
        url,
        status: response.status,
      },
    );
  }

  return {
    url: response.url,
    status: response.status,
    html: await response.text(),
  };
}

function extractRouterData(html) {
  const match = html.match(
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/,
  );

  if (!match) {
    throw new ParseError("ROUTER_DATA_NOT_FOUND", "页面中未找到可解析的作品详情数据", 502);
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new ParseError("ROUTER_DATA_INVALID", "页面详情数据解析失败", 502, {
      reason: error.message,
    });
  }
}

function pickLoaderPage(loaderData) {
  if (!loaderData || typeof loaderData !== "object") {
    return null;
  }

  if (loaderData["video_(id)/page"]) {
    return {
      key: "video_(id)/page",
      data: loaderData["video_(id)/page"],
    };
  }

  if (loaderData["note_(id)/page"]) {
    return {
      key: "note_(id)/page",
      data: loaderData["note_(id)/page"],
    };
  }

  return null;
}

function getUnavailableDetails(videoInfoRes) {
  const filterItem = videoInfoRes?.filter_list?.[0];
  if (!filterItem) {
    return null;
  }

  return {
    code: filterItem.filter_reason || "unknown",
    notice: filterItem.notice || "抱歉，作品不见了",
    detail: filterItem.detail_msg || "因作品权限或已被删除，无法观看",
  };
}

function getPrimaryUrl(urlList) {
  return Array.isArray(urlList) && urlList.length > 0 ? urlList[0] : null;
}

function normalizeVideoSources(video) {
  if (!video) {
    return [];
  }

  const sources = [];
  const seen = new Set();

  function pushSource(source) {
    const key = source.url || `${source.kind}:${source.videoId || ""}:${source.label}`;
    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    sources.push(source);
  }

  const baseUrl = getPrimaryUrl(video.play_addr?.url_list);
  const videoId = video.play_addr?.uri || null;

  if (baseUrl) {
    pushSource({
      id: "wm_default",
      kind: "video",
      label: "默认源",
      watermark: "with_watermark",
      url: baseUrl,
      width: video.width || null,
      height: video.height || null,
      durationMs: video.duration || null,
      sizeBytes: video.play_addr?.data_size || null,
      videoId,
    });
  }

  if (videoId) {
    pushSource({
      id: "guess_nowm_default",
      kind: "video",
      label: "默认源(推测无水印)",
      watermark: "unknown",
      url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=720p&line=0`,
      width: video.width || null,
      height: video.height || null,
      durationMs: video.duration || null,
      sizeBytes: null,
      videoId,
    });
  }

  for (const [index, rate] of (video.bit_rate || []).entries()) {
    const rateUrl = getPrimaryUrl(rate.play_addr?.url_list);
    if (!rateUrl) {
      continue;
    }

    const labelParts = [];
    if (rate.gear_name) {
      labelParts.push(rate.gear_name);
    }

    if (rate.play_addr?.width && rate.play_addr?.height) {
      labelParts.push(`${rate.play_addr.width}x${rate.play_addr.height}`);
    }

    pushSource({
      id: `bitrate_${index + 1}`,
      kind: "video",
      label: labelParts.join(" ") || `码率源 ${index + 1}`,
      watermark: "unknown",
      url: rateUrl,
      width: rate.play_addr?.width || null,
      height: rate.play_addr?.height || null,
      durationMs: video.duration || null,
      sizeBytes: rate.play_addr?.data_size || null,
      bitRate: rate.bit_rate || null,
      qualityType: rate.quality_type || null,
      isH265: Boolean(rate.is_h265),
      videoId: rate.play_addr?.uri || videoId,
    });
  }

  return sources;
}

function normalizeImages(item) {
  return (item.images || []).map((image, index) => ({
    id: `image_${index + 1}`,
    url: getPrimaryUrl(image.url_list),
    downloadUrl: getPrimaryUrl(image.download_url_list) || getPrimaryUrl(image.url_list),
    width: image.width || null,
    height: image.height || null,
    uri: image.uri || null,
  }));
}

function normalizeStatistics(statistics) {
  return {
    commentCount: statistics?.comment_count || 0,
    diggCount: statistics?.digg_count || 0,
    playCount: statistics?.play_count || 0,
    shareCount: statistics?.share_count || 0,
    collectCount: statistics?.collect_count || 0,
  };
}

function normalizeDetail({
  awemeId,
  item,
  pageUrl,
  sourceUrl,
  pageKey,
  includeDebug,
  routerData,
}) {
  const mediaType = item.images && item.images.length > 0 ? "note" : "video";
  const cover =
    getPrimaryUrl(item.video?.cover?.url_list) ||
    getPrimaryUrl(item.images?.[0]?.url_list) ||
    getPrimaryUrl(item.author?.avatar_thumb?.url_list);

  const detail = {
    awemeId,
    mediaType,
    title: item.desc || "",
    description: item.desc || "",
    author: {
      uid: item.author?.uid || "",
      secUid: item.author?.sec_uid || "",
      nickname: item.author?.nickname || "",
      avatar: getPrimaryUrl(item.author?.avatar_thumb?.url_list),
    },
    cover,
    durationMs: item.video?.duration || null,
    statistics: normalizeStatistics(item.statistics),
    sharePage: {
      sourceUrl,
      pageUrl,
    },
    sources: mediaType === "video" ? normalizeVideoSources(item.video) : [],
    images: mediaType === "note" ? normalizeImages(item) : [],
    rawType: item.aweme_type,
  };

  if (includeDebug) {
    detail.debug = {
      pageKey,
      routerDataKeys: Object.keys(routerData.loaderData || {}),
      itemKeys: Object.keys(item),
    };
  }

  return detail;
}

async function fetchWorkDetail(input, options = {}) {
  const awemeId = String(input.awemeId || "").trim();
  const resolvedUrl = String(input.resolvedUrl || "").trim();
  const resourceType = inferResourceType(
    input.typeHint || input.resourceTypeHint || "",
    resolvedUrl,
  );
  const candidateUrls = buildCandidateShareUrls(awemeId, resourceType);
  const includeDebug = options.includeDebug === true;
  const logger = options.logger;

  let lastError = null;

  logger?.info("detail.fetch.start", {
    awemeId,
    resourceType,
    candidateUrlCount: candidateUrls.length,
  });

  for (const sourceUrl of candidateUrls) {
    try {
      logger?.info("detail.fetch.page_request", {
        awemeId,
        sourceUrl,
      });
      const page = await fetchText(sourceUrl);
      const routerData = extractRouterData(page.html);
      const pageInfo = pickLoaderPage(routerData.loaderData);

      if (!pageInfo) {
        throw new ParseError("DETAIL_PAGE_NOT_FOUND", "未找到作品详情页数据", 502, {
          sourceUrl,
        });
      }

      const videoInfoRes = pageInfo.data.videoInfoRes;
      const item = videoInfoRes?.item_list?.[0];

      if (!item) {
        const unavailable = getUnavailableDetails(videoInfoRes);
        if (unavailable) {
          throw new ParseError(
            "CONTENT_UNAVAILABLE",
            unavailable.notice,
            404,
            unavailable,
          );
        }

        throw new ParseError("EMPTY_ITEM_LIST", "页面已返回，但没有拿到作品详情", 502, {
          sourceUrl,
          statusCode: videoInfoRes?.status_code,
        });
      }

      const detail = normalizeDetail({
        awemeId,
        item,
        pageUrl: page.url,
        sourceUrl,
        pageKey: pageInfo.key,
        includeDebug,
        routerData,
      });

      logger?.info("detail.fetch.success", {
        awemeId,
        mediaType: detail.mediaType,
        pageKey: pageInfo.key,
        pageUrl: page.url,
        sourceCount: detail.sources.length,
        imageCount: detail.images.length,
      });

      return detail;
    } catch (error) {
      lastError = error;
      logger?.warn("detail.fetch.attempt_failed", {
        awemeId,
        sourceUrl,
        error,
      });

      if (error instanceof ParseError && error.code === "CONTENT_UNAVAILABLE") {
        throw error;
      }
    }
  }

  if (lastError instanceof ParseError) {
    logger?.warn("detail.fetch.failed", {
      awemeId,
      error: lastError,
    });
    throw lastError;
  }

  logger?.error("detail.fetch.crashed", {
    awemeId,
    error: lastError,
  });
  throw new ParseError("DETAIL_FETCH_FAILED", "抓取作品详情失败", 502, {
    reason: lastError ? lastError.message : "unknown",
  });
}

module.exports = {
  fetchWorkDetail,
};
