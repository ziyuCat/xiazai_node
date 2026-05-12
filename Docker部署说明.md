# Docker 部署说明

本文档说明如何把当前项目构建成 Docker 镜像，并通过容器运行服务。

## 1. 前提条件

- 已安装 Docker
- 项目根目录为 `D:\demo_code\xiazai_node`

## 2. 构建镜像

在项目根目录执行：

```powershell
docker build -t universal-downloader-backend:latest .
```

构建完成后，可以用下面命令确认镜像存在：

```powershell
docker images universal-downloader-backend
```

## 3. 启动容器

### 本机调试

如果只是本机通过 `http://127.0.0.1:8787` 访问：

```powershell
docker run --name universal-downloader-backend `
  -p 8787:8787 `
  -e PUBLIC_BASE_URL=http://127.0.0.1:8787 `
  universal-downloader-backend:latest
```

### 局域网 / 服务器访问

如果前端、小程序或其他客户端要从局域网 IP、服务器公网 IP 或域名访问服务，`PUBLIC_BASE_URL` 要改成外部可访问地址，例如：

```powershell
docker run --name universal-downloader-backend `
  -p 8787:8787 `
  -e PUBLIC_BASE_URL=https://api.example.com `
  universal-downloader-backend:latest
```

原因是 `POST /api/download/prepare` 返回的 `downloadUrl` 会基于 `PUBLIC_BASE_URL` 生成。

## 4. 使用环境变量文件

也可以先准备一个环境变量文件，例如 `docker.env`：

```env
HOST=0.0.0.0
PORT=8787
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

然后启动：

```powershell
docker run --name universal-downloader-backend `
  --env-file docker.env `
  -p 8787:8787 `
  universal-downloader-backend:latest
```

## 5. 健康检查

容器启动后，可以验证服务状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

预期返回：

```json
{
  "success": true,
  "data": {
    "service": "universal-downloader-backend",
    "status": "ok"
  }
}
```

也可以查看容器健康状态：

```powershell
docker ps
```

## 6. 常用运维命令

查看日志：

```powershell
docker logs -f universal-downloader-backend
```

停止容器：

```powershell
docker stop universal-downloader-backend
```

删除容器：

```powershell
docker rm universal-downloader-backend
```

## 7. 镜像内容说明

当前镜像特点：

- 基于 `node:20-alpine`
- 只复制运行所需的 `package.json`、`src/`、`public/`
- 以非 root 用户 `node` 运行
- 暴露端口 `8787`
- 内置 `/health` 健康检查

## 8. 注意事项

1. 当前服务没有把下载票据持久化，容器重启后，已签发但未过期的票据会失效。
2. 如果部署在反向代理后面，请把 `PUBLIC_BASE_URL` 配置成最终对外访问地址。
3. 当前项目没有第三方 npm 依赖，所以镜像构建过程不需要执行 `npm install`。
