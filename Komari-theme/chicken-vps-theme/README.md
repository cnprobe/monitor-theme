# Komari 养鸡场

单 ZIP 监控主题，可选连接一个只负责多人游戏的极简 Bridge。

## 架构

```text
主题 ZIP
  ├─ 3D 场景、玩家控制、Komari 节点、名牌与音效
  ├─ 同源读取 /api/public 主题设置
  └─ 同源 POST /api/rpc2 读取当前 Komari 节点

可选多人 Bridge
  ├─ 玩家位置、碰撞、啄击与扇翅
  ├─ 血量、比分、排行榜与断线恢复
  └─ 可选大鹅 NPC
```

数据边界固定如下：

- 主题 ZIP 直接读取当前 Komari，不配置 Komari URL、API Key 或探针源。
- 公共 Komari 以 Guest 身份读取。
- 私有 Komari 使用浏览器现有的登录 Cookie 或临时分享 Cookie；最终权限由 Komari 判断。
- Komari 节点不会发送给 Bridge。
- ZIP 中的节点是只读展示实体，不参与 Bridge 碰撞、伤害、比分或排行榜。
- Bridge 只接受 `protocol: 2` 的玩家协议，不访问任何 Komari 上游。

## 单 ZIP 部署

只显示 Komari 节点和 3D 小鸡时，不需要 Bridge、Docker、`.env` 或任何凭据。

1. 获取 `ChickenFarm-0.2.0.zip`。
2. 在 Komari 后台上传 ZIP。
3. 打开主题页面。
4. 公共站点直接显示；私有站点先登录，或使用 Komari 生成的临时分享链接打开主题。

主题不会读取或保存 Cookie。浏览器请求 `/api/rpc2` 时会自动携带当前 Komari Cookie。

### 同源 RPC 与数据最小化

主题每轮刷新执行：

```text
public:getNodesInformation
common:getNodesLatestStatus { uuids: [当前选中的节点 UUID] }
```

- `public:getNodesInformation` 返回已清除 Agent Token、IP、备注和版本等敏感字段的元数据。
- 主题不调用会返回完整 Agent 对象的 `common:getNodes`。
- `hidden: true` 的节点始终被过滤，即使当前浏览器已登录管理员。
- 实时状态只请求当前显示的 UUID。
- Komari 返回认证失败时，主题立即删除已经显示的私有节点。
- 临时网络错误不会清空画面，但会显示“数据暂时不可用”。
- 节点 UUID、名称、统计、Cookie 和 RPC 响应都不会发送给 Bridge。

## 主题设置

在 Komari 后台配置：

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `bridge_url` | 空 | 可选多人 WebSocket；留空为单 ZIP 模式 |
| `probe_limit` | `10` | 显示节点数；`0` 表示全部，浏览器硬上限为 200 |
| `probe_order` | `随机` | `随机` 使用稳定种子；`按名称` 排序后取前 N 台 |
| `probe_refresh_seconds` | `5` | 浏览器读取实时数据的间隔，范围 2～60 秒 |
| `player_name` | `小鸡` | 连接多人 Bridge 时的默认玩家名 |
| `label_mode` | `完整` | 完整、精简或关闭名牌 |
| `sound_enabled` | `true` | 互动音效 |
| `show_controls` | `true` | 操作提示 |

同一站点默认使用稳定随机种子，因此不同访客通常看到相同的一批节点。修改节点列表、显示数量、排序方式或站点种子后，名单才会改变。

不要把 API Key、Agent Token、临时分享链接或其他秘密放进主题设置。主题设置会公开给浏览器。

## 可选多人 Bridge

Bridge 只在需要玩家互啄、比分、排行榜、断线恢复或大鹅时运行。

### 最小配置

```bash
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json
```

`bridge/config.example.json`：

```json
{
  "port": 3777,
  "allowedOrigins": [
    "https://komari.example.com"
  ],
  "geese": 2,
  "maxPlayers": 60
}
```

- `allowedOrigins` 填写真实 Komari 页面 Origin，不带路径。
- `geese: 0` 可关闭大鹅。
- `maxPlayers` 限制同时在线玩家数。
- 配置中没有 Komari 地址、凭据、节点列表或轮询设置。

Bridge 还支持可选的 `trustedProxyCidrs`、`trustCloudflareIp`、`exposeVisitorGeo`、`geo` 和 `maxHandshakesPerMinute`；最小部署无需填写。

