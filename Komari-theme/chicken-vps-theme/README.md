# Komari 养鸡场主题 + Bridge 伴生服务

> 这份 README 按“只使用 Komari”编写。除了 Komari 之外的其他适配器不需要配置，代码中保留的兼容能力可以直接忽略。

## 你需要部署两个东西

```text
主题 ZIP       → 上传到 Komari 后台，只提供 3D 页面和前端代码
Bridge 镜像    → 在服务器上运行，提供权威游戏状态、Komari 数据轮询和 WebSocket
```

只安装 ZIP 不会启动 Bridge，也不会产生多人互啄服务。只使用公开 Komari 时，服务器不需要 Node.js，不需要 `npm install`，也不需要 `.env`；唯一必须准备的服务端文件是：

```text
bridge/config.json
```

---

## 最短部署流程

```text
1. 复制并编辑 bridge/config.json
2. docker pull ghcr.io/cnprobe/chicken-vps-bridge:latest
3. 启动 Bridge 容器
4. 用 Nginx/Caddy 把 Bridge 的 /ws 反向代理成 wss://
5. 构建或获取主题 ZIP
6. 在 Komari 上传 ZIP，并填写 wss://.../ws
```

本文默认目录是：

```text
Komari-theme/chicken-vps-theme/
```

如果当前服务器上有这个仓库，先进入目录：

```bash
cd Komari-theme/chicken-vps-theme
```

---

## 一、Komari 专用的 `bridge/config.json`

### 1. 创建配置文件

```bash
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json
```

`bridge/config.example.json` 已经按 Komari-only 场景写好，但其中的 `monitor.example.com` 是占位域名；复制后必须替换成你的真实 Komari 地址。

`bridge/config.json` 是 JSON 文件，不能写 `//` 注释；下面的注释只用于解释，实际复制时不要复制注释。

### 2. 推荐的完整最小配置（兼容私有 Komari）

把 `bridge/config.json` 替换成下面内容，只需要修改你的 Komari 域名。**下面为了逐行解释，使用的是 JSONC 展示格式；实际的 `bridge/config.json` 必须是严格 JSON，复制时必须删除所有 `//` 注释。**

```jsonc
{ // 根配置对象开始
  "port": 3777, // Bridge 容器内部端口；宿主机映射到 40002 时这里仍然写 3777
  "allowedOrigins": [ // 允许打开 Komari 主题页面的浏览器 Origin 白名单开始
    "https://komari.example.com" // 替换为你的 Komari Origin；不要写 /ws、/api 等路径
  ], // Origin 白名单数组结束
  "probe": { // 探针配置对象开始
    "sources": [ // Komari 数据源列表开始
      { // 单个 Komari 数据源开始
        "name": "我的私有 Komari", // Bridge 探针状态中显示的名称，可以自定义
        "url": "https://komari.example.com", // Komari 根地址；不要添加 /api/nodes 或 /api/rpc2
        "kind": "komari", // 固定写 komari，Bridge 才会使用 Komari 适配器
        "tokenEnv": "KOMARI_API_KEY", // 从 Bridge 服务端环境变量读取私有 Key；公开 Komari 可删除
        "timeout": 12000 // 单次读取 Komari 的超时时间，单位是毫秒
      } // 单个 Komari 数据源结束
    ] // Komari 数据源列表结束
  } // 探针配置对象结束
} // 根配置对象结束
```

这份配置同时覆盖公开和私有 Komari：

- 公开 Komari：可以删除 `tokenEnv`，也不需要创建 `.env`；
- 私有 Komari：保留 `tokenEnv`，并在 Bridge 服务端的 `.env` 中填写 `KOMARI_API_KEY`；
- `kind` 必须保持为 `komari`，Bridge 会自动读取 `/api/nodes` 和 `/api/rpc2`；
- `allowedOrigins` 填 Komari 页面 Origin，不要添加 `/ws` 或 `/api` 路径；
- 其他未写出的资源限制会使用默认值。

### 3. 每个 Komari 配置项是什么意思

