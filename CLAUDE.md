# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

pico⚡flash is a pure JavaScript, dependency-free WebUSB implementation of Raspberry Pi's PICOBOOT protocol for flashing RP2040 and RP2350 microcontrollers. It ships two things in one repo:

1. **The library** (`pkg/`) — an ES6 module library (published as the `picoflash` npm package) for talking to PICOBOOT devices.
2. **The website** (`index.html`, `style.css`, `js/app.js`, `js/config.js`, `js/uf2/uf2.js`) — a custom single-page flashing tool with a Chinese UI. It connects to a device, shows its basic info, and flashes a UF2 firmware fetched from a fixed URL.

Both are plain ES6 modules with **no build step, no external dependencies, and no bundler**. The website imports the library directly via absolute paths like `/pkg/picoboot.js` and `/js/uf2/uf2.js`.

## Commands

- **Run the site locally**: `python3 -m http.server 8000` from the repo root (or `npm run serve` inside `pkg/`). WebUSB requires a secure context, so access via `http://localhost:8000` (treated as secure) or over HTTPS (e.g. `mkcert`). On Android or from another machine you must use HTTPS.
- **Type-check**: `npx tsc` (config in `tsconfig.json`: `noEmit`, `checkJs`, `allowJs` — JSDoc annotations are the type system). Type-checking is editor/CI oriented; no tooling is installed in the repo.
- **Lint**: `npx eslint .` (config in `.eslintrc.json`). The only active rules are `@typescript-eslint` promise rules: `no-floating-promises`, `no-misused-promises`, `require-await`, `promise-function-async`. Match this style — keep promise-returning functions `async`, and never leave a promise unawaited.
- **Tests**: none exist. The only runnable verification is the browser UI itself (`examples/basic.html`, `examples/extended.html`) or manual flashing against real hardware.

There is no test framework, no `node_modules`, and no CI — expect to verify changes by serving the site and (ideally) testing against a real RP2040/RP2350 in BOOTSEL mode.

## Architecture

### Library layering (`pkg/`)

The library is a strict layering; each module only depends on the ones below it:

- `constants.js` — memory map addresses, USB VID/PIDs, UF2 family IDs, PICOBOOT command IDs' constants, control-transfer request numbers, default timeouts. No logic.
- `commands.js` — `PicobootCmd` (builds/serializes the 32-byte little-endian command packet), `PicobootCmdId` (opcodes; bit `0x80` in the opcode means an IN/data-transfer command), `PicobootStatus`/`PicobootStatusCmd` (status-code enum + 16-byte status response parser). Static factory methods (`PicobootCmd.reboot`, `.flashErase`, …) wrap each protocol command.
- `target.js` — `Target` (RP2040 / RP2350 / CUSTOM) mapping VID/PID and exposing flash geometry (flash start, sector/page size, stack pointer).
- `connection.js` — `Connection`: the active session on a claimed USB interface. Owns the bulk IN/OUT endpoints and a command token counter. `sendCmd(cmd, buf)` is the core: write the 32-byte command, optionally transfer data (IN reads / OUT writes), then a terminal one-byte handshake (ZLP-ish write for IN commands, 1-byte read for OUT commands). High-level methods (`flashErase`, `flashWrite`, `flashRead`, `reboot*`, XIP, OTP, `setExclusiveAccess`) build commands and validate alignment (erase = 4096-byte sector aligned, write = 256-byte page aligned).
- `picoboot.js` — `Picoboot`: device discovery (`requestDevice`, `getDevices`, `fromDevice`), connect/disconnect lifecycle, and convenience one-shot methods (`flashRead`, `flashWrite`, `flashErase`, `flashEraseAndWrite`) that auto-connect, reset the interface, exit XIP, run the op, and auto-disconnect.
- `errors.js` — `PicobootError` base with `UsbError`, `ProtocolError`, `ValidationError`, `NotFoundError`, `StatusError` subclasses. Several carry a `target`.
- `index.js` — barrel re-export for the npm package.

