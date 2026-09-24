# Theme image CI

This repository uses one small caller workflow per deployable theme and one reusable builder.

- `build-theme-image.yml` contains the shared GHCR login, multi-architecture build, SBOM, provenance, and BuildKit cache logic.
- A theme-specific workflow must declare only its own folder in `on.push.paths` and `on.pull_request.paths`.
- Each theme must use a unique `image_name` and `cache_scope`.

For example, the current theme uses:

```yaml
paths:
  - 'Komari-theme/chicken-vps-theme/**'
  - '.github/workflows/build-theme-image.yml'
  - '.github/workflows/chicken-vps-bridge.yml'
```

with:

```yaml
context: ./Komari-theme/chicken-vps-theme
image_name: chicken-vps-bridge
cache_scope: chicken-vps-bridge
```

When adding another probe/theme, copy the caller workflow, change its filename, path filter, context, image name, and cache scope. A change under one theme folder will not start Docker builds for the other themes. Changes to the reusable builder intentionally rebuild every caller.

Branch pushes publish `latest` on `main` plus branch/SHA tags. For an explicit version, use the caller workflow's `workflow_dispatch` and provide `image_tag`; tag pushes are not used as triggers so one release tag does not start every theme workflow.