#### `port`

```json
"port": 3777
```

Bridge 容器内部监听的端口。普通部署保持 `3777` 即可。

Docker 镜像已经设置了 `PORT=3777`，因此正常使用时不需要额外传 `--env PORT`。如果你要改端口，需要同时修改配置、`.env`（如果使用）和 Docker 的端口映射。

#### `allowedOrigins`

```json
"allowedOrigins": [
  "https://monitor.example.com"
]
```

这里填写的是**打开 Komari 主题页面的浏览器 Origin**，不是 Bridge 地址，也不是 Komari API 地址。

正确：

```text
https://monitor.example.com
http://127.0.0.1:4173
```

错误：

```text
https://monitor.example.com/ws
https://monitor.example.com/path
*
```

规则：

- 只写协议、域名和端口；
- 不要写 `/ws` 路径；
- 不要写 `*`；
- 如果 Komari 同时有多个域名，把每个 Origin 都写进数组；
- `bridge_url` 可以是 `wss://chicken.example.com/ws`，但这个地址不会自动加入 `allowedOrigins`。

#### `geese`

```json
"geese": 2
```

农场里大鹅 NPC 的数量。`0` 表示不生成大鹅；一般保持 `2` 即可。

#### `maxPlayers`

```json
"maxPlayers": 60
```

允许同时进入游戏的访客数量上限。默认值是 `60`，小规模公开部署保持默认即可。

#### `maxProbeChicks`

```json
"maxProbeChicks": 200
```

最多显示多少台 Komari 节点。Komari 节点数量超过这个值时，Bridge 会限制场上探针鸡数量。

#### `maxNpcEntities`

```json
"maxNpcEntities": 500
```

场上所有 NPC 的总上限，包含大鹅和探针鸡。一般不需要修改。

#### `maxHandshakesPerMinute`

```json
"maxHandshakesPerMinute": 60
```

限制同一个客户端 IP 每分钟最多建立多少次 WebSocket 连接。默认值是 `60`。

如果你使用 Nginx 反向代理，却没有配置可信代理 IP 和 `TRUST_PROXY=1`，所有访客可能会共用 Docker 网关这个限流键，公共站点可能很快达到限制。后文有可选配置。

#### `exposeVisitorGeo`

```json
"exposeVisitorGeo": false
```

是否把访客的国家/ASN 显示给其他玩家。只使用 Komari 时建议保持 `false`。

#### `geo.externalLookup`

```json
"externalLookup": false
```

是否把访客公网 IP 发送给第三方 GeoIP 服务。只使用 Komari 时保持 `false`，这样 Bridge 不会把访客 IP 发送给 GeoIP 服务。

#### `probe.interval`

```json
"interval": 15000
```

Komari 数据轮询间隔，单位是**毫秒**：

```text
15000 = 每 15 秒轮询一次
```

默认保持 `15000` 即可。

#### `probe.sources`

```json
"sources": [
  {
    "name": "我的 Komari",
    "url": "https://monitor.example.com",
    "kind": "komari",
    "timeout": 12000
  }
]
```

这是只使用 Komari 时最重要的字段。

| 字段 | 填写什么 |
| --- | --- |
| `name` | 显示名称，随便写，例如 `我的 Komari` |
| `url` | Komari 面板根地址，例如 `https://monitor.example.com` |
| `kind` | 固定写 `komari` |
| `timeout` | 单次请求/读取预算，单位毫秒；`12000` 表示 12 秒 |

`url` 填 Komari 根地址即可，不要手动填写：

```text
/api/nodes
/api/rpc2
```

Bridge 会自动访问 Komari 的公开接口：

```text
/api/nodes
/api/rpc2
```

公开 Komari 不需要填写 `tokenEnv`、`headers` 或管理员 API Key；私有 Komari 保留 `tokenEnv`，API Key 只放在 Bridge 服务端 `.env` 中。

如果你的 Komari 完全关闭了公开接口、需要登录或使用非标准魔改接口，Bridge 可能读不到数据；这种情况不是配置 Token 就能解决的。

