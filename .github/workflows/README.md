# Theme image CI

This repository uses one small caller workflow per deployable theme and one reusable builder.

- `build-theme-image.yml` contains the shared GHCR login, multi-architecture build, SBOM, provenance, and BuildKit cache logic.
- A theme-specific caller must use a unique `image_name`, `cache_scope`, and tag prefix.
- A tag push publishes only the caller's image; branch pushes and pull requests never publish an image.
- Pull requests may still build and validate the image without logging in to or pushing to GHCR.

The current Chicken Farm Bridge uses:

```yaml
on:
  push:
    tags:
      - 'chicken-vps-bridge-v*'
```

with:

```yaml
context: ./Komari-theme/chicken-vps-theme
image_name: chicken-vps-bridge
cache_scope: chicken-vps-bridge
```

For example, pushing this tag:

```bash
git tag -a chicken-vps-bridge-v0.1.2 -m "Release Chicken VPS Bridge 0.1.2"
git push origin chicken-vps-bridge-v0.1.2
```

publishes these tags for this image only:

```text
ghcr.io/cnprobe/chicken-vps-bridge:chicken-vps-bridge-v0.1.2
ghcr.io/cnprobe/chicken-vps-bridge:latest
```

A different theme must use a different prefix, for example `other-bridge-v*`, and a different `image_name` and `cache_scope`. Pushing that tag will not start this workflow or modify the Chicken VPS Bridge image. The reusable builder itself is not triggered directly; it only runs when a matching theme workflow calls it.

Changes to the reusable builder can cause pull-request validation workflows to run, but a new image is published only after the corresponding theme tag is pushed.
