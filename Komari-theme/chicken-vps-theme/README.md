# Komari 养鸡场主题模板

把监控节点变成 3D 小鸡：在线节点在农场里活动，CPU 越高体型越大；离线节点会倒地；访客可以移动、扇翅和互啄。

本目录把下载的 Chicken VPS 项目拆成两部分：

```text
Komari Monitor
└─ dist/                         # 安装到 Komari 的静态主题
   ├─ index.html
   ├─ style.css
   ├─ js/                        # Three.js 客户端
   ├─ shared/physics.js
   └─ vendor/three.module.js

伴生服务                       # 独立 Node.js 进程
└─ bridge/
   ├─ server/                   # 权威游戏循环、探针轮询、WebSocket
   ├─ shared/physics.js
   └─ config.json               # 仅服务端可见，勿提交
```

## 为什么需要伴生服务

Komari 主题 ZIP 只能包含 `komari-theme.json` 和 `dist/` 静态资源，不能注册新的服务端路由或 WebSocket endpoint。主题负责画面、输入和 HUD；伴生服务负责以下权威状态：

- 玩家移动、碰撞、血量、攻击冷却和互啄结果；
- 访客断线重连与短期战绩；
- ServerStatus、哪吒 V1、Komari 等探针的服务端轮询；
- 探针凭据和私有源配置。

因此，**只安装主题 ZIP 不会自动获得多人互啄**。需要同时部署 `bridge/`。

## 功能

- Three.js 低多边形鸡场和程序化鸡模型；
- Komari 节点状态映射：在线、离线、CPU、内存、磁盘、流量、运行时间；
- CPU 超过阈值时探针鸡更活跃，体型随负载变化；
- 访客权威移动、 peck、扇翅、血量和排行榜；
- 桌面键鼠、Pointer Lock、触屏摇杆和动作按钮；
- 多探针源并行轮询与逐源错误提示；
- Komari 主题托管设置与深浅色环境适配；
- 没有伴生服务时进入本地模式，仍可浏览鸡场和本地移动。

## 支持的探针

伴生服务保留原项目的统一节点模型和自动识别流程：

| `kind` | 面板/协议 | 主要接口 |
| --- | --- | --- |
| `serverstatus` | ServerStatus | `/json/stats.json` |
| `nezha` | 哪吒 V1 | `/api/v1/service`、V1 列表或 WebSocket |
| `komari` | Komari | `/api/nodes`、`/api/rpc2` |
| `minimal` | 极简探针 | `/api/nodes` |
| `nodeget` | NodeGet | `/config.json` + 后端 JSON-RPC |
| `nodeflare` | NodeFlare | `/api/bootstrap` |
| `cf` | Cloudflare Server Monitor | `/api/servers` |
| `cfvpsmon` | CF VPS Monitor | `/api/live/clients` |
| 省略或 `auto` | 自动识别上述类型 | 从面板域名探测 |

`auto` 是协议猜测，不保证兼容经过大幅修改、需要登录或已经关闭公开 API 的面板。无法识别时才使用通用字段嗅探。

NodeGet 的后端 URL 和面板声明的跨域 `apiBase` 属于服务端主动访问的远程目标，模板默认关闭跟随；即使显式打开，也必须同时在 `probe.security.apiBaseOrigins` / `nodegetBackendOrigins` 列出明确的 Origin，否则不会跟随。

## 环境要求

- Node.js 22 或更高版本（建议使用仍受支持的 LTS）；
- 一个可被浏览器访问的伴生服务地址；
- 非回环地址必须使用 `wss://`（即使页面本身是 HTTP），并在反向代理中正确转发 WebSocket Upgrade；
- 伴生服务能够访问所配置的探针面板。

## 本地运行

```bash
cd Komari-theme/chicken-vps-theme
npm ci --ignore-scripts
umask 077
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json
```

编辑 `bridge/config.json`，至少配置一个探针源。Komari 公共面板示例：

```json
{
  "name": "Komari",
  "url": "https://monitor.example.com",
  "kind": "komari",
  "timeout": 12000
}
```

本地开发时把主题来源加入 `allowedOrigins`：

```json
{
  "allowedOrigins": [
    "http://127.0.0.1:4173",
    "https://monitor.example.com"
  ]
}
```

分别启动伴生服务和主题预览：

```bash
# 终端 1
npm run bridge

# 终端 2
npm run dev
```

打开：

```text
http://127.0.0.1:4173/?bridge=ws://127.0.0.1:3777/ws
```

