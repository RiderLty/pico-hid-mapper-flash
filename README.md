# pico⚡flash

Use [pico⚡flash](https://picoflash.org) to flash your Raspberry Pi Pico microcontroller directly from your web browser using WebUSB.

Requires Chrome, Edge or another Chromium-based browser with WebUSB support.

Works on Windows, macOS, Linux and Android.

As well as a [website](https://picoflash.org) pico⚡flash is a full Javascript implementation of Raspberry Pi's PICOBOOT protocol, for flashing and managing RP2040 and RP2350 microcontrollers over USB.

## pico-hid-mapper 固件渠道

本站提供默认板稳定版、Pico 2 W 蓝牙稳定版、Waveshare 蓝牙稳定版和默认板最新版（调试构建）。历史渠道选择失效时自动回退默认板稳定版。

基础输入测试直接使用普通固件：未激活设备也可切换 Host 模式，允许鼠标 X/Y、左键和中键，键盘 WASD 与飘号键（`KEY_GRAVE`），以及手柄 Select、RS、RT 按键、左右摇杆和 RT 模拟量。蓝牙固件的未激活手柄使用同样的白名单。完整输入需激活设备。

修改网站源码后运行 `node build-single-html.mjs` 同步生成单文件版本 `picoflash-single.html`。

## Features

- Read, write and erase flash memory
- Reset and reboot the device
- Enter and exit XIP mode (RP2040 only)
- Exclusive access mode to prevent other software from interfering
- Read and write OTP (One-Time Programmable) memory
- Supports RP2040 and RP2350 microcontrollers
- Supports custom VID/PID devices (OTP programmed)
- Web front-end and comprehensive JavaScript API
- Full error handling
- Detailed console logging

## Links

- [Website](https://picoflash.org)
- [GitHub Repository](https://github.com/picoflash/picoflash)
- [piers.rocks YouTube Channel](https://www.youtube.com/@piers_rocks)

## License

[MIT License](LICENSE) - Copyright (C) 2025 Piers Finlayson