### Docker Compose

```bash
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json
cp .env.example .env

# 按当前用户修改 .env 中的 DOCKER_UID / DOCKER_GID
id -u
id -g

docker compose up -d --build
```

Compose 默认只绑定 `127.0.0.1:3777`。`.env` 仅用于 UID/GID、端口和可信代理开关，不包含 Komari 凭据。

### GHCR 镜像

```bash
docker pull ghcr.io/cnprobe/chicken-vps-bridge:latest
```

推荐运行方式：

```bash
docker run -d \
  --name chicken-vps-bridge \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:3777:3777 \
  --volume "$PWD/bridge/config.json:/app/bridge/config.json:ro" \
  ghcr.io/cnprobe/chicken-vps-bridge:latest
```

镜像已经设置：

```text
HOST=0.0.0.0
PORT=3777
CONFIG_PATH=/app/bridge/config.json
USER=node
```

健康检查：

```bash
curl http://127.0.0.1:3777/health
```

预期响应：

```json
{"ok":true}
```

### Nginx / Caddy

假设：

```text
Komari Origin： https://monitor.example.com
Bridge：        wss://chicken.example.com/ws
```

Nginx：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3777;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;
}

location = /health {
    proxy_pass http://127.0.0.1:3777/health;
    proxy_set_header Host $host;
}
```

然后在 Komari 主题设置中填写：

```text
wss://chicken.example.com/ws
```

对应关系：

```text
Komari Origin：       https://monitor.example.com
Bridge allowedOrigins：["https://monitor.example.com"]
主题 bridge_url：      wss://chicken.example.com/ws
```

HTTPS 页面不能连接 `ws://`。`allowedOrigins` 不是账号认证；需要限制玩家时，应在反向代理、VPN 或 Access 后运行 Bridge。

### 可信代理

只有当反向代理位于 `trustedProxyCidrs` 中时，Bridge 才读取转发 IP：

```json
{
  "trustedProxyCidrs": ["172.17.0.1"]
}
```

然后设置环境变量：

```text
TRUST_PROXY=1
```

不要填写 `0.0.0.0/0`。Docker 中应填写容器实际看到的网关，而不是想当然地写 `127.0.0.1`。

## 本地开发

需要 Node.js 22 或更高版本。

```bash
npm ci --ignore-scripts
```

只预览主题：

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:4173/
```

预览服务器提供固定的 `/api/public` 与 `/api/rpc2` fixture，不会请求真实 Komari。

同时测试多人 Bridge：

```bash
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json
```

终端一：

```bash
npm run bridge
```

终端二：

```bash
npm run dev
```

浏览器打开：

```text
http://127.0.0.1:4173/?bridge=ws://127.0.0.1:3777/ws
```

`?bridge=` 只在本机开发页面生效。

## 验证与打包

```bash
npm test
npm run build
npm run package
```

测试覆盖：

- 安全元数据 RPC 与选中 UUID 状态请求；
- 隐藏节点过滤、稳定随机选择与输入归一化；
- 单机只读 HUD 与多人模式切换；
- Bridge 最小配置和未知字段丢弃；
- 玩家、大鹅、权威快照与双客户端断线恢复；
- Origin、HTTPS/WSS、代理信任和同源设置请求；
- Bridge 源码不包含 Komari 上游客户端。

主题产物：

```text
release/ChickenFarm-0.2.0.zip
SHA-256: c0f1a7a72f3d1d0f844ccd2e576b1707cad4aa32b0159dd134bf0df3a6e41d90
```

ZIP 只包含主题静态资源、清单、预览图、来源说明和安全说明，不包含 `bridge/config.json`、`.env`、密钥或 Bridge 源码。

## 发布

Bridge 镜像由根仓库工作流构建：

```text
.github/workflows/chicken-vps-bridge.yml
.github/workflows/build-theme-image.yml
```

发布 `0.2.0`：

```bash
git tag -a chicken-vps-bridge-v0.2.0 -m "Release Chicken VPS Bridge 0.2.0"
git push origin chicken-vps-bridge-v0.2.0
```

镜像标签：

```text
ghcr.io/cnprobe/chicken-vps-bridge:chicken-vps-bridge-v0.2.0
ghcr.io/cnprobe/chicken-vps-bridge:latest
```

## 安全

完整信任边界见 [`SECURITY.md`](./SECURITY.md)。来源与再分发说明见 [`NOTICE.md`](./NOTICE.md)。
