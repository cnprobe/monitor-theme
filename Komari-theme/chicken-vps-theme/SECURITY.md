# 安全说明

## 数据流

- 主题运行时只请求同源的 `/api/public`，读取公开的 `bridge_url`。
- 主题只连接管理员配置的 WebSocket 伴生服务；默认不请求第三方图片、字体或统计脚本，国旗使用本地 Unicode 字符。
- 伴生服务会访问管理员在 `bridge/config.json` 中配置的探针源；这是服务端主动请求，目标必须由管理员审核。
- 访客 GeoIP 默认完全离线。只有设置 `geo.externalLookup: true` 时才会把访客公网 IP 发给配置中的 HTTPS GeoIP 服务。

## 凭据

- 不要把 Komari 管理 API Key、Agent Token、探针 Token 或私有 URL 放进 Komari 主题设置；`/api/public` 会公开主题设置。
- 探针凭据放在伴生服务的环境变量或权限为 `0600` 的配置文件中，推荐使用 Docker/主机 secret manager。
- 私有 Komari 可以使用服务端 `KOMARI_API_KEY`，但只能放在 Bridge 的 `.env`/Secret 中；不要放入主题设置、主题 ZIP 或浏览器可读配置。该 Key 可能拥有较高权限，应限制保存位置并定期轮换。
- 浏览器的短期游戏恢复令牌只放在当前标签页的 `sessionStorage`，并绑定到取得它的 bridge Origin；它不是管理凭据。
- 生产 WebSocket 必须使用 `wss://`，并通过 HTTPS 反向代理提供。

## 伴生服务的信任边界

WebSocket 的 Origin 白名单是跨站保护，不是身份认证。伴生服务是公开游戏服务：能连接的人可以看到公开的节点名称、在线状态和监控数值。不要把私有监控面板直接接入公开实例；私有部署应在反向代理增加身份认证或拆分为私有伴生服务。

`probe.security.allowRemoteApiBase` 和 `allowNodegetBackends` 默认关闭。开启时还必须列出明确的 `apiBaseOrigins` / `nodegetBackendOrigins`；跨源 API 跟随不会携带 Token 或自定义请求头，且跨源重定向会被拒绝。直接配置的源 URL 仍属于管理员信任边界，生产环境应配合出站防火墙阻止回环、RFC1918、链路本地和云元数据地址。

访客 IP 和握手限流共用同一套反向代理信任规则：只有直接 peer 命中 `trustedProxyCidrs` 时才读取转发头；`CF-Connecting-IP` 需要 `trustCloudflareIp`，`X-Forwarded-For` 需要 `TRUST_PROXY=1`。Docker 中宿主机 Nginx 看到的 peer 可能是 Docker 网关而不是 `127.0.0.1`。`trustedProxyCidrs` 支持 IPv4 CIDR，IPv6 当前使用精确地址；格式错误会使服务启动失败。

## 资源限制

伴生服务限制 WebSocket 帧、输入消息/字节率、连接数、玩家/NPC 数量和上游响应大小；主题也限制 bridge 消息、名单、快照和障碍物数组。不要为了“显示更多”而盲目提高这些上限。

## 原始安装包

原始 `.run` 中的 `install.sh` 不随本模板发布，也没有被本项目执行。它以 root 创建 systemd 服务，并会从可配置的 Node 镜像下载运行时、默认访问 `api.ipify.org`；该脚本没有对下载的 Node 压缩包做 SHA-256 校验，因此不建议继续使用原安装器部署生产环境。请使用本模板的 Docker/Node 流程，并在下载后自行校验来源和哈希。

## 部署前检查

1. 使用 Node.js 22+（推荐仍受支持的 LTS），执行 `npm ci --ignore-scripts`、`npm test`、`npm run build`。
2. 复制 `bridge/config.example.json` 后设置实际 `allowedOrigins`、探针源和 `trustedProxyCidrs`。
3. 生产环境只通过 HTTPS/WSS 反向代理访问，并为 Nginx/Cloudflare 配置连接、请求速率和空闲超时限制。
4. 确认 `bridge/config.json`、`.env*`、密钥和备份文件没有进入 Git、构建上下文或主题 ZIP。
5. 发布前记录主题 ZIP 的 SHA-256，并使用不可变版本号；对外分发前再次确认上游再分发授权。
