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

## Docker 镜像 CI

仓库使用一个通用构建工作流：

```text
.github/workflows/build-theme-image.yml
```

每个需要发布 Docker 镜像的主题使用一个独立的调用工作流，并声明自己的路径过滤。例如当前主题：

```text
.github/workflows/chicken-vps-bridge.yml
```

只监听：

```text
Komari-theme/chicken-vps-theme/**
```

因此修改其他探针或其他主题时，不会重复构建 `chicken-vps-bridge` 镜像。修改通用工作流时，所有依赖它的主题会重新构建。

新增主题时：

1. 创建新的主题目录。
2. 如果每个主题有独立的伴生服务，复制一个调用工作流并修改工作流文件名、路径过滤、`context`、`image_name` 和 `cache_scope`。
3. 如果同一探针下的多个主题共用同一个伴生服务，应把 Dockerfile 和构建工作流放在探针目录级别，只构建一次镜像；各主题只负责生成自己的主题 ZIP，不要为每个主题重复构建相同镜像。
4. 为每个独立镜像使用唯一的 GHCR 镜像名和缓存范围。
5. 在 `main` 分支推送时自动构建；需要固定版本时使用调用工作流的 `workflow_dispatch` 输入 `image_tag`。

当前主题的完整配置、Docker 部署和 `.env` 说明见：

```text
Komari-theme/chicken-vps-theme/README.md
```

当前主题镜像：

```text
ghcr.io/cnprobe/chicken-vps-bridge:latest
```

主题 ZIP 由主题目录自己的 `npm run package` 生成；Docker 镜像和主题 ZIP 是两个独立产物。
