// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

//
// 配置文件：固件地址与各项常量
//

/** @type {string} 获取稳定版固件 hash 的 KV 接口地址 */
export const FIRMWARE_STABLE_HASH_URL = 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-stable-hash';

/** @type {string} 获取最新版固件 hash 的 KV 接口地址 */
export const FIRMWARE_LATEST_HASH_URL = 'https://kvstore.rd5isto.org/api/kv/pico-hid-mapper-latest-hash';

/** @type {string} 固件 CDN 前缀，拼接 hash 与后缀得到完整下载地址 */
export const FIRMWARE_CDN_PREFIX = 'https://1833788059.cdn.123clouddisk.com/1833788059/direct/projects/pico-hid-mapper/pico-hid-mapper-';

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

/** @type {number} 短 SHA-256 校验值取前几位十六进制字符 */
export const SHA256_SHORT_LENGTH = 8;
