// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

//
// 配置文件：固件地址与各项常量
//

/** @type {string} 获取稳定版固件 hash 的 KV 接口地址 */
export const FIRMWARE_STABLE_HASH_URL = 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-stable-hash';

/** @type {string} 获取 iOS 目标平台稳定版固件 hash 的 KV 接口地址（安卓稳定版沿用上面的 key） */
export const FIRMWARE_STABLE_HASH_IOS_URL = 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-stable-hash-ios';

/** @type {Object<string, string>} 蓝牙板型变体的稳定版 hash KV 接口地址（key 带板型后缀，
 *          与 build.sh 的 KV_SUFFIX 一致；默认板沿用 FIRMWARE_STABLE_HASH_URL 无后缀 key） */
export const FIRMWARE_STABLE_HASH_BOARD_URLS = {
    pico2w: 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-stable-hash-pico2w',
    waveshare_pw: 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-stable-hash-waveshare_pw',
};

/** @type {string} 获取最新版固件 hash 的 KV 接口地址 */
export const FIRMWARE_LATEST_HASH_URL = 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-latest-hash';

/** @type {string} 稳定版固件版本号 KV 接口地址（KV key 沿用 pico-hid-mapper-latest-version） */
export const FIRMWARE_STABLE_VERSION_URL = 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-latest-version';

/** @type {string[]} 固件 CDN 前缀列表：拿到 hash 后同时向所有源发起请求，
 * 取最先完整成功的那一份（见 app.js 的 fetchFastest），全部失败才报错。
 * 目前两个源：123 云盘 WebDAV CDN（老源）、Cloudflare R2 自定义域（新源），
 * 两个源都按 build.sh 约定存放 pico-hid-mapper-<SHA256>.uf2 */
export const FIRMWARE_CDN_PREFIXES = [
    'https://1833788059.cdn.123clouddisk.com/1833788059/direct/projects/pico-hid-mapper/pico-hid-mapper-',
    'https://storage.rd5isto.org/pico-hid-mapper/pico-hid-mapper-',
];

/** @type {string} 固件文件后缀 */
export const FIRMWARE_CDN_SUFFIX = '.uf2';

/** @type {number} 网络获取固件的超时时间（毫秒） */
export const FETCH_TIMEOUT = 30000;

/** @type {number} USB 操作默认超时（毫秒） */
export const DEFAULT_USB_TIMEOUT = 5000;

/** @type {number} 烧录（擦除+写入）综合速度（字节/秒） */
export const FLASH_SPEED = 80 * 1024;

/** @type {number} 重启延迟（毫秒） */
export const DEFAULT_REBOOT_DELAY = 100;

/** @type {number} 板上 flash 芯片实际容量（字节），用于容量显示与整片擦除 */
export const FLASH_SIZE = 2 * 1024 * 1024;

/** @type {number} 短 SHA-256 校验值取前几位十六进制字符 */
export const SHA256_SHORT_LENGTH = 8;

/** @type {string} 使用统计上报地址（statistics.rd5isto.org 写入端点） */
export const STATS_ENDPOINT = 'https://statistics.rd5isto.org/a/4a4c4cf9-7e2a-4abb-a202-53ab864af193';

/** @type {boolean} 是否开启使用统计上报 */
export const STATS_ENABLED = true;

/** @type {string} 统计上报中的站点标识 */
export const STATS_SITE = 'picoflash.org';