#### `probe.sites`

```json
"sites": []
```

这是网站可用性探测列表，不是 Komari 节点列表。只使用 Komari 时保持空数组：

```json
"sites": []
```

#### `probe.security`

只使用 Komari 时不需要在配置中写这个对象，Bridge 默认会关闭所有远程跟随策略。如果你的旧配置中已经存在它，保持原样即可，不要为了 Komari 去打开任何选项。

### 4. 更短的最小配置

如果你不想调整默认限制，可以使用这个最小配置：

```json
{
  "port": 3777,
  "allowedOrigins": [
    "https://monitor.example.com"
  ],
  "probe": {
    "sources": [
      {
        "url": "https://monitor.example.com",
        "kind": "komari"
      }
    ]
  }
}
```

未写的字段会使用默认值：

```text
geese: 2
maxPlayers: 60
maxProbeChicks: 200
maxNpcEntities: 500
maxHandshakesPerMinute: 60
exposeVisitorGeo: false
geo.externalLookup: false
probe.interval: 15000
probe.sites: []
probe.security: 全部关闭
```

### 5. 检查 JSON 语法

如果服务器有 Node.js，可以执行：

```bash
node -e "JSON.parse(require('fs').readFileSync('bridge/config.json', 'utf8')); console.log('config ok')"
```

没有 Node.js 时可以跳过。Bridge 启动时会检查 JSON，格式错误会直接退出并在日志中显示错误。

---

## 二、公开 Komari 不需要 `.env`

公开 Komari 接口不需要 Token，所以最简单的公开部署**不需要 `.env`**。

如果你希望保留一个可选的 Docker 环境文件，可以执行：

```bash
cp .env.example .env
chmod 600 .env
```

但它不是 Komari 必填文件，复制后保持默认即可。下面的最小 `docker run` 也不使用 `--env-file`。

`.env` 中只有这些可选内容：

```dotenv
# Compose 专用；建议改成 id -u 和 id -g 的结果
DOCKER_UID=1000
DOCKER_GID=1000

# 一般不需要修改
# HOST=0.0.0.0
# PORT=3777
# CONFIG_PATH=/app/bridge/config.json
# TRUST_PROXY=1
```

不要把 Komari 管理员 Key、Agent Token 或其他秘密放进主题设置或 `komari-theme.json`。私有 Komari 的 API Key 如果使用，只能保存在 Bridge 服务器的 `.env` 或其他服务端 Secret 中。

### 私有 Komari 的 API Key

上面的完整最小配置已经包含私有 Komari 所需的 `tokenEnv`。如果你的 Komari 开启了“私有站点”，只需要在 Bridge 服务器创建 `.env`：

```bash
cp .env.example .env
chmod 600 .env
```

然后填写 Komari 后台生成的原始 API Key：

```dotenv
KOMARI_API_KEY=这里填写原始APIKey
```

Bridge 会自动发送：

```text
Authorization: Bearer <KOMARI_API_KEY>
```

私有模式下，Bridge 读取 `/api/public` 中的主题设置时也会使用同一个服务端 Key；Key 不会返回给浏览器，也不会写入主题 ZIP。

使用私有配置时，Docker 命令必须带上环境文件：

```bash
docker run -d \
  --name chicken-vps-bridge \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:3777:3777 \
  --env-file .env \
  --volume "$PWD/bridge/config.json:/app/bridge/config.json:ro" \
  ghcr.io/cnprobe/chicken-vps-bridge:latest
```

注意：

- 私有 Komari 配置中要保留 `"kind": "komari"` 和 `"tokenEnv": "KOMARI_API_KEY"`；
- `KOMARI_API_KEY` 填原始 Key，不要填管理员用户名和密码；
- API Key 相当于服务端凭据，当前 Komari 版本的 API Key 可能拥有较高权限；
- 不要把 `.env` 提交到 Git；
- 不要把 API Key 写入 `komari-theme.json`、主题 ZIP 或 `bridge_url`；
- 怀疑泄露时立即在 Komari 后台撤销并重新生成；
- 公开 Komari 可以删除 `tokenEnv`，并且不需要创建 `.env`。

