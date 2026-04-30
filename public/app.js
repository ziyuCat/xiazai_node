const SAMPLE_TEXT =
  "3.87 复制打开抖音，看看【小野猫史(日更版)的作品】当同事天天作秀内卷 #猫meme #小野猫史 https://v.douyin.com/oCzaAxEP5vk/ M@W.ZM GvF:/ 04/16";

const state = {
  parseResult: null,
  detailResult: null,
  downloadResult: null,
};

const elements = {
  shareText: document.getElementById("share-text"),
  resolveRedirect: document.getElementById("resolve-redirect"),
  includeDebug: document.getElementById("include-debug"),
  fetchMetadata: document.getElementById("fetch-metadata"),
  parseButton: document.getElementById("parse-button"),
  clearButton: document.getElementById("clear-button"),
  fillSampleButton: document.getElementById("fill-sample"),
  refreshDetailButton: document.getElementById("refresh-detail"),
  prepareDownloadButton: document.getElementById("prepare-download"),
  statusBar: document.getElementById("status-bar"),
  parseSummary: document.getElementById("parse-summary"),
  detailSummary: document.getElementById("detail-summary"),
  downloadSummary: document.getElementById("download-summary"),
  parseJson: document.getElementById("parse-json"),
  detailJson: document.getElementById("detail-json"),
  downloadJson: document.getElementById("download-json"),
  resourcePicker: document.getElementById("resource-picker"),
  resourceSelect: document.getElementById("resource-select"),
};

function setStatus(message, tone = "normal") {
  elements.statusBar.textContent = message;
  elements.statusBar.style.background =
    tone === "error"
      ? "rgba(214, 77, 77, 0.12)"
      : tone === "warning"
        ? "rgba(255, 182, 77, 0.18)"
        : "rgba(18, 185, 95, 0.08)";
  elements.statusBar.style.color =
    tone === "error" ? "#a63232" : tone === "warning" ? "#8b5a0b" : "#06914a";
}

function setJson(target, value) {
  target.textContent = value ? JSON.stringify(value, null, 2) : "等待返回...";
  target.classList.toggle("empty-state", !value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildCover(url) {
  if (!url) {
    return "";
  }

  return `<img class="cover-preview" src="${escapeHtml(url)}" alt="封面预览" />`;
}

function renderParseSummary() {
  const data = state.parseResult;
  if (!data) {
    elements.parseSummary.className = "summary-card empty-state";
    elements.parseSummary.textContent = "还没有解析结果。";
    setJson(elements.parseJson, null);
    return;
  }

  elements.parseSummary.className = "summary-card";
  elements.parseSummary.innerHTML = `
    <h3>${escapeHtml(data.resolved.title || "未提取到标题")}</h3>
    <div class="summary-meta">
      <div><strong>平台：</strong>${escapeHtml(data.platform)}</div>
      <div><strong>状态：</strong>${escapeHtml(data.status)}</div>
      <div><strong>作品 ID：</strong>${escapeHtml(data.resolved.awemeId || "未提取")}</div>
      <div><strong>最终链接：</strong>${escapeHtml(data.resolved.finalUrl || data.input.shareUrl || "")}</div>
      <div><strong>类型提示：</strong>${escapeHtml(data.resolved.resourceTypeHint || data.type)}</div>
    </div>
    <div class="pill-row">
      <span class="pill">分享口令 ${escapeHtml(data.input.shareCode || "无")}</span>
      <span class="pill">文案长度 ${String(data.input.rawText.length)}</span>
    </div>
  `;

  setJson(elements.parseJson, data);
}

function renderDetailSummary() {
  const data = state.detailResult;
  if (!data) {
    elements.detailSummary.className = "summary-card empty-state";
    elements.detailSummary.textContent = "解析出作品 ID 后，这里会展示标题、作者、封面和资源列表。";
    elements.resourcePicker.classList.add("hidden");
    elements.resourceSelect.innerHTML = "";
    setJson(elements.detailJson, null);
    return;
  }

  elements.detailSummary.className = "summary-card";
  elements.detailSummary.innerHTML = `
    <h3>${escapeHtml(data.title || "未提取到标题")}</h3>
    <div class="summary-meta">
      <div><strong>作者：</strong>${escapeHtml(data.author.nickname || "未知作者")}</div>
      <div><strong>类型：</strong>${escapeHtml(data.mediaType)}</div>
      <div><strong>作品 ID：</strong>${escapeHtml(data.awemeId)}</div>
      <div><strong>视频源：</strong>${String(data.sources.length)} 个</div>
      <div><strong>图片：</strong>${String(data.images.length)} 张</div>
    </div>
    <div class="pill-row">
      ${data.durationMs ? `<span class="pill">时长 ${Math.round(data.durationMs / 1000)}s</span>` : ""}
      <span class="pill">点赞 ${String(data.statistics.diggCount)}</span>
      <span class="pill">评论 ${String(data.statistics.commentCount)}</span>
    </div>
    ${buildCover(data.cover)}
  `;

  const options = data.mediaType === "video" ? data.sources : data.images;
  if (options.length > 0) {
    elements.resourcePicker.classList.remove("hidden");
    elements.resourceSelect.innerHTML = options
      .map((item) => {
        const label =
          data.mediaType === "video"
            ? `${item.id} | ${item.label || "未命名视频源"}`
            : `${item.id} | ${item.width || "?"}x${item.height || "?"}`;
        return `<option value="${escapeHtml(item.id)}">${escapeHtml(label)}</option>`;
      })
      .join("");
  } else {
    elements.resourcePicker.classList.add("hidden");
    elements.resourceSelect.innerHTML = "";
  }

  setJson(elements.detailJson, data);
}

function renderDownloadSummary() {
  const data = state.downloadResult;
  if (!data) {
    elements.downloadSummary.className = "download-card empty-state";
    elements.downloadSummary.textContent = "先完成解析并获取详情，再生成下载票据。";
    setJson(elements.downloadJson, null);
    return;
  }

  elements.downloadSummary.className = "download-card";
  elements.downloadSummary.innerHTML = `
    <h3>${escapeHtml(data.fileName)}</h3>
    <div class="download-meta">
      <div><strong>票据：</strong>${escapeHtml(data.ticket)}</div>
      <div><strong>资源类型：</strong>${escapeHtml(data.assetType)}</div>
      <div><strong>资源 ID：</strong>${escapeHtml(data.assetId)}</div>
      <div><strong>过期时间：</strong>${new Date(data.expiresAt).toLocaleString()}</div>
    </div>
    <div class="action-row">
      <a class="link-button" href="${escapeHtml(data.downloadUrl)}" target="_blank" rel="noreferrer">
        打开下载地址
      </a>
    </div>
  `;

  setJson(elements.downloadJson, data);
}

async function requestJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    const error = data.error || { message: `请求失败: ${response.status}` };
    throw new Error(error.message);
  }

  return data.data;
}

