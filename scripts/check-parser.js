const { parseShareText } = require("../src/services/parse-service");

const sample =
  "3.87 复制打开抖音，看看【小野猫史(日更版)的作品】当同事天天作秀内卷 # 猫meme# 小野猫史# https://v.douyin.com/oCzaAxEP5vk/ M@W.ZM GvF:/ 04/16";

async function main() {
  const result = await parseShareText(sample, {
    resolveRedirect: false,
    includeDebug: true,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
