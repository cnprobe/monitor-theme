# cnprobe monitor-theme

用于存放不同探针及其 Komari 主题实现。

## 目录约定

```text
<探针或主题分类>/
└── <主题目录>/
    ├── komari-theme.json
    ├── dist/
    ├── Dockerfile              # 需要独立伴生服务时
    └── ...
```

当前主题：

```text
Komari-theme/chicken-vps-theme/
```

Chicken Farm 使用单 ZIP 架构：主题浏览器直接读取同源 Komari；可选 Bridge 只负责多人游戏、大鹅和断线恢复，不接收任何 Komari 节点数据。

## Docker 镜像 CI

仓库使用一个通用构建工作流：

```text
.github/workflows/build-theme-image.yml
```

每个需要发布 Docker 镜像的主题使用一个独立的调用工作流，并声明自己的路径过滤。例如当前主题：

```text
.github/workflows/chicken-vps-bridge.yml
```

Pull Request 验证只监听本主题目录：

```text
Komari-theme/chicken-vps-theme/**
```

发布镜像只响应本主题的 Tag：

```text
chicken-vps-bridge-v*
```

因此修改其他探针或其他主题时，不会触发 `chicken-vps-bridge` 的发布工作流；修改通用工作流也不会自动发布镜像，必须重新推送对应主题的发布 Tag。

新增主题时：

1. 创建新的主题目录。
2. 如果每个主题有独立的伴生服务，复制一个调用工作流并修改工作流文件名、Tag 前缀、PR 路径过滤、`context`、`image_name` 和 `cache_scope`。
3. 如果同一探针下的多个主题共用同一个伴生服务，应把 Dockerfile 和构建工作流放在探针目录级别，只构建一次镜像；各主题只负责生成自己的主题 ZIP，不要为每个主题重复构建相同镜像。
4. 为每个独立镜像使用唯一的 GHCR 镜像名和缓存范围。
5. 只有推送对应的发布 Tag 才会构建并推送 GHCR 镜像；Pull Request 只做构建验证，不推送镜像。

当前主题的完整配置、单 ZIP 与可选多人 Bridge 部署说明见：

```text
Komari-theme/chicken-vps-theme/README.md
```

当前主题的发布 Tag 约定：

```text
chicken-vps-bridge-v<版本号>
```

例如 `chicken-vps-bridge-v0.2.0` 只会发布 Chicken VPS Bridge 镜像；其他主题使用各自的 Tag 前缀，不会互相触发。

当前主题镜像：

```text
ghcr.io/cnprobe/chicken-vps-bridge:latest
```

对应的固定版本镜像示例：

```text
ghcr.io/cnprobe/chicken-vps-bridge:chicken-vps-bridge-v0.2.0
```

主题 ZIP 由主题目录自己的 `npm run package` 生成；Docker 镜像和主题 ZIP 是两个独立产物。
