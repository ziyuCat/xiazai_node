# 万能下载器后端

一个最小可运行的后端原型，当前先实现第一步能力：

- `POST /api/parse`，解析抖音分享文案
- `POST /api/detail`，根据作品 ID 抓取作品详情
- `POST /api/download/prepare`，生成短期下载票据
- `GET /api/download/file/:ticket`，服务端中转回源下载
- `GET /`，打开调试用前端页面

它现在解决的是“把用户从抖音复制出来的一整段分享文本，整理成后端可继续处理的标准结构”。

这一步还不是完整下载服务，但已经把主链路前半段打通了：

1. 提取分享文案里的链接
2. 识别是否为抖音链接
3. 可选展开短链跳转
4. 提取标题、分享口令、作品 ID
5. 返回统一 JSON，供后续详情抓取模块继续使用
6. 通过分享页 `window._ROUTER_DATA` 抓取作品详情
7. 通过下载票据生成可直连的小程序下载地址
8. 输出结构化日志，方便排查解析、详情和下载问题

## 目录结构

```text
download_tool/
├─ package.json
├─ README.md
├─ scripts/
│  └─ check-parser.js
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
└─ src/
   ├─ server.js
   └─ services/
      ├─ parse-service.js
      ├─ detail-service.js
      └─ download-service.js
```

## 环境要求

- Node.js `>= 20`

这个项目当前没有外部依赖，直接用 Node 内置模块就能跑。

## 配置文件

项目支持根目录 `.env` 文件。

可以先复制一份示例：

```powershell
Copy-Item .env.example .env
```

示例内容：

```env
HOST=0.0.0.0
PORT=8787
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

字段说明：

- `HOST`: Node 监听地址
- `PORT`: Node 监听端口
- `PUBLIC_BASE_URL`: 返回给前端的公网访问地址，主要用于生成下载票据里的 `downloadUrl`

如果你部署到服务器公网 IP，比如：

```env
HOST=0.0.0.0
PORT=8787
PUBLIC_BASE_URL=http://你的公网IP:8787
```

如果后面接了域名和 HTTPS，建议改成：

```env
HOST=0.0.0.0
PORT=8787
PUBLIC_BASE_URL=https://api.xxx.com
```

## 快速开始

### 1. 启动服务

```powershell
node src/server.js
```

默认监听：

`http://0.0.0.0:8787`

也支持环境变量：

```powershell
$env:HOST="0.0.0.0"
$env:PORT="8787"
node src/server.js
```

### 2. 健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

预期返回：

```json
{
  "success": true,
  "data": {
    "service": "universal-downloader-backend",
    "status": "ok",
    "now": "2026-04-29T08:00:00.000Z"
  }
}
```

### 3. 打开前端页面

启动服务后，直接访问：

`http://127.0.0.1:8787/`

页面里已经串好了三步：

1. 粘贴分享文案并解析
2. 查看作品详情和资源列表
3. 生成下载票据并打开下载地址

## Docker 部署

项目已经补充 Docker 镜像构建文件：

- `Dockerfile`
- `.dockerignore`
- `Docker部署说明.md`

快速构建：

```powershell
docker build -t universal-downloader-backend:latest .
```

快速运行：

```powershell
docker run --name universal-downloader-backend `
  -p 8787:8787 `
  -e PUBLIC_BASE_URL=http://127.0.0.1:8787 `
  universal-downloader-backend:latest
