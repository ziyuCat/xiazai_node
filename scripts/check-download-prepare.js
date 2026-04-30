const { prepareDownload } = require("../src/services/download-service");

async function main() {
  const result = await prepareDownload({
    awemeId: "7346171450493127975",
    typeHint: "video",
    sourceId: "wm_default",
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
