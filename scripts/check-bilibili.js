const { parseShareText } = require("../src/services/parse-service");
const { fetchWorkDetail } = require("../src/services/detail-service");
const { prepareDownload } = require("../src/services/download-service");

const sample =
  "【腾势Z9GT怎么样？车不错但销量差-哔哩哔哩】 https://b23.tv/6oZ4Dxw";

async function main() {
  const parsed = await parseShareText(sample, {
    resolveRedirect: true,
    includeDebug: false,
  });

  const detail = await fetchWorkDetail(
    {
      platform: parsed.platform,
      resourceId: parsed.resolved.resourceId,
      awemeId: parsed.resolved.awemeId,
      bvid: parsed.resolved.bvid,
      aid: parsed.resolved.aid,
      page: parsed.resolved.page,
      resolvedUrl: parsed.resolved.finalUrl,
      typeHint: parsed.resolved.resourceTypeHint,
    },
    {
      includeDebug: false,
    },
  );

  const download = await prepareDownload({
    platform: detail.platform,
    resourceId: detail.resourceId,
    awemeId: detail.awemeId,
    bvid: detail.bvid,
    aid: detail.aid,
    page: detail.page,
    typeHint: detail.mediaType,
    sourceId: detail.sources[0]?.id,
  });

  console.log(
    JSON.stringify(
      {
        parsed,
        detail: {
          platform: detail.platform,
          resourceId: detail.resourceId,
          bvid: detail.bvid,
          aid: detail.aid,
          page: detail.page,
          title: detail.title,
          author: detail.author.nickname,
          sourceCount: detail.sources.length,
          firstSource: detail.sources[0],
        },
        download,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
