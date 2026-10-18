# native/ — prebuilt Android bindings for DSH's `node-addon-require-builtin`

DSH 0.2.x boots through `node-addon-require-builtin`, a native binding that
hands the harness Node's internal module loaders (`requireBuiltin("internal/
modules/esm/loader")` — app-boot's "host preparation"). Upstream publishes
platform packages for linux (gnu/musl × x64/arm64), darwin, and win32 —
**but nothing for android** (`node-addon-require-builtin-android-x64` is a
registry 404), and the main package ships neither source nor a postinstall.
On Termux the loader's three strategies all miss and boot dies with:

```
No usable native binding found for node-addon-require-builtin-android-x64 (auto)
```

Sylvia's installer (`module_native_binding`) solves it by fetching a prebuilt
artifact from this directory before falling back to an on-device source
build, so the cost is paid once per architecture and shared here.

## Layout

```
native/<arch>/napi-v9/require_builtin.node
```

- `<arch>`: `android-x64` (x86_64 emulators), `android-arm64` (phones)
- `napi-v9`: the binding is built with the **NAPI** backend, which is
  ABI-stable — one file covers every Node version (the loader also accepts a
  nodeabi build at `build/nodeabi/node-v<abi>-<arch>/`, but NAPI is the
  portable choice for a shared artifact).

## Provenance / verification

- Built from upstream source: <https://github.com/deepseek-ai/dsh-node-addon-require-builtin>
  (`packages/native`, `NARB_BACKEND=napi` default, `GYP_DEFINES="narb_product=require-builtin"`),
  on an x86_64 Android emulator under Termux with `node-gyp --nodedir=$PREFIX`.
- The installer does not trust file names: after placing the file it runs the
  real call (`node --expose-internals` → `requireBuiltin` of an internal
  module) and falls back to a source build if it fails to dlopen.
- Contributed artifacts should be committed with a note in the commit message
  (device model, Termux/node version).

## Contributing an arm64 build

The installer builds automatically on a device with no matching artifact
(clang/make are added if missing; log: `~/.sylvia/native-build/build.log`).
When that succeeds, contribute it so the next install skips the build:

```
cp ~/.sylvia/native-build/src/packages/native/build/Release/require_builtin.node \
   native/android-arm64/napi-v9/require_builtin.node
git add native/android-arm64 && git commit -m "native: arm64 binding"
```

## Why this exists instead of an upstream fix

Same class as every other Android adaptation in this project (sharp, koffi,
node-pty, sandbox backends): upstream targets glibc/mach/MSVC platforms.
The missing `-android-*` platform packages are worth reporting upstream —
until they exist, this directory is the distribution point.