```

完整说明见 `Docker部署说明.md`。

## 接口说明

### `POST /api/parse`

解析抖音分享文案，返回统一结果结构。

#### 请求体

```json
{
  "text": "3.87 复制打开抖音，看看【小野猫史(日更版)的作品】当同事天天作秀内卷 #猫meme #小野猫史 https://v.douyin.com/oCzaAxEP5vk/ M@W.ZM GvF:/ 04/16",
  "resolveRedirect": false,
  "includeDebug": true
}
```

#### 字段说明

- `text`: 必填，用户复制的完整分享文案
- `resolveRedirect`: 可选，默认 `true`
  作用：是否尝试展开短链跳转，生产环境建议开启
- `includeDebug`: 可选，默认 `false`
  作用：是否把跳转过程等调试信息返回给调用方
- `fetchMetadata`: 可选，默认 `false`
  作用：当解析出 `awemeId` 后，继续自动抓取作品详情

### `POST /api/detail`

根据 `awemeId` 抓取作品详情。

#### 请求体

```json
{
  "awemeId": "7346171450493127975",
  "typeHint": "video",
  "includeDebug": true
}
```

#### 字段说明

- `awemeId`: 必填，作品 ID
- `typeHint`: 可选，建议传 `video` 或 `note`
- `resolvedUrl`: 可选，如果你从 `/api/parse` 拿到了最终链接，可以一并传入，服务会自动推断作品类型
- `includeDebug`: 可选，默认 `false`

### `POST /api/download/prepare`

生成短期下载票据，并返回可直接下载的中转地址。

#### 请求体

```json
{
  "awemeId": "7346171450493127975",
  "typeHint": "video",
  "sourceId": "wm_default"
}
```

#### 字段说明

- `awemeId`: 必填，作品 ID
- `typeHint`: 可选，建议传 `video` 或 `note`
- `resolvedUrl`: 可选，用于辅助推断类型
- `sourceId`: 视频作品可选，指定下载哪个视频源
- `imageId`: 图文作品可选，指定下载哪一张图片

### `GET /api/download/file/:ticket`

服务端中转下载接口。

说明：

- 这个地址由 `POST /api/download/prepare` 返回
- 票据默认 10 分钟过期
- 过期后需要重新调用 `prepare`

## 示例

### PowerShell 调用示例

```powershell
$body = @{
  text = "3.87 复制打开抖音，看看【小野猫史(日更版)的作品】当同事天天作秀内卷 #猫meme #小野猫史 https://v.douyin.com/oCzaAxEP5vk/ M@W.ZM GvF:/ 04/16"
  resolveRedirect = $false
  includeDebug = $true
  fetchMetadata = $false
} | ConvertTo-Json

Invoke-RestMethod http://127.0.0.1:8787/api/parse `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

### `curl` 调用示例

```bash
curl -X POST "http://127.0.0.1:8787/api/parse" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "3.87 复制打开抖音，看看【小野猫史(日更版)的作品】当同事天天作秀内卷 #猫meme #小野猫史 https://v.douyin.com/oCzaAxEP5vk/ M@W.ZM GvF:/ 04/16",
    "resolveRedirect": false,
    "includeDebug": true
  }'
```

### 成功返回示例

下面这个示例对应“先不展开短链”的情况，所以 `awemeId` 可能为空，状态会是 `partial`。这很正常，说明第一段解析成功了，但还没进入作品详情抓取。

```json
{
  "success": true,
  "requestId": "e4d2f8d0-b434-4a50-a3e0-6cefe1fc0b6e",
  "data": {
    "parseId": "parse_1777420800000_a1b2c3d4",
    "platform": "douyin",
    "type": "unknown",
    "input": {
      "rawText": "3.87 复制打开抖音，看看【小野猫史(日更版)的作品】当同事天天作秀内卷 #猫meme #小野猫史 https://v.douyin.com/oCzaAxEP5vk/ M@W.ZM GvF:/ 04/16",
      "shareCode": "3.87",
      "shareUrl": "https://v.douyin.com/oCzaAxEP5vk/"
    },
    "resolved": {
      "finalUrl": "https://v.douyin.com/oCzaAxEP5vk/",
      "awemeId": "",
      "title": "小野猫史(日更版)的作品"
    },
    "status": "partial",
    "nextStep": "已提取链接，但还需要作品详情抓取模块补全信息",
    "debug": {
      "redirectInfo": {
        "finalUrl": "https://v.douyin.com/oCzaAxEP5vk/",
        "hops": [],
        "stoppedBy": "skipped"
      }
    }
  }
}
```

### 成功返回示例，已拿到作品 ID

如果 `resolveRedirect = true`，并且短链成功展开成类似 `/video/1234567890` 的最终链接，返回会更接近下面这样：

