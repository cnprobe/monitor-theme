# 安全说明

## 数据流

- 主题从同源 `/api/public` 读取非敏感设置。
- 主题从同源 `/api/rpc2` 调用 `public:getNodesInformation` 和选中节点的 `common:getNodesLatestStatus`。
- 浏览器自动携带当前 Komari 的登录 Cookie 或临时分享 Cookie；主题不读取、不保存这些 Cookie。
- Komari 节点名称和监控数据不会发送给可选多人 Bridge。
- Bridge 只传输玩家状态、操作、战斗事件、比分和大鹅状态；它只从明确配置的 Komari Origin 读取公开的 `geese` 设置，不读取节点数据或凭据。
- 主题页脚只渲染管理员填写的纯文本，不自动查询或显示访客 IP、地理位置或运营商信息。
- 访客 GeoIP 默认离线；只有管理员显式开启 `geo.externalLookup` 才会发送给配置的 HTTPS GeoIP 服务。

## 凭据

- 不要把 API Key、Agent Token、临时分享链接或其他秘密放进主题设置、主题 ZIP、JavaScript 或 `bridge_url`。
- ZIP 不包含任何 Komari 认证凭据，Bridge 也不再接收或转发 Komari API Key。
- 私有 Komari 必须先登录，或使用 Komari 生成的临时分享链接打开主题；权限由 Komari 后端最终判断。
- 多人游戏的短期恢复令牌只保存在当前标签页 `sessionStorage`，并绑定到取得它的 Bridge Origin。
- 生产多人 WebSocket 必须使用 `wss://`，并通过 HTTPS 反向代理提供。

## 数据最小化

- ZIP 使用 `public:getNodesInformation`，不会读取包含完整 Agent 对象的 `common:getNodes`。
- 主题始终过滤 `hidden: true` 的节点。
- 实时状态请求只包含当前选中的 UUID。
- 浏览器只把选中的只读节点加入 3D 场景；这些节点不参与多人碰撞、伤害、比分或排行榜。
- Komari 认证失败时立即从场景删除已经显示的私有节点；临时网络错误保留上次数据并显示过期提示。

## 多人 Bridge 信任边界

Bridge 的 Origin 白名单是跨站保护，不是账号认证。Bridge 是公开游戏服务，只能看到玩家和大鹅状态，不再接收 Komari 节点数据。Bridge 读取主题设置时只访问 `themeSettingsOrigin`（或白名单中的第一个公网 Origin）的 `/api/public`，不发送 Cookie、API Key 或其他凭据。需要限制玩家时，应在反向代理、VPN 或 Cloudflare Access 后运行。

访客 IP 和握手限流共用同一套反向代理信任规则：只有直连 peer 命中 `trustedProxyCidrs` 时才读取转发头；`CF-Connecting-IP` 需要 `trustCloudflareIp`，`X-Forwarded-For` 需要 `TRUST_PROXY=1`。IPv4 支持 CIDR，IPv6 当前只接受精确地址；格式错误会使服务启动失败。

## 资源限制

Bridge 限制 WebSocket 帧、输入消息和字节率、连接数及玩家数量；主题设置和 `bridge/config.json` 都把大鹅数量限制在 0～100，Bridge 会在运行时同步公开的 `geese` 值。主题限制 RPC 响应大小、节点数量、Bridge 消息、名单、快照和障碍物数组。不要为了“显示更多”而盲目提高上限。

## 部署前检查

1. 执行 `npm ci --ignore-scripts`、`npm test`、`npm run build`。
2. 单 ZIP 模式不需要 `bridge/config.json`、`.env`、Docker 或 API Key。
3. 多人模式复制 `bridge/config.example.json`，确认真实 `allowedOrigins` 和 `themeSettingsOrigin`；玩家数和大鹅数也可在 Komari 的主题管理中调整。
4. 生产环境只通过 HTTPS/WSS 暴露多人 Bridge，并配置连接速率和空闲超时。
5. 确认 `bridge/config.json`、`.env*`、密钥和备份文件没有进入 Git、构建上下文或主题 ZIP。
6. 发布前记录主题 ZIP 的 SHA-256，并使用不可变版本号。
