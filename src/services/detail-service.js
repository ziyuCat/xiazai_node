const { ParseError, _internal } = require("./parse-service");

const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const BILIBILI_API_ORIGIN = "https://api.bilibili.com";

const BILIBILI_QUALITY_LABELS = new Map([
  [16, "360P"],
  [32, "480P"],
  [64, "720P"],
  [80, "1080P"],
  [112, "1080P+"],
  [116, "1080P60"],
  [120, "4K"],
  [125, "HDR"],
  [126, "Dolby Vision"],
  [127, "8K"],
]);

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function inferPlatform(input) {
  const explicitPlatform = String(input.platform || "").trim().toLowerCase();
  if (explicitPlatform && explicitPlatform !== "unknown") {
    return explicitPlatform;
  }

  const resolvedUrl = String(input.resolvedUrl || "").trim();
  const urlPlatform = resolvedUrl ? _internal.detectPlatform(resolvedUrl) : "unknown";
  if (urlPlatform !== "unknown") {
    return urlPlatform;
  }

  const bvid = String(input.bvid || "").trim();
  if (bvid || /^BV[0-9A-Z]+$/iu.test(String(input.awemeId || "").trim())) {
    return "bilibili";
  }

  return "douyin";
}

function inferDouyinResourceType(typeHint, resolvedUrl) {
  if (typeHint === "video" || typeHint === "note") {
    return typeHint;
  }

  return _internal.extractResourceTypeFromUrl(resolvedUrl || "");
}