`?bridge=` 只覆盖当前页面，不会写进 Komari 主题设置。

## 生产部署

### 1. 构建和检查

```bash
npm ci --ignore-scripts
npm test
npm run build
```

`npm run build` 会生成可安装的 `dist/`，并检查 Komari 要求的标题、描述和页脚占位符。

### 2. 启动伴生服务

生产配置放在 `bridge/config.json`。不要把带 Token 的配置提交到 Git；推荐使用环境变量：

```bash
export SERVER_STATUS_TOKEN='...'
export NEZHA_TOKEN='...'
node bridge/server/index.js
```

配置示例：

```json
{
  "name": "ServerStatus",
  "url": "https://status.example.com",
  "kind": "auto",
  "tokenEnv": "SERVER_STATUS_TOKEN",
  "timeout": 9000
}
```

建议通过 systemd、Docker 或进程管理器保持伴生服务运行，并只监听受控端口。

### 3. 配置 WebSocket 反向代理

Nginx 示例：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3777;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 75s;
}
```

伴生服务的 `allowedOrigins` 必须包含实际主题来源，例如 `https://monitor.example.com`。直接运行 Node 服务时默认只监听 `127.0.0.1`；只有通过受控反向代理或明确设置 `HOST=0.0.0.0`（Docker 已设置）才对外监听。

### 4. 打包主题

```bash
npm run package
```

输出：

```text
release/ChickenFarm-0.1.1.zip
SHA-256: dc5fe86e224ea8fec3c43b6b55daffccbd8a31d32eed5582fa2edaf147c1b762
```

在 Komari 后台安装该 ZIP，然后进入主题设置填写：

```text
wss://chicken.example.com/ws
```

主题设置会通过 `/api/public` 公开，因此 `bridge_url` 只能是公开服务地址，**不要填写任何 Token、私有管理 URL 或凭据**。

## 探针凭据

- Komari 内置适配器读取公开的 Guest API，不接受管理员 API Key；私有站点需要额外的受信任服务端集成；
- 探针 Token 只应放在伴生服务配置或环境变量中；
- `config.json` 建议权限设为 `0600`；
- 不要把伴生服务配置目录暴露成静态文件；
- 访客随机恢复令牌只用于短期重连，不是管理凭据。

### Docker Compose

在已准备好 `bridge/config.json` 后，可以直接使用模板自带的 Compose：

```bash
DOCKER_UID=$(id -u) DOCKER_GID=$(id -g) docker compose up -d --build
```

Compose 默认只把伴生服务绑定到 `127.0.0.1:3777`，由宿主机上的 Nginx/Caddy 反向代理提供 HTTPS 和 WebSocket。修改端口请设置 `BRIDGE_PORT`（Compose 的 `PORT` 会覆盖 `config.json` 中的端口）。Token 通过环境变量传入，`config.json` 只读挂载；不要把 `bridge/config.json` 提交到仓库。

### Docker run（不使用 Compose）

如果不想使用 Compose，可以在准备好配置后直接运行：

```bash
cd Komari-theme/chicken-vps-theme
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json
# 编辑 bridge/config.json，至少设置 allowedOrigins 和 probe.sources

docker build -t chicken-vps-bridge:0.1.1 .

docker run -d \\
  --name chicken-vps-bridge \\
  --restart unless-stopped \\
  --user "$(id -u):$(id -g)" \\
  --read-only \\
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \\
  --security-opt no-new-privileges:true \\
  --cap-drop ALL \\
  --publish 127.0.0.1:3777:3777 \\
  --env HOST=0.0.0.0 \\
  --env PORT=3777 \\
  --env CONFIG_PATH=/app/bridge/config.json \\
  --env-file .env \\
  --volume "$(pwd)/bridge/config.json:/app/bridge/config.json:ro" \\
  chicken-vps-bridge:0.1.1
```

`.env` 只放 `SERVER_STATUS_TOKEN`、`NEZHA_TOKEN` 等伴生服务变量，并设置 `chmod 600 .env`；没有探针 Token 时可以省略 `--env-file .env`。不要使用 `--privileged`、`--network host`，也不要把整个 `bridge/` 目录挂进容器；不要把 `DOCKER_UID`/`DOCKER_GID` 或 `--user` 设置为 `0`。

检查和更新：

```bash
curl http://127.0.0.1:3777/health
docker logs -f chicken-vps-bridge

# 修改 config.json 后
docker restart chicken-vps-bridge

# 更新镜像时先重新 build，再删除旧容器并重新执行上面的 docker run
```