function buildDetailPayloadFromState() {
  const parse = state.parseResult;
  if (!parse || !parse.resolved.awemeId) {
    throw new Error("还没有拿到 awemeId，请先完成解析。");
  }

  return {
    awemeId: parse.resolved.awemeId,
    resolvedUrl: parse.resolved.finalUrl,
    typeHint: parse.resolved.resourceTypeHint,
    includeDebug: elements.includeDebug.checked,
  };
}

async function handleParse() {
  const text = elements.shareText.value.trim();
  if (!text) {
    setStatus("先贴一段分享文案。", "warning");
    return;
  }

  setStatus("正在解析分享文案...", "normal");
  elements.parseButton.disabled = true;

  try {
    const result = await requestJson("/api/parse", {
      text,
      resolveRedirect: elements.resolveRedirect.checked,
      includeDebug: elements.includeDebug.checked,
      fetchMetadata: elements.fetchMetadata.checked,
    });

    state.parseResult = result;
    state.detailResult = result.metadata || null;
    state.downloadResult = null;
    renderParseSummary();
    renderDetailSummary();
    renderDownloadSummary();

    setStatus(
      result.metadata
        ? "解析和详情抓取都完成了，可以直接生成下载地址。"
        : "解析完成了，接下来可以单独抓作品详情。",
      "normal",
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.parseButton.disabled = false;
  }
}

async function handleRefreshDetail() {
  try {
    const payload = buildDetailPayloadFromState();
    setStatus("正在刷新作品详情...", "normal");
    elements.refreshDetailButton.disabled = true;

    const result = await requestJson("/api/detail", payload);
    state.detailResult = result;
    state.downloadResult = null;
    renderDetailSummary();
    renderDownloadSummary();
    setStatus("详情刷新完成，现在可以选资源生成下载地址。", "normal");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.refreshDetailButton.disabled = false;
  }
}

async function handlePrepareDownload() {
  if (!state.detailResult) {
    setStatus("先拿到作品详情，再生成下载地址。", "warning");
    return;
  }

  const resourceId = elements.resourceSelect.value;
  const payload = {
    awemeId: state.detailResult.awemeId,
    typeHint: state.detailResult.mediaType,
  };

  if (state.detailResult.mediaType === "video") {
    payload.sourceId = resourceId;
  } else {
    payload.imageId = resourceId;
  }

  setStatus("正在生成下载票据...", "normal");
  elements.prepareDownloadButton.disabled = true;

  try {
    const result = await requestJson("/api/download/prepare", payload);
    state.downloadResult = result;
    renderDownloadSummary();
    setStatus("下载票据已生成，可以直接打开下载地址。", "normal");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.prepareDownloadButton.disabled = false;
  }
}

function clearAll() {
  elements.shareText.value = "";
  state.parseResult = null;
  state.detailResult = null;
  state.downloadResult = null;
  renderParseSummary();
  renderDetailSummary();
  renderDownloadSummary();
  setStatus("输入和结果都清空了。", "normal");
}

function bindEvents() {
  elements.fillSampleButton.addEventListener("click", () => {
    elements.shareText.value = SAMPLE_TEXT;
    setStatus("示例文案已填充，点“开始解析”就行。", "normal");
  });
  elements.parseButton.addEventListener("click", handleParse);
  elements.clearButton.addEventListener("click", clearAll);
  elements.refreshDetailButton.addEventListener("click", handleRefreshDetail);
  elements.prepareDownloadButton.addEventListener("click", handlePrepareDownload);
}

function init() {
  bindEvents();
  renderParseSummary();
  renderDetailSummary();
  renderDownloadSummary();
}

init();