**重要：API Key 只解决 Bridge 读取私有 Komari 的认证问题，不会让 Bridge 本身变成私有服务。** 当前 Bridge 的 WebSocket 只有 Origin 校验，没有 Komari 账号登录认证。任何能访问 `wss://.../ws` 的人，只要通过 Origin 白名单，都可能看到节点统计。

如果 Komari 数据必须保密，请同时把 Bridge 放在以下任一边界内：

- VPN/内网；
- 带认证的反向代理；
- Cloudflare Access 等身份认证网关；
- 仅管理员可访问的独立端口。

不要仅因为 Bridge 使用了 API Key，就把它的 WebSocket 公开到互联网。

## 主题设置中可以调整什么

以下非敏感选项放在 Komari 的主题设置中，打开主题后可以直接修改：

| 设置 | 作用 |
| --- | --- |
| `probe_limit` | 随机显示多少台 Komari 小鸡；例如填 `10` 就随机保留 10 台，填 `0` 表示使用 Bridge 的 `maxProbeChicks` 上限 |
| `probe_order` | `随机` 保持一批稳定的随机小鸡；`按名称` 按节点名称排序后取前 N 台 |
| `player_name` | 默认访客名字 |
| `label_mode` | 完整、精简或关闭鸡名牌 |
| `sound_enabled` | 是否启用互动音效 |
| `show_controls` | 是否显示操作提示 |
| `bridge_url` | 公开的 Bridge WebSocket 地址 |

随机选择会在节点仍然存在时保持稳定，不会每 15 秒重新洗牌；节点消失、重新出现或修改数量/排序时才重新选择。Bridge 会定期从 Komari 的公开设置接口读取 `probe_limit` 和 `probe_order`，所以在 Komari 后台修改后通常在一个轮询周期内生效，客户端不能通过伪造消息抬高数量。

以下内容不能放在主题设置中：

- `KOMARI_API_KEY`、管理员 Key、Agent Token；
- Komari 私有源 URL 和 `allowedOrigins`；
- Bridge 端口、轮询间隔、代理信任和 GeoIP 外联设置；
- `maxPlayers`、`maxNpcEntities`、握手限流等服务端资源限制。

原因是主题设置会通过公开接口提供给浏览器；即使 Bridge 不信任客户端消息，也不应该把秘密放进主题设置。`probe_limit` 只是显示偏好，Bridge 会把它限制在服务端 `maxProbeChicks` 以内。

---

## 三、Docker 部署 Bridge

### 1. 拉取 GitHub Actions 构建的镜像

仓库中的工作流会发布：

```text
ghcr.io/cnprobe/chicken-vps-bridge:latest
```

服务器执行：

```bash
docker pull ghcr.io/cnprobe/chicken-vps-bridge:latest
```

如果 GHCR 包是 Private，先登录具有 `read:packages` 权限的账号：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

### 2. 推荐的最小 `docker run`

确认 `bridge/config.json` 已经写好后，在该文件所在目录执行：

```bash
cd Komari-theme/chicken-vps-theme

docker run -d \
  --name chicken-vps-bridge \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:3777:3777 \
  --volume "$PWD/bridge/config.json:/app/bridge/config.json:ro" \
  ghcr.io/cnprobe/chicken-vps-bridge:latest
```

这就是 Komari-only 部署需要的参数。

| 参数 | 作用 |
| --- | --- |
| `--name` | 方便查看日志、停止和重启容器 |
| `--restart unless-stopped` | Docker 重启后自动恢复 Bridge |
| `--user` | 让容器使用当前宿主机用户读取 `chmod 600` 的配置 |
| `--publish 127.0.0.1:3777:3777` | 只在本机暴露 Bridge 给 Nginx/Caddy |
| `--volume` | 把宿主机配置只读挂载到容器 |
| 镜像名 | GitHub Actions 构建的 Bridge 程序 |

