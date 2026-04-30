const { fetchWorkDetail } = require("../src/services/detail-service");

async function main() {
  const detail = await fetchWorkDetail(
    {
      awemeId: "7346171450493127975",
      typeHint: "video",
    },
    {
      includeDebug: true,
    },
  );

  console.log(JSON.stringify(detail, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