```json
{
  "success": true,
  "requestId": "7e01b4fd-e0cf-4d7a-bd0f-d2444e9d30f9",
  "data": {
    "parseId": "parse_1777420801234_d9e8f7a6",
    "platform": "douyin",
    "type": "video_or_note",
    "input": {
      "rawText": "3.87 复制打开抖音，看看【小野猫史(日更版)的作品】当同事天天作秀内卷 ...",
      "shareCode": "3.87",
      "shareUrl": "https://v.douyin.com/oCzaAxEP5vk/"
    },
    "resolved": {
      "finalUrl": "https://www.douyin.com/video/7488888888888888888",
      "awemeId": "7488888888888888888",
      "title": "小野猫史(日更版)的作品"
    },
    "status": "resolved",
    "nextStep": "可以继续调用作品详情抓取模块"
  }
}
```

### 详情抓取示例

```powershell
$body = @{
  awemeId = "7346171450493127975"
  typeHint = "video"
  includeDebug = $true
} | ConvertTo-Json

Invoke-RestMethod http://127.0.0.1:8787/api/detail `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

### 详情抓取成功返回示例

```json
{
  "success": true,
  "requestId": "80459758-5ac8-4c36-bd8e-2c3c3e489d96",
  "data": {
    "awemeId": "7346171450493127975",
    "mediaType": "video",
    "title": "TikTok短剧怎么挂链接？[2.0版] #短剧推广 #短剧出海 #海外短剧分销 #短剧",
    "description": "TikTok短剧怎么挂链接？[2.0版] #短剧推广 #短剧出海 #海外短剧分销 #短剧",
    "author": {
      "uid": "",
      "secUid": "MS4wLjABAAAAcY2DLlaGPgF2r7vdz2M5LuKYz7_nKzWJiwjP9nfxu_I",
      "nickname": "傻瓜推文",
      "avatar": "https://p11.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-i-c9aec8xkvj_33ab38f88f7b4c129df585ec700fae61.jpeg?from=327834062"
    },
    "cover": "https://p11-sign.douyinpic.com/...",
    "durationMs": 96712,
    "statistics": {
      "commentCount": 16,
      "diggCount": 191,
      "playCount": 0,
      "shareCount": 63,
      "collectCount": 179
    },
    "sharePage": {
      "sourceUrl": "https://www.iesdouyin.com/share/video/7346171450493127975/",
      "pageUrl": "https://www.iesdouyin.com/share/video/7346171450493127975/"
    },
    "sources": [
      {
        "id": "wm_default",
        "kind": "video",
        "label": "默认源",
        "watermark": "with_watermark",
        "url": "https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200fg10000cnpdeorc77ucrd4ng66g&ratio=720p&line=0"
      },
      {
        "id": "guess_nowm_default",
        "kind": "video",
        "label": "默认源(推测无水印)",
        "watermark": "unknown",
        "url": "https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200fg10000cnpdeorc77ucrd4ng66g&ratio=720p&line=0"
      }
    ],
    "images": [],
    "rawType": 4
  }
}
```

### 下载票据示例

```powershell
$body = @{
  awemeId = "7346171450493127975"
  typeHint = "video"
  sourceId = "wm_default"
} | ConvertTo-Json

Invoke-RestMethod http://127.0.0.1:8787/api/download/prepare `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

### 下载票据返回示例

```json
{
  "success": true,
  "requestId": "1bbac3ff-3207-4bbf-8e8b-3ec0c9be8930",
  "data": {
    "ticket": "dl_7a82e4a23a0246ad926e9abdb6bcbe7a",
    "awemeId": "7346171450493127975",
    "mediaType": "video",
    "assetType": "video",
    "assetId": "wm_default",
    "fileName": "TikTok短剧怎么挂链接？[2.0版] #短剧推广 #短剧出海 #海外短剧分销 #短剧-默认源.mp4",
    "expiresAt": 1777434000000,
    "downloadUrl": "http://127.0.0.1:8787/api/download/file/dl_7a82e4a23a0246ad926e9abdb6bcbe7a",
    "source": {
      "label": "默认源",
      "contentTypeHint": "video/mp4"
    }
  }
}
```

## 返回字段说明