镜像 Dockerfile 已经设置：

```text
HOST=0.0.0.0
PORT=3777
CONFIG_PATH=/app/bridge/config.json
USER=node
```

因此不需要再写：

```text
--env HOST=0.0.0.0
--env PORT=3777
--env CONFIG_PATH=/app/bridge/config.json
--env-file .env
```

### 3. 如果以 root 身份执行

上面的命令最好由普通部署用户执行。如果当前是 root，`$(id -u):$(id -g)` 会变成 `0:0`，这会削弱非 root 隔离。

可以先查看镜像中 `node` 用户的 UID：

```bash
docker run --rm --entrypoint id ghcr.io/cnprobe/chicken-vps-bridge:latest -u
```

假设输出是 `1000`，可以：

```bash
chown 1000:1000 bridge/config.json
chmod 600 bridge/config.json
```

然后从 `docker run` 中删除 `--user "$(id -u):$(id -g)"`，让镜像自带的 `USER node` 运行。

### 4. 可选的额外加固

普通 Komari 部署不需要添加下面参数。如果公网服务需要更严格的容器隔离，可以在最小命令中追加：

```bash
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL
```

不要使用：

```text
--privileged
--network host
```

### 5. 检查 Bridge

```bash
docker ps --filter name=chicken-vps-bridge
docker logs --tail 100 chicken-vps-bridge
curl http://127.0.0.1:3777/health
```

正常结果：

```json
{"ok":true}
```

如果 Komari 没有出现在农场中，检查：

1. `bridge/config.json` 是否挂载到 `/app/bridge/config.json`；
2. `probe.sources[0].url` 是否是 Komari 根地址；
3. `kind` 是否为 `komari`；
4. `allowedOrigins` 是否是实际 Komari 页面 Origin；
5. Bridge 容器是否能访问 Komari 域名；
6. Komari 的 `/api/nodes` 和 `/api/rpc2` 是否可从服务器访问。

### 常见错误：`探针源1:unauthorized`

这个错误表示 Bridge 读取你配置的 Komari 数据源时，被对方返回了认证失败或拒绝访问。它通常对应 HTTP `401`、`403`，或响应内容中包含 `Unauthorized`、`forbidden`、`token` 等文字。

这不是浏览器 WebSocket 的 `allowedOrigins` 错误，也不是 Komari 主题 `bridge_url` 填错。

先在服务器上测试 Komari 的公开节点接口：

```bash
curl -i https://monitor.example.com/api/nodes
```

正常情况下应返回 HTTP `200`，并且响应中包含 `data` 数组。

如果返回 `401` 或 `403`，常见原因是：

- Komari 管理面板或反向代理启用了登录认证；
- Cloudflare/WAF/API Gateway 拦截了 Bridge 服务器 IP；
- `/api/nodes` 或 `/api/rpc2` 只允许登录用户访问；
- 配置的 URL 实际指向了登录页面、防护页面或错误的面板地址。

本项目的 Komari 适配器只使用公开 Guest API，**不读取 Komari 管理员 API Key**。因此不要把管理员 Key 写进 `bridge/config.json` 或主题设置。可以选择：

1. 让 Bridge 使用的 Komari 公开 API 可访问；
2. 在 Cloudflare/WAF 中只针对 `/api/nodes` 和 `/api/rpc2` 放行 Bridge 服务器；
3. 使用一个不需要登录的 Komari 公共面板；
4. 如果必须使用完全私有的 Komari API，需要另外开发服务端认证适配器，不要把凭据放进 Komari 主题。

还要从 Bridge 容器内部测试，因为宿主机能访问不代表容器能访问：

```bash
docker exec chicken-vps-bridge node -e "fetch('https://monitor.example.com/api/nodes').then(async r => console.log(r.status, (await r.text()).slice(0, 200))).catch(e => console.error(e.message))"
```

判断方式：