### Stall / error recovery model (critical, non-obvious)

Endpoint stalls are the main failure mode and are handled in two stages, which is easy to get wrong:

1. **Hardware halt**: on a `'stall'` bulk transfer result, `Connection.bulkRead`/`bulkWrite` call `device.clearHalt(...)` immediately. This keeps the host↔device data-toggle PID in sync.
2. **Protocol stall**: the device's protocol state must then be cleared with an `INTERFACE_RESET` control transfer (vendor request `0x41`). This happens implicitly: `getCommandStatus()` is queried after a stall error, its error result triggers `Connection.resetInterface()`. The library relies on this ordering.

Do not "fix" the stall paths by removing the two-step handling — host/device PID desync (the historical bug, per CHANGELOG 0.1.1) requires replugging to recover.

### Website frontend (`js/app.js` + `js/config.js`)

A single UI-controller file wiring up `index.html` by element IDs (Chinese UI). Key patterns:

- Absolute-path imports (`/pkg/picoboot.js`, `/js/uf2/uf2.js`, `/js/config.js`), resolved from the served root — do not switch to relative imports.
- A single global `picoboot` / `connection` pair with a `connected()` guard; all operations go through `checkAndTryConnect()`.
- Every device operation is wrapped in `withDefaultTimeout`/`withTimeout` (Promise.race) plus an estimated-timeout via `calcTimeout` (data length ÷ speed constant, +5s buffer, ×1.1), and drives the progress bar via `setupProgressInterval`/`clearProgressInterval`.
- `tryRecover()` is the frontend counterpart to the stall model: on error it queries `getCommandStatus()` then resets the interface, falling back to a disconnect.
- **Firmware source is a fixed URL** (`FIRMWARE_URL` in `js/config.js`); there is no upload/selection UI. Clicking 烧录固件 (flash) fetches the UF2 fresh every time via `fetchFirmwareData()`, which appends a new `?t=<Date.now()>` cache-buster (`addCacheBuster()`) plus `cache: 'no-store'` so a stale cached copy is never flashed. CORS: a cross-origin `FIRMWARE_URL` requires `Access-Control-Allow-Origin` on the server; hosting the `.uf2` same-origin avoids it.
- After connecting, `updateDeviceInfo()` fills the info panel from `getUsbDeviceInfo()` / `getTarget()`; flash range is derived per target in `flashEndForTarget()` (RP2040 → `0x11000000`, RP2350 → `0x12000000`, since `Target` has no `flashEnd()`).
- OTP has no UI; `Connection.otpWrite` throws a `ValidationError` ("currently disabled for safety reasons") — OTP is one-time-programmable and irreversible.

### UF2 parsing (`js/uf2/uf2.js`)

`uf2ToFlashBuffer(uf2Data)` does a two-pass decode of 512-byte UF2 blocks: first pass finds the min/max address range and collects blocks, second pass copies payloads into a `0xFF`-filled contiguous buffer. Returns `{ address: minAddr, data }`. The first pass **skips container/ignore blocks** (UF2 flags `0x1000`/`0x8000`/`0x10000`/`0x20000`) — multi-file UF2s carry a container header (e.g. at the flash-end address) whose payload isn't flash data; including it would make the buffer span the whole flash window (16MB) and fail on smaller flash. The target firmware here (`pico-hid-mapper`) is such a two-file UF2.

## Conventions

- All files carry a `// Copyright (C) 2025 Piers Finlayson` + `// MIT License` header — keep it on new files.
- Heavy `console.log` instrumentation throughout the library and frontend is intentional (activity log + DevTools debugging). Match the existing log style.
- Numbers are little-endian everywhere (WebUSB `setUint*`/`getUint*` with `true`, and the UF2/picoboot wire formats).
- API.md is the canonical public-API reference for the library; update it alongside any public library changes.