function buildDouyinCandidateShareUrls(awemeId, resourceType) {
  if (!awemeId) {
    throw new ParseError("MISSING_AWEME_ID", "A Douyin awemeId is required.");
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
      "Failed to fetch the detail page from the upstream service.",
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
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/u,
  );

  if (!match) {
    throw new ParseError(
      "ROUTER_DATA_NOT_FOUND",
      "No parseable work detail data was found in the page.",
      502,
    );
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new ParseError("ROUTER_DATA_INVALID", "Failed to parse router data.", 502, {
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
    notice: filterItem.notice || "This work is not available.",
    detail:
      filterItem.detail_msg ||
      "The work may be deleted or no longer accessible due to permissions.",
  };
}

function getPrimaryUrl(urlList) {
  return Array.isArray(urlList) && urlList.length > 0 ? urlList[0] : null;
}

function normalizeDouyinVideoSources(video) {
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
      label: "Default source",
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
      label: "Guessed no-watermark source",
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
      label: labelParts.join(" ") || `Bitrate ${index + 1}`,
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

function normalizeDouyinImages(item) {
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
    commentCount: statistics?.comment_count || statistics?.reply || 0,
    diggCount: statistics?.digg_count || statistics?.like || 0,
    playCount: statistics?.play_count || statistics?.view || 0,
    shareCount: statistics?.share_count || statistics?.share || 0,
    collectCount: statistics?.collect_count || statistics?.favorite || 0,
  };
}

function normalizeDouyinDetail({
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
    platform: "douyin",
    resourceId: awemeId,
    awemeId,
    bvid: "",
    aid: "",
    page: null,
    part: "",
    pagesCount: 1,
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
    sources: mediaType === "video" ? normalizeDouyinVideoSources(item.video) : [],
    images: mediaType === "note" ? normalizeDouyinImages(item) : [],
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

async function fetchDouyinWorkDetail(input, options = {}) {
  const awemeId = String(input.awemeId || input.resourceId || "").trim();
  const resolvedUrl = String(input.resolvedUrl || "").trim();
  const resourceType = inferDouyinResourceType(
    input.typeHint || input.resourceTypeHint || "",
    resolvedUrl,
  );
  const candidateUrls = buildDouyinCandidateShareUrls(awemeId, resourceType);
  const includeDebug = options.includeDebug === true;
  const logger = options.logger;

  let lastError = null;

  logger?.info("detail.fetch.start", {
    platform: "douyin",
    awemeId,
    resourceType,
    candidateUrlCount: candidateUrls.length,
  });

  for (const sourceUrl of candidateUrls) {
    try {
      logger?.info("detail.fetch.page_request", {
        platform: "douyin",
        awemeId,
        sourceUrl,
      });
      const page = await fetchText(sourceUrl);
      const routerData = extractRouterData(page.html);
      const pageInfo = pickLoaderPage(routerData.loaderData);

      if (!pageInfo) {
        throw new ParseError("DETAIL_PAGE_NOT_FOUND", "No work detail page data was found.", 502, {
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

        throw new ParseError("EMPTY_ITEM_LIST", "The detail page returned without a work item.", 502, {
          sourceUrl,
          statusCode: videoInfoRes?.status_code,
        });
      }

      const detail = normalizeDouyinDetail({
        awemeId,
        item,
        pageUrl: page.url,
        sourceUrl,
        pageKey: pageInfo.key,
        includeDebug,
        routerData,
      });

      logger?.info("detail.fetch.success", {
        platform: "douyin",
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
        platform: "douyin",
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
      platform: "douyin",
      awemeId,
      error: lastError,
    });
    throw lastError;
  }

  logger?.error("detail.fetch.crashed", {
    platform: "douyin",
    awemeId,
    error: lastError,
  });
  throw new ParseError("DETAIL_FETCH_FAILED", "Failed to fetch Douyin work detail.", 502, {
    reason: lastError ? lastError.message : "unknown",
  });
}

function buildBilibiliPageUrl({ bvid, aid, page }) {
  const resourceId = bvid || `av${aid}`;
  const pageNumber = normalizePositiveInteger(page, 1);
  return `https://www.bilibili.com/video/${resourceId}?p=${pageNumber}`;
}

function buildBilibiliViewUrl({ bvid, aid }) {
  const params = new URLSearchParams();

  if (bvid) {
    params.set("bvid", bvid);
  } else if (aid) {
    params.set("aid", aid);
  } else {
    throw new ParseError("MISSING_BILIBILI_ID", "A Bilibili bvid or aid is required.");
  }

  return `${BILIBILI_API_ORIGIN}/x/web-interface/view?${params.toString()}`;
}

function buildBilibiliPlayurlUrl({ bvid, aid, cid, qn }) {
  const params = new URLSearchParams();
  params.set("cid", String(cid));
  params.set("qn", String(qn));
  params.set("fnval", "0");
  params.set("fourk", "1");
  params.set("platform", "html5");

  if (bvid) {
    params.set("bvid", bvid);
  } else if (aid) {
    params.set("aid", aid);
  } else {
    throw new ParseError("MISSING_BILIBILI_ID", "A Bilibili bvid or aid is required.");
  }

  return `${BILIBILI_API_ORIGIN}/x/player/playurl?${params.toString()}`;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": DESKTOP_USER_AGENT,
      accept: "application/json, text/plain, */*",
      ...headers,
    },
  });

  if (!response.ok) {
    throw new ParseError(
      "UPSTREAM_FETCH_FAILED",
      "Failed to fetch JSON from the upstream service.",
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
    payload: await response.json(),
  };
}

function findSupportFormat(playData, quality) {
  return (playData.support_formats || []).find((item) => Number(item.quality) === Number(quality));
}

function buildBilibiliQualityLabel(playData, quality) {
  const supportFormat = findSupportFormat(playData, quality);
  if (supportFormat?.new_description) {
    return supportFormat.new_description;
  }

  if (supportFormat?.display_desc) {
    return supportFormat.display_desc;
  }

  return BILIBILI_QUALITY_LABELS.get(Number(quality)) || `Q${quality}`;
}

async function fetchBilibiliViewData({ bvid, aid, pageUrl, logger }) {
  const url = buildBilibiliViewUrl({ bvid, aid });
  const { payload } = await fetchJson(url, {
    referer: pageUrl,
    origin: "https://www.bilibili.com",
  });

  if (payload.code !== 0 || !payload.data) {
    logger?.warn("detail.fetch.bilibili_view_failed", {
      url,
      code: payload.code,
      message: payload.message,
    });
    throw new ParseError("BILIBILI_VIEW_FAILED", "Failed to fetch Bilibili work detail.", 502, {
      url,
      code: payload.code,
      message: payload.message || payload.msg || "",
    });
  }

  return payload.data;
}

function pickBilibiliPage(viewData, requestedPage) {
  const pages =
    Array.isArray(viewData.pages) && viewData.pages.length > 0
      ? viewData.pages
      : [
          {
            cid: viewData.cid,
            page: 1,
            part: viewData.title,
            duration: viewData.duration,
            dimension: viewData.dimension,
          },
        ];

  const selected =
    pages.find((item) => Number(item.page) === Number(requestedPage)) || pages[0];

  if (!selected?.cid) {
    throw new ParseError("BILIBILI_CID_MISSING", "No valid cid was found for the selected page.", 502, {
      requestedPage,
      pagesCount: pages.length,
    });
  }

  return {
    cid: String(selected.cid),
    page: normalizePositiveInteger(selected.page, 1),
    part: String(selected.part || viewData.title || "").trim(),
    durationMs:
      normalizePositiveInteger(selected.duration, null) !== null
        ? Number(selected.duration) * 1000
        : normalizePositiveInteger(viewData.duration, 0) * 1000,
    width: selected.dimension?.width || viewData.dimension?.width || null,
    height: selected.dimension?.height || viewData.dimension?.height || null,
    pagesCount: pages.length,
  };
}

async function fetchBilibiliPlayData({ bvid, aid, cid, qn, pageUrl, logger }) {
  const url = buildBilibiliPlayurlUrl({ bvid, aid, cid, qn });
  const { payload } = await fetchJson(url, {
    referer: pageUrl,
    origin: "https://www.bilibili.com",
  });

  if (payload.code !== 0 || !payload.data) {
    logger?.warn("detail.fetch.bilibili_playurl_failed", {
      url,
      code: payload.code,
      message: payload.message,
      qn,
      cid,
    });
    throw new ParseError("BILIBILI_PLAYURL_FAILED", "Failed to fetch Bilibili play URL.", 502, {
      url,
      code: payload.code,
      message: payload.message || payload.msg || "",
      qn,
      cid,
    });
  }

  const durl = Array.isArray(payload.data.durl) ? payload.data.durl[0] : null;
  if (!durl?.url) {
    throw new ParseError(
      "BILIBILI_MP4_NOT_FOUND",
      "No direct HTML5 MP4 source was returned for this Bilibili video.",
      502,
      {
        qn,
        cid,
      },
    );
  }

  return payload.data;
}

function normalizeBilibiliSources(playDataList, pageInfo) {
  const seen = new Set();
  const sources = [];

  for (const playData of playDataList) {
    const durl = Array.isArray(playData.durl) ? playData.durl[0] : null;
    if (!durl?.url || seen.has(durl.url)) {
      continue;
    }

    seen.add(durl.url);
    const quality = Number(playData.quality) || null;

    sources.push({
      id: quality ? `qn_${quality}` : `source_${sources.length + 1}`,
      kind: "video",
      label: buildBilibiliQualityLabel(playData, quality),
      watermark: "unknown",
      url: durl.url,
      width: pageInfo.width,
      height: pageInfo.height,
      durationMs: Number(playData.timelength) || pageInfo.durationMs || null,
      sizeBytes: durl.size || null,
      quality,
      format: playData.format || null,
      videoId: pageInfo.cid,
      backupUrls: Array.isArray(durl.backup_url) ? durl.backup_url : [],
    });
  }

  return sources.sort((left, right) => (right.quality || 0) - (left.quality || 0));
}

function normalizeBilibiliDetail({
  viewData,
  pageInfo,
  pageUrl,
  sourceUrl,
  playDataList,
  includeDebug,
  requestedPage,
}) {
  const bvid = String(viewData.bvid || "").trim();
  const aid = String(viewData.aid || "").trim();
  const resourceId = bvid || aid;
  const sources = normalizeBilibiliSources(playDataList, pageInfo);

  const detail = {
    platform: "bilibili",
    resourceId,
    awemeId: resourceId,
    bvid,
    aid,
    page: pageInfo.page,
    part: pageInfo.part,
    pagesCount: pageInfo.pagesCount,
    mediaType: "video",
    title: String(viewData.title || "").trim(),
    description: String(viewData.desc || "").trim(),
    author: {
      uid: String(viewData.owner?.mid || ""),
      secUid: "",
      nickname: String(viewData.owner?.name || "").trim(),
      avatar: viewData.owner?.face || "",
    },
    cover: viewData.pic || "",
    durationMs: pageInfo.durationMs || null,
    statistics: normalizeStatistics(viewData.stat),
    sharePage: {
      sourceUrl: sourceUrl || pageUrl,
      pageUrl,
    },
    sources,
    images: [],
    rawType: "video",
    cid: pageInfo.cid,
  };

  if (includeDebug) {
    detail.debug = {
      requestedPage,
      selectedPage: pageInfo.page,
      cid: pageInfo.cid,
      qualities: playDataList.map((item) => item.quality),
      supportFormats: playDataList[0]?.support_formats || [],
    };
  }

  return detail;
}

async function fetchBilibiliWorkDetail(input, options = {}) {
  const includeDebug = options.includeDebug === true;
  const logger = options.logger;
  const resolvedUrl = String(input.resolvedUrl || "").trim();
  const idsFromUrl = resolvedUrl ? _internal.extractBilibiliIdsFromUrl(resolvedUrl) : null;
  const bvid = String(input.bvid || idsFromUrl?.bvid || "").trim();
  const aid = String(input.aid || idsFromUrl?.aid || "").trim();
  const fallbackResourceId = String(input.awemeId || input.resourceId || "").trim();
  const resolvedBvid = bvid || (/^BV[0-9A-Z]+$/iu.test(fallbackResourceId) ? fallbackResourceId : "");
  const resolvedAid = aid || (!resolvedBvid && /^\d+$/u.test(fallbackResourceId) ? fallbackResourceId : "");
  const requestedPage =
    normalizePositiveInteger(input.page, null) ||
    normalizePositiveInteger(idsFromUrl?.page, null) ||
    1;

  if (!resolvedBvid && !resolvedAid) {
    throw new ParseError("MISSING_BILIBILI_ID", "A Bilibili bvid or aid is required.");
  }

  const initialPageUrl = buildBilibiliPageUrl({
    bvid: resolvedBvid,
    aid: resolvedAid,
    page: requestedPage,
  });

  logger?.info("detail.fetch.start", {
    platform: "bilibili",
    resourceId: resolvedBvid || resolvedAid,
    requestedPage,
  });

  const viewData = await fetchBilibiliViewData({
    bvid: resolvedBvid,
    aid: resolvedAid,
    pageUrl: initialPageUrl,
    logger,
  });

  const pageInfo = pickBilibiliPage(viewData, requestedPage);
  const pageUrl = buildBilibiliPageUrl({
    bvid: viewData.bvid,
    aid: viewData.bvid ? "" : String(viewData.aid || ""),
    page: pageInfo.page,
  });

  const initialPlayData = await fetchBilibiliPlayData({
    bvid: viewData.bvid,
    aid: String(viewData.aid || ""),
    cid: pageInfo.cid,
    qn: 127,
    pageUrl,
    logger,
  });

  const qualityCandidates = Array.from(
    new Set([
      ...(Array.isArray(initialPlayData.accept_quality)
        ? initialPlayData.accept_quality
        : []),
      initialPlayData.quality,
    ].filter((item) => Number.isFinite(Number(item)))),
  )
    .map((item) => Number(item))
    .sort((left, right) => right - left);

  const playDataList = [initialPlayData];

  for (const quality of qualityCandidates) {
    if (Number(quality) === Number(initialPlayData.quality)) {
      continue;
    }

    try {
      const playData = await fetchBilibiliPlayData({
        bvid: viewData.bvid,
        aid: String(viewData.aid || ""),
        cid: pageInfo.cid,
        qn: quality,
        pageUrl,
        logger,
      });
      playDataList.push(playData);
    } catch (error) {
      logger?.warn("detail.fetch.bilibili_quality_skipped", {
        resourceId: viewData.bvid || String(viewData.aid || ""),
        cid: pageInfo.cid,
        quality,
        error,
      });
    }
  }

  const detail = normalizeBilibiliDetail({
    viewData,
    pageInfo,
    pageUrl,
    sourceUrl: resolvedUrl || initialPageUrl,
    playDataList,
    includeDebug,
    requestedPage,
  });

  logger?.info("detail.fetch.success", {
    platform: "bilibili",
    resourceId: detail.resourceId,
    page: detail.page,
    sourceCount: detail.sources.length,
  });

  return detail;
}

async function fetchWorkDetail(input, options = {}) {
  const platform = inferPlatform(input);

  if (platform === "douyin") {
    return fetchDouyinWorkDetail(input, options);
  }

  if (platform === "bilibili") {
    return fetchBilibiliWorkDetail(input, options);
  }

  throw new ParseError(
    "UNSUPPORTED_PLATFORM",
    "This detail endpoint only supports Douyin and Bilibili resources.",
    400,
    {
      platform,
    },
  );
}

module.exports = {
  fetchWorkDetail,
};