- 返回 `401/403`：是认证、防护或权限问题；
- 返回 `404`：URL 路径或 Komari 版本不匹配；
- 返回 `200` 但没有 `data`：不是可识别的 Komari 节点接口；
- 宿主机成功、容器失败：检查 Docker DNS、出口网络、代理和防火墙；
- 容器也返回 `200` 且有 `data`：再检查 `kind`、配置文件挂载和 Bridge 日志。

### 6. 修改配置和更新镜像

只修改 `bridge/config.json` 时，配置是 bind mount，可以直接重启：

```bash
docker restart chicken-vps-bridge
```

更新 Bridge 镜像时：

```bash
docker pull ghcr.io/cnprobe/chicken-vps-bridge:latest
docker rm -f chicken-vps-bridge
```

然后重新执行上面的 `docker run` 命令。

如果以后使用了 `.env` 或修改了 `TRUST_PROXY`、`PORT` 等环境变量，也必须重新创建容器；`docker restart` 不会重新读取环境变量。

### 可选：Docker Compose

`compose.yaml` 默认会在本地构建镜像，不是只拉取 GHCR 镜像的方案。只使用 GitHub 镜像时，仍然建议使用上面的 `docker run`。

如果确实要使用 Compose：

```bash
cd Komari-theme/chicken-vps-theme
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json

# 可选：复制 .env 并填写实际 UID/GID、端口等设置
cp .env.example .env
id -u
id -g
# 把输出写入 .env 的 DOCKER_UID / DOCKER_GID

docker compose up -d --build
```

Compose 默认绑定 `127.0.0.1:3777`；修改端口使用 `BRIDGE_PORT`，不要把 `HOST` 改成 `127.0.0.1`。

---

## 四、Nginx 反向代理 WebSocket

Bridge 只提供：

```text
/health
/ws
```

3D 页面由 Komari 提供。建议让 Docker 只在本机监听 Bridge，再由宿主机 Nginx 提供 HTTPS。

假设：

```text
Komari 页面：https://monitor.example.com
Bridge 地址：wss://chicken.example.com/ws
```

把下面的 `location` 放进已经配置好 TLS 证书的 Nginx `server` 中：

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

然后检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

对应关系必须是：

```text
Komari 页面 Origin：       https://monitor.example.com
config.json allowedOrigins： ["https://monitor.example.com"]
主题 bridge_url：           wss://chicken.example.com/ws
```

HTTPS 页面不能使用 `ws://`，浏览器会把它当作混合内容。

### 可选：让限流使用真实访客 IP

只使用 Komari 时，这不是启动 Bridge 的必要条件。但如果没有配置信任代理，所有经过 Nginx 的访客会共用 Docker 网关这一个限流键。

先查 Docker 默认网络网关：

