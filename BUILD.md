# Building Observe BRUM

This document explains how to build the Observe BRUM bundle from source. It covers the build script, its options, and the output files. For basic install steps, see the Install section in [README.md](./README.md). For test instructions, see [TESTING.md](./TESTING.md).

## Prerequisites

The build requires Node.js, npm, and a Bash shell. macOS and Linux already include Bash. On Windows, use WSL or Git Bash. The package does not pin a minimum Node.js version in `package.json`.

## Quick Start

```bash
# Production build (minified)
npm run build

# Development build (unminified, with sourcemap)
npm run build:dev
```

The build script installs dependencies automatically if the `node_modules` folder is missing.

## What the Build Script Does

The `build.sh` script runs these steps in order:

- Resolves the version string from the `VERSION` environment variable, `package.json`, or a fallback.
- Installs dependencies if the `node_modules` folder is missing.
- Bundles `src/brum.js` and its OpenTelemetry dependencies into one file with esbuild.
- Writes the bundle to the output path.

The bundle format is IIFE, a self-running function that needs no module loader.

## Build Options

- `--dev`: Turns off minification and adds a sourcemap. The script also appends a UTC timestamp to the version string. Example: `./build.sh --dev`.
- `VERSION`: Sets a specific version string instead of reading `package.json`. Example: `VERSION=1.2.3 ./build.sh`.
- `OUT`: Sets the output file path instead of the default `dist/observe-brum.js`. Example: `OUT=path/to/observe-brum.js ./build.sh`.

## Version Stamping

The build stamps a version string into the bundle at build time, through the `__BRUM_VERSION__` esbuild define. The bundle reads this value and emits it as a resource attribute. The script resolves the version in this order: the `VERSION` environment variable, the version field in `package.json`, then a fallback of `0.0.1`. In development builds, the script appends a UTC timestamp to the version, for example `0.0.5-20260101T120000Z`.

## Build Output

The build writes one file, `dist/observe-brum.js`, in IIFE format. Production builds are minified. Development builds skip minification and also write a sourcemap, `dist/observe-brum.js.map`, for easier debugging.

## Dependency Management

- `npm run deps:check`: Lists outdated packages with npm-check-updates. This command does not change any file.
- `npm run deps:otel`: Updates all `@opentelemetry/*` packages to their latest version, then runs `npm install`.
- `npm run deps:doctor`: Updates dependencies one at a time in doctor mode, and runs tests after each update.

## Related Documents

- [README.md](./README.md): Install steps and page setup instructions.
- [TESTING.md](./TESTING.md): Test suite documentation.