### 顶层字段

- `success`: 是否成功
- `requestId`: 本次请求 ID，方便排查问题
- `data`: 成功时的业务数据
- `error`: 失败时的错误信息

### `data` 字段

- `parseId`: 本次解析任务 ID
- `platform`: 当前识别出的平台，当前只支持 `douyin`
- `type`: 当前识别出的内容类型
  - `unknown`: 还没拿到作品 ID
  - `video_or_note`: 已拿到作品 ID，但还没区分视频还是图文
- `input.rawText`: 原始分享文案
- `input.shareCode`: 分享口令，比如 `3.87`
- `input.shareUrl`: 从文案中挑出来的目标链接
- `resolved.finalUrl`: 展开短链后的最终链接
- `resolved.awemeId`: 从最终链接或查询参数里提取出的作品 ID
- `resolved.title`: 从分享文案里提取出的标题
- `status`: 当前解析状态
  - `partial`: 只完成了文本和链接解析
  - `resolved`: 已拿到作品 ID
- `nextStep`: 给后续业务层看的提示
- `debug.redirectInfo`: 调试信息，仅在 `includeDebug = true` 时返回

## 常见错误示例

### 1. 没传文案

```json
{
  "success": false,
  "error": {
    "code": "EMPTY_TEXT",
    "message": "请输入抖音分享文案",
    "details": null
  }
}
```

### 2. 文案里没有链接

```json
{
  "success": false,
  "error": {
    "code": "NO_URL_FOUND",
    "message": "未在文案中找到可解析链接",
    "details": null
  }
}
```

### 3. 不是抖音链接

```json
{
  "success": false,
  "error": {
    "code": "UNSUPPORTED_PLATFORM",
    "message": "当前版本仅支持抖音链接",
    "details": {
      "selectedUrl": "https://example.com/demo",
      "platform": "unknown"
    }
  }
}
```

## 本地自检

可以直接跑内置样例脚本：

```powershell
node scripts/check-parser.js
node scripts/check-detail.js
node scripts/check-download-prepare.js
```

这个脚本会使用一段抖音分享文案做解析，并打印结果。

## 日志说明

服务现在会输出 JSON 结构化日志，适合直接接终端查看，也适合后面接 ELK、Loki 或云日志平台。

常见事件：

- `parse.start` / `parse.success`
- `parse.redirect.start` / `parse.redirect.success` / `parse.redirect.failed`
- `detail.fetch.start` / `detail.fetch.success` / `detail.fetch.attempt_failed`
- `download.prepare.start` / `download.prepare.success`
- `download.proxy.start` / `download.proxy.headers_ready` / `download.proxy.upstream_failed`

日志里重点会带这些字段：

- `requestId`: 单次请求 ID
- `route`: 当前接口
- `awemeId`: 作品 ID
- `sourceUrl` / `finalUrl`: 解析或抓取过程中涉及的关键 URL
- `assetType` / `assetId`: 下载层选中的资源
- `error`: 失败时的错误对象

这样你后面看线上问题时，能很快分清是：

1. 文案没解析出来
2. 短链没展开出来
3. 页面里没拿到详情
4. 上游下载地址挂了

## 当前能力边界

### 已实现

1. 提取分享文案中的 URL
2. 识别是否为抖音链接
3. 可选展开短链跳转
4. 提取作品标题
5. 提取分享口令
6. 从最终链接中提取作品 ID
7. 返回统一结构，供后续模块继续处理
8. 根据 `awemeId` 抓取作品标题、作者、封面、统计信息
9. 区分视频和图文作品
10. 生成第一版候选媒体源列表
11. 生成短期下载票据和中转下载地址

### 未实现

1. 历史记录
2. 限流和鉴权
3. 更稳定的无水印源判定
4. 下载进度、断点续传、失败重试
5. 对象存储缓存和下载加速

## 下一步建议

最自然的下一步是把当前下载票据层继续做厚一点：

1. 加限流和票据签名
2. 给下载地址接对象存储缓存
3. 给小程序端补下载进度和失败重试
4. 把服务端日志打到“解析失败 / 下载失败 / 上游失效”三类指标