```bash
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

假设输出：

```text
172.17.0.1
```

在配置中加入：

```json
"trustedProxyCidrs": [
  "172.17.0.1"
]
```

并在 `.env` 中设置：

```text
TRUST_PROXY=1
```

然后重新创建 Bridge 容器。不要直接填写 `127.0.0.1`；在 Docker NAT 拓扑中，容器看到的直接 peer 通常是 Docker 网关。`trustedProxyCidrs` 支持 IPv4 CIDR；IPv6 当前使用精确地址。

`TRUST_PROXY=1` 只应该在 Nginx 确实是受控代理、并且 Nginx 会覆盖 `X-Forwarded-For` 时开启。不要写 `0.0.0.0/0`。

---

## 五、安装 Komari 主题 ZIP

Bridge 启动并且 `/health` 正常后，再安装主题 ZIP。

### 从源码构建 ZIP

这部分是主题发布流程。只使用 GHCR Bridge 镜像的服务器不需要执行：

```bash
cd Komari-theme/chicken-vps-theme
npm ci --ignore-scripts
npm test
npm run package
```

当前 ZIP：

```text
release/ChickenFarm-0.1.1.zip
SHA-256: 55699a38030bcd884e50259b18797fc025f8893d6998e86ebeb947dc3b5caa8a
```

ZIP 只包含主题静态资源和清单，不包含：

```text
bridge/config.json
.env
Komari 管理员 Key
```

在 Komari 后台上传 ZIP，然后进入主题设置填写：

```text
wss://chicken.example.com/ws
```

主题设置会公开给前端，不能放任何 Token 或管理凭据。

当前 GitHub Actions 自动构建的是 Bridge 镜像；主题 ZIP 仍需要本地 `npm run package` 或后续单独配置的 Artifact/Release 流程生成。

---

## 六、本地开发

只有修改主题或 Bridge 源码时才需要 Node.js 22+：

```bash
cd Komari-theme/chicken-vps-theme
npm ci --ignore-scripts
cp bridge/config.example.json bridge/config.json
chmod 600 bridge/config.json
```

把 Komari 配置写入 `bridge/config.json` 后，终端 1 启动 Bridge：

```bash
npm run bridge
```

终端 2 启动主题预览：

```bash
npm run dev
```

浏览器打开：

```text
http://127.0.0.1:4173/?bridge=ws://127.0.0.1:3777/ws
```

`?bridge=` 只对本地预览生效，不会写入 Komari 主题设置。

运行测试和构建：

```bash
npm test
npm run build
```

---

## 七、GitHub Actions

仓库根目录的工作流：

```text
.github/workflows/build-theme-image.yml
.github/workflows/chicken-vps-bridge.yml
```

当前主题的发布工作流只响应本主题专用 Tag：

```text
chicken-vps-bridge-v*
```

例如发布 `0.1.1`：

```bash
git tag -a chicken-vps-bridge-v0.1.1 -m "Release Chicken VPS Bridge 0.1.1"
git push origin chicken-vps-bridge-v0.1.1
```

只有推送这个 Tag 时才会：

- 构建 `linux/amd64` 和 `linux/arm64` 镜像；
- 推送 `ghcr.io/cnprobe/chicken-vps-bridge:chicken-vps-bridge-v0.1.1`；
- 更新 `ghcr.io/cnprobe/chicken-vps-bridge:latest`；
- 生成构建证明、SBOM 和缓存。

普通分支推送不会发布镜像。Pull Request 只做构建验证，不登录 GHCR，也不推送镜像。

其他主题必须使用不同的 Tag 前缀，例如：

```text
other-bridge-v*
```

因此推送其他主题的 Tag 不会触发 Chicken VPS Bridge 的工作流，也不会更新本主题的镜像。通用构建器位于：

```text
.github/workflows/build-theme-image.yml
```

新主题的 CI 规则见：

```text
.github/workflows/README.md
```

---

## 八、只使用 Komari 时的安全注意事项

- 不要把 Komari 管理 API Key 或 Agent Token 写进 `komari-theme.json`；
- Komari 主题设置会公开给前端，只能填写公开的 Bridge 地址；
- `bridge/config.json` 建议权限为 `0600`；
- 生产环境使用 `wss://`；
- `allowedOrigins` 只填真实 Komari 页面 Origin，不要使用 `*`；
- 默认不向第三方 GeoIP 服务发送访客 IP；
- Bridge 的 WebSocket Origin 白名单不是账号认证，不要把私有监控面板直接暴露给公众；
- 只挂载 `bridge/config.json`，不要把整个 `bridge/` 目录挂进容器；
- 不要使用 `--privileged`、`--network host` 或 root 用户；
- 修改配置后用 `docker restart`，修改环境变量或镜像后重新创建容器；
- Bridge 状态主要在内存中，重启会清空当前游戏状态。

完整信任边界见 [`SECURITY.md`](./SECURITY.md)。

---

## 来源与再分发

本目录基于 2026-09-24 公开下载包直接复制并改造，来源和校验值见 [`NOTICE.md`](./NOTICE.md)。原下载包未包含许可证文件；当前复制依据仓库维护者在工作会话中明确给出的复制授权。对外发布或进入 Komari 主题市场前，应再次确认上游版权和发布授权。