### 使用 GitHub Actions 构建镜像

仓库中的 `.github/workflows/chicken-vps-bridge.yml` 会在以下情况自动构建 Bridge 镜像：

- 推送到 `main`
- 手动触发 Actions，并可填写 `image_tag`
- Pull Request 只构建验证，不推送镜像

镜像发布到 GitHub Container Registry：

```text
ghcr.io/cnprobe/chicken-vps-bridge:latest
```

服务器无需安装 Node.js，只需拉取镜像：

```bash
docker pull ghcr.io/cnprobe/chicken-vps-bridge:latest
```

然后把上一节 `docker run` 命令末尾的镜像名替换为：

```text
ghcr.io/cnprobe/chicken-vps-bridge:latest
```

GHCR 包如果设为 Public，服务器可以直接匿名拉取。如果保持 Private，先使用具有 `read:packages` 权限的 GitHub PAT 登录：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

该工作流使用 GitHub Actions 内置 `GITHUB_TOKEN` 推送 GHCR，不需要在仓库 Secrets 中额外保存 Docker Hub 密码。该工作流只构建 Bridge 镜像；主题 ZIP 仍按上面的 `npm run package` 流程或 Release 产物上传到 Komari。

下载的 `.run` 是“Shell 引导器 + gzip tar”自解压包。模板制作过程中只下载和静态拆包，没有执行原安装器。原安装器会以 root 创建 systemd 服务，并从可配置镜像下载 Node；不建议用它部署生产环境。下载文件信息：

```text
URL:    https://down.ggboom.de/chicken-vps-main/chicken-vps-20260924.run
SHA256: 2817e8343e8fa74ce3849624cd86840847e4fd876a0767b67285d5436a1af103
```

伴生服务只提供 `/health` 和 `/ws`，不提供静态页面；3D 页面由 Komari 主题 ZIP 提供。这样可以缩小桥接服务的 HTTP 攻击面。

伴生服务默认**不会把访客 IP 发送到第三方 GeoIP 服务**；没有本地 GeoLite2 数据库时，国旗/ASN 留空。若管理员显式设置 `geo.externalLookup: true`，访客公网 IP 才会发送到配置的 HTTPS 服务（`ipwho.is` / `ipapi.co`），请先取得合规授权。

伴生服务包含可选的远程 API 自动发现功能。模板默认限制跨源 `apiBase` 和 NodeGet 后端跟随；即使显式打开开关，也必须同时在 `probe.security.apiBaseOrigins` / `nodegetBackendOrigins` 列出明确的 Origin，否则不会跟随。不要对不可信面板启用远程跳转。

公网部署还应配置：

- **不要把私有监控面板接入公开桥接服务**：WebSocket 只有 Origin 校验，没有账号认证；节点名称、在线状态和监控数值会广播给所有能连接的人。来源 URL/原始错误已默认脱敏，但统计内容仍应视为公开数据。
- WebSocket Origin 白名单；
- 反向代理连接数、请求速率和空闲超时限制；
- `maxPlayers`；
- `maxProbeChicks`（默认 200，限制异常探针响应制造大量 NPC）；
- `maxNpcEntities`（默认 500，限制场上 NPC 总数）；
- `maxHandshakesPerMinute`（默认 60；反向代理后的共享 IP 应配置可信代理 CIDR，必要时再调高）；
- `exposeVisitorGeo`（默认 `false`，不向其他访客广播访客国家/ASN；需要时显式开启）；
- 只有在 `trustedProxyCidrs` 明确列出反向代理网段时，才会信任 `CF-Connecting-IP` / `X-Forwarded-For`；
- 定期备份 `bridge/config.json`；
- 监控伴生服务日志和资源占用。

更完整的数据流、信任边界和部署检查见 [`SECURITY.md`](./SECURITY.md)。当前游戏状态保存在内存中，服务重启后会清空。模板适合小规模公开互动；如果要跨实例组队、持久排行或商业化防作弊，需要额外的认证票据、持久化和限流服务。

## 来源与再分发

本目录基于 2026-09-24 公开下载包直接复制并改造，来源和校验值见 [`NOTICE.md`](./NOTICE.md)。原下载包未包含许可证文件；当前复制依据仓库维护者在工作会话中明确给出的复制授权。对外发布或进入 Komari 主题市场前，应再次确认上游版权和发布授权。
