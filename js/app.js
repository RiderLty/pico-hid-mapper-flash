// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

//
// Imports（相对路径，兼容二级目录/根目录/自定义域名部署）
//

import { Picoboot } from '../pkg/picoboot.js';
import { Connection } from '../pkg/connection.js';
import { PicobootStatusCmd } from '../pkg/commands.js';
import { uf2ToFlashBuffer } from './uf2/uf2.js';
import {
    FIRMWARE_STABLE_HASH_URL,
    FIRMWARE_STABLE_HASH_BOARD_URLS,
    FIRMWARE_STABLE_HASH_IOS_URL,
    FIRMWARE_LATEST_HASH_URL,
    FIRMWARE_STABLE_VERSION_URL,
    FIRMWARE_CDN_PREFIXES,
    FIRMWARE_CDN_SUFFIX,
    FETCH_TIMEOUT,
    DEFAULT_USB_TIMEOUT,
    FLASH_SPEED,
    DEFAULT_REBOOT_DELAY,
    FLASH_SIZE,
    USER_CONFIG_REGION_OFFSET,
    USER_CONFIG_REGION_SIZE,
    USER_CONFIG_READ_CHUNK_SIZE,
    SHA256_SHORT_LENGTH,
    STATS_ENDPOINT,
    STATS_ENABLED,
    STATS_SITE,
} from './config.js';

//
// Type definitions
//

/**
 * @typedef {Object} FirmwareData
 * @property {string} name
 * @property {number} address
 * @property {Uint8Array} data
 * @property {number} origSize
 * @property {string} fileType
 * @property {number} downloadSpeed 下载网速（字节/秒）
 * @property {string} sha256Short 下载固件的短 SHA-256 校验值（小写十六进制）
 * @property {string} hash 下载固件所用的版本 hash（CDN 文件名中的那段）
 * @property {string|null} version 稳定版固件版本号（仅稳定版渠道；最新版为 null）
 */

/**
 * @typedef {Object} UsageReport
 * @property {string} site 站点标识
 * @property {'stable'|'stable:pico2w'|'stable:waveshare_pw'|'latest'} channel 固件版本（select 值，
 *          格式 = 渠道[:板型]；最新版为默认板调试通道，蓝牙板仅稳定版）
 * @property {'android'} platform 统计兼容字段，沿用 'android'
 * @property {string} firmwareVersion 稳定版版本号；最新版为 ''
 * @property {string} firmwareHash 最新版固件 hash；稳定版为 ''
 * @property {string|null} target 目标芯片
 * @property {string|null} vidPid
 * @property {string|null} manufacturer
 * @property {string|null} product
 * @property {string|null} serial 设备序列号
 * @property {string|null} usbVersion
 * @property {string|null} deviceVersion
 * @property {string|null} language 浏览器语言
 * @property {number} ts 上报时间戳（毫秒）
 */

//
// Globals
//

/** @type {Picoboot} */
let picoboot = null;
/** @type {Connection} */
let connection = null;
/** @type {string} */
let lastStatus = null;
/** @type {boolean} 是否正在执行获取/烧录/重启等操作（防止重复点击） */
let busy = false;

/** @type {'stable'|'stable:pico2w'|'stable:waveshare_pw'|'latest'} 当前固件版本（select 值，
 *          格式 = 渠道[:板型]；蓝牙板仅稳定版） */
let firmwareChannel = 'stable';

/** localStorage 键：记住用户上次选择的固件版本 */
const FIRMWARE_CHANNEL_STORAGE_KEY = 'picoflash-firmware-channel';

// Progress bar
/** @type {number} */
let progressPercent = 0;
/** @type {HTMLElement} */
const progressFill = document.getElementById('progressFill');
/** @type {HTMLElement} */
const progressPercentText = document.getElementById('progressPercentText');

// 连接按钮
const connectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('connectBtn'));

// 状态行
/** @type {HTMLElement} */
const statusLine = document.getElementById('statusLine');

// 设备信息面板
/** @type {HTMLElement} */
const deviceInfoPanel = document.getElementById('deviceInfoPanel');
/** @type {HTMLElement} */
const deviceTarget = document.getElementById('deviceTarget');
/** @type {HTMLElement} */
const deviceVidPid = document.getElementById('deviceVidPid');
/** @type {HTMLElement} */
const deviceManufacturer = document.getElementById('deviceManufacturer');
/** @type {HTMLElement} */
const deviceProduct = document.getElementById('deviceProduct');
/** @type {HTMLElement} */
const deviceSerial = document.getElementById('deviceSerial');
/** @type {HTMLElement} */
const deviceUsbVersion = document.getElementById('deviceUsbVersion');
/** @type {HTMLElement} */
const deviceDeviceVersion = document.getElementById('deviceDeviceVersion');
/** @type {HTMLElement} */
const deviceFlashRange = document.getElementById('deviceFlashRange');
/** @type {HTMLElement} */
const deviceSector = document.getElementById('deviceSector');
/** @type {HTMLElement} */
const devicePage = document.getElementById('devicePage');

// 烧录操作
const flashBtn = /** @type {HTMLButtonElement} */ (document.getElementById('flashBtn'));
const eraseBtn = /** @type {HTMLButtonElement} */ (document.getElementById('eraseBtn'));

// 用户配置导出/导入
const exportConfigBtn = /** @type {HTMLButtonElement} */ (document.getElementById('exportConfigBtn'));
const importConfigBtn = /** @type {HTMLButtonElement} */ (document.getElementById('importConfigBtn'));
const importConfigFile = /** @type {HTMLInputElement} */ (document.getElementById('importConfigFile'));

// 活动日志
/** @type {HTMLElement} */
const activityContent = document.getElementById('activityContent');

// 固件版本选择（自绘下拉，value = 渠道[:板型]）
const firmwareTrigger = /** @type {HTMLButtonElement} */ (document.getElementById('firmwareTrigger'));
const firmwareTriggerLabel = document.getElementById('firmwareTriggerLabel');
const firmwareTriggerDot = document.getElementById('firmwareTriggerDot');
const firmwareMenu = document.getElementById('firmwareMenu');
/** 版本值 → 触发器圆点配色类（与 version-item 内的圆点一致） */
const CHANNEL_DOT_CLASS = {
    stable: 'dot-success',
    'stable:pico2w': 'dot-success',
    'stable:waveshare_pw': 'dot-success',
    latest: 'dot-latest',
};
const firmwareHint = document.getElementById('firmwareHint');
const downloadBtn = /** @type {HTMLButtonElement} */ (document.getElementById('downloadBtn'));
const webusbModal = document.getElementById('webusbModal');
const modalCloseBtn = /** @type {HTMLButtonElement} */ (document.getElementById('modalCloseBtn'));

//
// 日志与格式化
//

/**
 * 启动代码。
 * @return {void}
 */
function startup() {
    // 记录已加载
    logActivity('picoflash 已加载', 'info');

    // 恢复上次选择的固件版本（默认稳定版）
    firmwareChannel = loadFirmwareChannel();
    updateVersionUi();

    // WebUSB 可用：在线烧录是唯一路径，不展示「下载固件」按钮（HTML 中默认 hidden）
    // WebUSB 不可用：弹窗告知，并把「烧录固件」替换为「下载固件」——
    // 不支持的环境只允许下载，不允许在线烧录（擦除 / 连接同样禁用）
    if (!('usb' in navigator)) {
        showWebusbModal();
        flashBtn.hidden = true;
        // 下载固件成为此环境下唯一可用操作，升级为主按钮样式
        downloadBtn.hidden = false;
        downloadBtn.classList.add('btn-primary');
        eraseBtn.disabled = true;
        connectBtn.disabled = true;
        updateStatus('当前浏览器不支持 WebUSB，可下载固件后手动烧录');
        logActivity('当前浏览器不支持 WebUSB：已切换为下载固件 + 手动烧录模式', 'info');
    }

    // 更新界面
    updateUi();
}

/**
 * 把字节数格式化为可读字符串。
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * 把网速（字节/秒）格式化为可读字符串。
 * @param {number} bps
 * @returns {string}
 */
function formatSpeed(bps) {
    if (bps >= 1024 * 1024) return (bps / (1024 * 1024)).toFixed(2) + ' MB/s';
    return (bps / 1024).toFixed(1) + ' KB/s';
}

/**
 * 写入一条活动日志（同时写入控制台）。
 * @param {string} message
 * @param {string} type
 * @return {void}
 */
function logActivity(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.textContent = `[${timestamp}] ${message}`;

    if (type === 'error') {
        console.error(entry.textContent);
    } else {
        console.log(entry.textContent);
    }

    activityContent.appendChild(entry);
    activityContent.scrollTop = activityContent.scrollHeight; // 自动滚动到底部
}

/**
 * 是否已建立完整连接。
 * @returns {boolean}
 */
function connected() {
    return (connection != null && picoboot != null);
}

/**
 * 是否已选择设备（即使连接失败也算）。
 * @returns {boolean}
 */
function hasDevice() {
    return picoboot != null;
}

/**
 * 更新状态显示。
 * @param {string} message
 * @return {void}
 */
function updateStatus(message) {
    lastStatus = message;
    updateStatusDisplay();
}

/**
 * 填充设备信息面板。
 * @return {void}
 */
function updateDeviceInfo() {
    if (!picoboot) {
        deviceInfoPanel.classList.add('hidden');
        return;
    }

    const info = picoboot.getUsbDeviceInfo();
    const target = picoboot.getTarget();
    const start = target.flashStart();
    const rangeEnd = start + FLASH_SIZE;

    deviceTarget.textContent = target.toString();
    deviceVidPid.textContent = `${info.vendorId.toString(16).padStart(4, '0')}:${info.productId.toString(16).padStart(4, '0')}`;
    deviceManufacturer.textContent = info.manufacturerName || '-';
    deviceProduct.textContent = info.productName || '-';
    deviceSerial.textContent = info.serialNumber || '-';
    deviceUsbVersion.textContent = `${info.usbVersionMajor}.${info.usbVersionMinor}.${info.usbVersionSubminor}`;
    deviceDeviceVersion.textContent = `${info.deviceVersionMajor}.${info.deviceVersionMinor}.${info.deviceVersionSubminor}`;
    deviceFlashRange.textContent = `0x${start.toString(16)} - 0x${rangeEnd.toString(16)}（${formatBytes(FLASH_SIZE)}）`;
    deviceSector.textContent = formatBytes(target.flashSectorSize());
    devicePage.textContent = formatBytes(target.flashPageSize());

    deviceInfoPanel.classList.remove('hidden');
}

/**
 * 更新进度条显示。
 * @param {boolean} error
 * @return {void}
 */
function updateProgress(error = false) {
    if (!connected()) {
        progressPercent = 0;
    }

    progressFill.style.width = `${progressPercent}%`;
    progressPercentText.textContent = progressPercent > 0 ? `${Math.round(progressPercent)}%` : '待机';

    if (error) {
        progressFill.style.backgroundColor = 'var(--color-danger)';
    } else {
        progressFill.style.backgroundColor = 'var(--color-accent)';
    }
}

//
// 按钮状态
//

/**
 * 更新连接按钮。
 * @return {void}
 */
function updateConnectBtn() {
    connectBtn.disabled = busy;
    connectBtn.textContent = connected() ? '断开连接' : '连接设备';
}

/**
 * 更新烧录按钮。每次烧录时都会重新拉取固件，因此只要不忙即可点击。
 * @return {void}
 */
function updateFlashBtn() {
    flashBtn.disabled = busy;
}

/**
 * 更新清空flash按钮。
 * @return {void}
 */
function updateEraseBtn() {
    eraseBtn.disabled = busy;
}

/**
 * 更新用户配置导出/导入按钮。
 * WebUSB 不可用时无法连接设备，两个按钮都禁用。
 * @return {void}
 */
function updateConfigBtns() {
    const supported = 'usb' in navigator;
    exportConfigBtn.disabled = busy || !supported;
    importConfigBtn.disabled = busy || !supported;
}

/**
 * 更新状态行。
 * @return {void}
 */
function updateStatusDisplay() {
    let statusText = '未连接';
    if (lastStatus) {
        statusText = lastStatus;
    } else if (connected()) {
        statusText = '已连接';
    }
    statusLine.textContent = statusText;
}

/**
 * 更新全部界面元素。
 * @return {void}
 */
function updateUi() {
    updateStatusDisplay();
    updateDeviceInfo();
    updateConnectBtn();
    updateFlashBtn();
    updateEraseBtn();
    updateConfigBtns();
    updateProgress();
}

//
// 超时与进度工具
//

/**
 * 给一个 Promise 包装超时。
 * @param {() => Promise<any>} promiseFn
 * @param {number} timeoutMs
 * @param {string} operation
 * @returns {Promise<any>}
 */
async function withTimeout(promiseFn, timeoutMs, operation) {
    // 超时时间按 100ms 取整
    const roundedTimeout = Math.round(timeoutMs / 100) * 100;

    return Promise.race([
        promiseFn(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${operation} 超时（${roundedTimeout}ms）`)), roundedTimeout)
        ),
    ]);
}

/**
 * 给一个 Promise 包装默认超时。
 * @param {() => Promise<any>} promiseFn
 * @param {string} operation
 * @returns {Promise<any>}
 */
async function withDefaultTimeout(promiseFn, operation = '操作') {
    return withTimeout(promiseFn, DEFAULT_USB_TIMEOUT, operation);
}

/**
 * 计算基于数据长度和速度的预计耗时。
 * @param {number} length
 * @param {number} bps
 * @returns {number}
 */
function calcTimeout(length, bps) {
    const timeoutMs = 1000 * length / bps;

    const timeoutFixed = timeoutMs + 5000; // 加 5 秒缓冲
    const timeoutVar = timeoutFixed * 1.1; // 10% 余量

    const max = Math.max(timeoutFixed, timeoutVar);

    console.log(`预计耗时：固定 ${timeoutFixed}ms，余量 ${timeoutVar}ms，使用 ${max}ms`);

    return max;
}

/**
 * 初始化进度条并启动定时更新。
 * @param {number} length
 * @param {number} bps
 * @returns {number}
 */
function setupProgressInterval(length, bps) {
    progressPercent = 1;
    updateProgress();

    const estimatedTimeMs = (length / bps) * 1000;

    const startTime = Date.now();
    return setInterval(() => {
        const elapsed = Date.now() - startTime;
        const estimatedProgress = Math.min(95, Math.floor((elapsed / estimatedTimeMs) * 100));
        progressPercent = estimatedProgress;
        updateProgress();
    }, 100);
}

/**
 * 停止进度定时器并设置最终百分比。
 * @param {number} intervalId
 * @param {number} percent
 * @param {boolean} error
 * @return {void}
 */
function clearProgressInterval(intervalId, percent, error = false) {
    clearInterval(intervalId);
    progressPercent = percent;
    updateProgress(error);
}

//
// 设备连接
//

/**
 * 连接设备：请求授权、填充设备信息、建立连接。
 * @returns {Promise<void>}
 */
async function connect() {
    updateStatus('连接中…');

    // 请求用户选择设备
    try {
        picoboot = await Picoboot.requestDevice();
        console.log('已选择设备：', picoboot.getTarget().toString());
    } catch (error) {
        if (error.message.includes('cancelled')) {
            updateStatus('未选择设备');
            logActivity('设备选择已取消', 'info');
        } else if (error.message.includes('not supported') && error.message.includes('browser')) {
            updateStatus('浏览器不支持 WebUSB');
            logActivity('错误：浏览器不支持 WebUSB', 'error');
        } else {
            updateStatus('连接错误');
            logActivity(`错误：${error.message}`, 'error');
        }
        return;
    }

    // 立即填充设备信息（requestDevice 后即可用）
    updateDeviceInfo();

    // 建立连接
    try {
        const info = picoboot.getUsbDeviceInfo();
        logActivity(`已选择：${picoboot.getTarget().toString()} - ${info.manufacturerName || '-'} ${info.productName || '-'}`, 'info');

        connection = await withDefaultTimeout(
            async () => picoboot.connect(),
            '连接设备'
        );
        await withDefaultTimeout(
            async () => picoboot.resetInterface(),
            '重置接口'
        );

        logActivity('连接成功', 'success');
        updateStatus('已连接');
    } catch (e) {
        logActivity(`错误：${e.message}`, 'error');
        connection = null;
        picoboot = null;
        updateStatus('连接错误');
    }
}

/**
 * 断开连接。失败时抛出错误。
 * @returns {Promise<void>}
 */
async function disconnect() {
    if (!connected()) {
        connection = null;
        picoboot = null;
        console.log('没有已连接的设备');
        throw new Error('没有已连接的设备');
    }

    try {
        await withDefaultTimeout(
            async () => picoboot.disconnect(),
            '断开连接'
        );
        console.log('已断开连接');
    } catch (error) {
        console.log(`断开连接时出错：${error.message}`);
        connection = null;
        picoboot = null;
        throw error;
    }

    connection = null;
    picoboot = null;
}

/**
 * 断开连接，不抛错。
 * @returns {Promise<void>}
 */
async function disconnectNoThrow() {
    try {
        await disconnect();
        updateStatus('已断开连接');
        logActivity('已断开连接', 'success');
    } catch (error) {
        updateStatus('断开连接出错');
        logActivity(`断开连接出错：${error.message}`, 'error');
    }
}

/**
 * 检查是否已连接，未连接则尝试连接。
 * @returns {Promise<boolean>}
 */
async function checkAndTryConnect() {
    if (connected()) {
        return true;
    }

    await connect();
    updateUi();

    if (connected()) {
        return true;
    } else {
        logActivity('未连接设备，无法继续', 'error');
        updateStatus('未连接设备');
        return false;
    }
}

/**
 * 重启设备到应用程序，然后断开连接。
 * 由烧录流程在烧录成功后自动调用。
 * 出错时不抛异常，只记录日志。
 * @returns {Promise<void>}
 */
async function rebootAndDisconnect() {
    updateStatus('正在重启…');

    let rebootFailed = true;
    try {
        await withDefaultTimeout(
            async () => connection.reboot(DEFAULT_REBOOT_DELAY),
            '重启设备'
        );
        rebootFailed = false;
    } catch (error) {
        logActivity(`重启出错：${error.message}`, 'error');
    }

    // 无论重启成功与否都断开连接
    try {
        await withDefaultTimeout(
            async () => picoboot.disconnect(),
            '断开连接'
        );
    } catch (error) {
        logActivity(`断开连接出错：${error.message}`, 'error');
        if (!rebootFailed) {
            updateStatus('断开连接出错');
        }
    }

    connection = null;
    picoboot = null;

    if (rebootFailed) {
        updateStatus('重启失败');
    } else {
        logActivity('设备已重启', 'success');
        updateStatus('已重启（已断开）');
    }
}

/** 更新当前固件说明文案（跟随版本选择变化）。 */
function updateFirmwareHint() {
    if (!firmwareHint) return;

    if (firmwareChannel === 'stable:pico2w') {
        firmwareHint.textContent = '将烧录 Pico 2 W 蓝牙变体固件（DS5 蓝牙直连，无 Host 口），每次烧录前自动检查更新';
    } else if (firmwareChannel === 'stable:waveshare_pw') {
        firmwareHint.textContent = '将烧录 Waveshare 无线板蓝牙变体固件（DS5 蓝牙直连，无 Host 口），每次烧录前自动检查更新';
    } else if (firmwareChannel === 'latest') {
        firmwareHint.textContent = '最新版为默认板调试构建：每次烧录前自动拉取最新构建';
    } else {
        firmwareHint.textContent = '将烧录稳定版固件（默认板，固件自动适配设备平台），每次烧录前自动检查更新';
    }
}

//
// 固件版本切换
//

/**
 * 从 localStorage 读取上次选择的固件版本，默认稳定版。
 * 已移除或无法识别的历史选择回退稳定版。
 * @returns {'stable'|'stable:pico2w'|'stable:waveshare_pw'|'latest'}
 */
function loadFirmwareChannel() {
    try {
        const saved = localStorage.getItem(FIRMWARE_CHANNEL_STORAGE_KEY);
        if (saved === 'stable' || saved === 'stable:pico2w' ||
            saved === 'stable:waveshare_pw' || saved === 'latest') {
            return saved;
        }
    } catch {
        // localStorage 不可用（隐私模式等），回退默认值
    }
    return 'stable';
}

/**
 * 设置固件版本，更新 UI 并持久化。
 * @param {'stable'|'stable:pico2w'|'stable:waveshare_pw'|'latest'} channel
 * @return {void}
 */
function setFirmwareChannel(channel) {
    if (channel === firmwareChannel) return;

    firmwareChannel = channel;
    try {
        localStorage.setItem(FIRMWARE_CHANNEL_STORAGE_KEY, channel);
    } catch {
        // 忽略持久化失败
    }
    updateVersionUi();
    logActivity(`固件版本已切换为：${channelLabel()}`, 'info');
}

/**
 * 同步下拉触发器（圆点/文案）与菜单项选中态。
 * @return {void}
 */
function updateVersionUi() {
    if (firmwareTriggerLabel) firmwareTriggerLabel.textContent = channelLabel();
    if (firmwareTriggerDot) {
        firmwareTriggerDot.className = `version-dot ${CHANNEL_DOT_CLASS[firmwareChannel] || 'dot-success'}`;
    }
    if (firmwareMenu) {
        for (const item of firmwareMenu.querySelectorAll('.version-item')) {
            const active = item.dataset.value === firmwareChannel;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-selected', String(active));
        }
    }
    updateFirmwareHint();
}

/** 展开收起版本菜单。 */
function setVersionMenuOpen(open) {
    if (!firmwareMenu || !firmwareTrigger) return;
    firmwareMenu.hidden = !open;
    firmwareTrigger.setAttribute('aria-expanded', String(open));
}

function isVersionMenuOpen() {
    return !!firmwareMenu && !firmwareMenu.hidden;
}

//
// 固件获取
//

/**
 * 给 URL 追加一个不同的时间戳参数，保证每次请求不命中缓存。
 * @param {string} url
 * @returns {string}
 */
function addCacheBuster(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}t=${Date.now()}`;
}

/**
 * 当前选择的版本 hash 接口地址。
 * 稳定版按板型分 KV key（-pico2w / -waveshare_pw 后缀，与 build.sh 的 KV_SUFFIX 一致）；
 * 默认板稳定版沿用无后缀 key，与旧烧录页兼容；最新版（默认板调试通道）走 latest-hash。
 * 注：iOS 曾按平台分 KV key（-ios 后缀），平台合并进渠道后不再区分。
 * @returns {string}
 */
function getFirmwareHashUrl() {
    if (firmwareChannel === 'latest') {
        return FIRMWARE_LATEST_HASH_URL;
    }
    const sep = firmwareChannel.indexOf(':');
    if (sep >= 0) {
        const board = firmwareChannel.slice(sep + 1);
        const url = FIRMWARE_STABLE_HASH_BOARD_URLS[board];
        if (url) return url;
    }
    return FIRMWARE_STABLE_HASH_URL;
}

/** 版本展示文案（日志用）。 */
function channelLabel() {
    switch (firmwareChannel) {
        case 'latest': return '最新版';
        case 'stable:pico2w': return '稳定版 · Pico 2 W（蓝牙）';
        case 'stable:waveshare_pw': return '稳定版 · Waveshare（蓝牙）';
        default: return '稳定版';
    }
}

/**
 * 解析当前渠道对应的固件下载地址、文件名与版本 hash。
 * 先用 hash 接口取版本，再拼出**所有 CDN 源**的下载地址（多源竞速，见 fetchFastest）。
 * @returns {Promise<{urls: string[], fileName: string, hash: string}>}
 */
async function resolveFirmwareSource() {
    const hashUrl = addCacheBuster(getFirmwareHashUrl());
    const hashRes = await withTimeout(
        async () => fetch(hashUrl, { cache: 'no-store' }),
        FETCH_TIMEOUT,
        '获取版本'
    );
    if (!hashRes.ok) {
        throw new Error(`获取版本失败：HTTP ${hashRes.status}`);
    }
    const hashJson = await hashRes.json();
    const hash = hashJson.value;
    if (!hash) {
        throw new Error('版本接口未返回 hash');
    }

    return {
        urls: FIRMWARE_CDN_PREFIXES.map(prefix => `${prefix}${hash}${FIRMWARE_CDN_SUFFIX}`),
        fileName: `pico-hid-mapper-${hash}.uf2`,
        hash,
    };
}

/**
 * 从 URL 里取展示用的源标签（主机名），日志里区分固件来自哪个 CDN。
 * @param {string} url
 * @returns {string}
 */
function cdnLabel(url) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * 多源竞速下载：同时向所有候选地址发起请求，**最先完整成功的那份胜出**，
 * 其余立即 abort（省流量、不占连接）；全部失败才抛错，错误信息聚合各源原因。
 * 每个请求都带新的缓存规避参数，并挂各自的 AbortController——超时 / 落败都能真正取消底层请求。
 * @param {string[]} urls 候选下载地址列表
 * @param {string} operation 超时提示里的操作名（如「获取固件」）
 * @returns {Promise<{url: string, buf: ArrayBuffer}>}
 */
async function fetchFastest(urls, operation) {
    const controllers = urls.map(() => new AbortController());
    const attempts = urls.map(async (url, i) => {
        const res = await withTimeout(
            async () => fetch(addCacheBuster(url), { cache: 'no-store', signal: controllers[i].signal }),
            FETCH_TIMEOUT,
            operation
        );
        if (!res.ok) {
            throw new Error(`${cdnLabel(url)}: HTTP ${res.status} ${res.statusText}`);
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) {
            throw new Error(`${cdnLabel(url)}: 空响应`);
        }
        return { url, buf };
    });

    try {
        const winner = await Promise.any(attempts);
        // 输家立刻中止；注意不能中止自己（虽是同一对象，abort 了也不影响已完成的响应，但仍显式排除）
        controllers.forEach((controller, i) => {
            if (urls[i] !== winner.url) controller.abort();
        });
        logActivity(`固件来自 ${cdnLabel(winner.url)}`, 'info');
        return winner;
    } catch (err) {
        if (err instanceof AggregateError) {
            const details = err.errors.map(e => e.message).join('；');
            throw new Error(`所有下载源均失败（${details}）`);
        }
        throw err;
    }
}

/**
 * 直接把当前所选渠道 / 平台的 UF2 固件下载为文件（不经 WebUSB）。
 * 供不支持 WebUSB 的浏览器走"下载 + 系统拖拽烧录"路径，也可随时手动取固件。
 * @returns {Promise<void>}
 */
async function downloadFirmwareFile() {
    try {
        updateStatus('获取固件下载地址…');
        const { urls, fileName } = await resolveFirmwareSource();

        updateStatus('下载固件中…');
        logActivity(`下载固件（${channelLabel()}）…`, 'info');
        const { buf } = await fetchFastest(urls, '下载固件');
        const blob = new Blob([buf]);
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        updateStatus('固件已下载');
        logActivity(`固件已下载：${fileName}（${formatBytes(blob.size)}）`, 'info');
    } catch (error) {
        updateStatus('下载失败');
        logActivity(`错误：${error.message}`, 'error');
    }
}

/** 显示 WebUSB 不可用引导弹窗。 */
function showWebusbModal() {
    if (webusbModal) webusbModal.hidden = false;
}

/** 关闭引导弹窗。 */
function hideWebusbModal() {
    if (webusbModal) webusbModal.hidden = true;
}

/**
 * 获取稳定版固件版本号（仅稳定版渠道有版本标签）。
 * 失败时返回 null，不抛错——版本号只用于日志展示，不影响烧录。
 * @returns {Promise<string|null>}
 */
async function fetchFirmwareVersion() {
    const url = addCacheBuster(FIRMWARE_STABLE_VERSION_URL);
    try {
        const res = await withTimeout(
            async () => fetch(url, { cache: 'no-store' }),
            FETCH_TIMEOUT,
            '获取版本号'
        );
        if (!res.ok) {
            return null;
        }
        const json = await res.json();
        const value = json.value;
        return (typeof value === 'string' && value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * 从指定地址（单个或多个 CDN 源）下载并解析 UF2 固件（用于烧录固件）。
 * 传数组时走多源竞速（fetchFastest）：同时请求、最先成功者胜出、其余中止，
 * 全部失败才抛错。每次调用都会带新的缓存规避参数，保证不命中缓存。
 * @param {string|string[]} url 固件 UF2 下载地址（单源传字符串，多源传数组）
 * @param {string} fileName 固件文件名（用于日志与展示）
 * @param {string} hash 固件版本 hash（用于统计上报）
 * @returns {Promise<FirmwareData>}
 */
async function downloadUf2(url, fileName, hash = '') {
    const urls = Array.isArray(url) ? url : [url];
    const startTime = Date.now();
    const { buf } = await fetchFastest(urls, '获取固件');
    const uf2Data = new Uint8Array(buf);
    const elapsedMs = Date.now() - startTime;
    const downloadSpeed = elapsedMs > 0 ? (uf2Data.length * 1000) / elapsedMs : 0;

    // 对下载的 UF2 字节计算 SHA-256，取前几位作为校验值
    const hashBuf = await crypto.subtle.digest('SHA-256', uf2Data);
    const hashHex = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    const sha256Short = hashHex.slice(0, SHA256_SHORT_LENGTH);

    const { address, data } = uf2ToFlashBuffer(uf2Data);

    return { name: fileName, address, data, origSize: uf2Data.length, fileType: 'uf2', downloadSpeed, sha256Short, hash, version: null };
}

/**
 * 从固定 URL 拉取并解析 UF2 固件。
 * 每次调用都会带新的缓存规避参数；失败时抛错。
 * @returns {Promise<FirmwareData>}
 */
async function fetchFirmwareData() {
    logActivity(`获取固件中（${channelLabel()}）…`, 'info');

    // 1. 解析当前渠道 / 平台的固件地址（全部 CDN 源）与版本 hash
    const { urls, fileName, hash } = await resolveFirmwareSource();

    // 2. 下载并解析（多源竞速）
    const firmware = await downloadUf2(urls, fileName, hash);

    // 3. 稳定版附带获取版本号（仅日志展示用，失败不影响烧录；
    //    最新版没有版本号，不适用）
    if (firmwareChannel.startsWith('stable')) {
        firmware.version = await fetchFirmwareVersion();
    }

    return firmware;
}

//
// 使用统计上报
//

/**
 * 组装一次烧录上报的数据。
 *
 * 上报的固件标识只取"用户当前选中的渠道"对应的那一个：
 * - 稳定版：版本号（version），例如 3.3.1
 * - 最新版：固件 hash
 *
 * 设备信息取自已选择的 USB 设备（可能为 null —— 用户点了烧录但还没选设备）。
 *
 * @param {FirmwareData|null} firmware 已获取的固件信息，未获取到时为 null
 * @returns {UsageReport}
 */
function buildUsageReport(firmware) {
    /** @type {UsageReport} */
    const report = {
        site: STATS_SITE,
        channel: firmwareChannel,
        platform: 'android',
        firmwareVersion: (firmware && firmware.version) || '',
        firmwareHash: (firmware && firmware.hash) || '',
        target: null,
        vidPid: null,
        manufacturer: null,
        product: null,
        serial: null,
        usbVersion: null,
        deviceVersion: null,
        language: navigator.language || '',
        ts: Date.now(),
    };

    // 没有已选择的设备时，设备相关字段保持 null（WebUSB 不允许在用户选择前读取设备信息）
    if (!picoboot) {
        return report;
    }

    try {
        const info = picoboot.getUsbDeviceInfo();
        const target = picoboot.getTarget();

        report.target = target.toString();
        report.vidPid = `${info.vendorId.toString(16).padStart(4, '0')}:${info.productId.toString(16).padStart(4, '0')}`;
        report.manufacturer = info.manufacturerName || null;
        report.product = info.productName || null;
        report.serial = info.serialNumber || null;
        report.usbVersion = `${info.usbVersionMajor}.${info.usbVersionMinor}.${info.usbVersionSubminor}`;
        report.deviceVersion = `${info.deviceVersionMajor}.${info.deviceVersionMinor}.${info.deviceVersionSubminor}`;
    } catch (error) {
        console.log(`读取设备信息用于上报时出错：${error.message}`);
    }

    return report;
}

/**
 * 上报一次使用统计。
 *
 * 统计属于"尽力而为"：任何失败都只写控制台，绝不抛错、绝不阻塞或打断烧录流程。
 * 优先用 sendBeacon（浏览器后台发送，不受页面关闭影响），失败再退回 fetch。
 *
 * @param {FirmwareData|null} firmware 已获取的固件信息，未获取到时为 null
 * @return {void}
 */
function reportFlashStart(firmware) {
    if (!STATS_ENABLED) {
        return;
    }

    const report = buildUsageReport(firmware);
    console.log('使用统计上报：', report);

    let body;
    try {
        body = JSON.stringify(report);
    } catch (error) {
        console.log(`统计上报序列化失败：${error.message}`);
        return;
    }

    // sendBeacon 不需要等待响应，也不会因为用户切走页面而中断
    try {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon && navigator.sendBeacon(STATS_ENDPOINT, blob)) {
            console.log('使用统计已通过 sendBeacon 发送');
            return;
        }
    } catch (error) {
        console.log(`sendBeacon 上报失败，改用 fetch：${error.message}`);
    }

    // 兜底：keepalive 让请求在页面卸载后仍能完成
    fetch(STATS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        mode: 'cors',
    })
        .then((res) => console.log(`使用统计已通过 fetch 发送：HTTP ${res.status}`))
        .catch((error) => console.log(`使用统计上报失败（已忽略）：${error.message}`));
}

//
// 烧录
//

/**
 * 烧录流程：每次点击都先重新拉取固件，再连接设备并烧录，成功后自动重启。
 * @returns {Promise<void>}
 */
async function flash() {
    if (busy) return;

    busy = true;
    updateUi();
    updateStatus('正在获取固件…');

    // 1. 每次烧录都重新拉取固件（带新的缓存规避参数）
    let firmware;
    try {
        firmware = await fetchFirmwareData();
        logActivity(`固件获取成功：[${firmware.sha256Short}] ${formatBytes(firmware.origSize)} , ${formatSpeed(firmware.downloadSpeed)} ，flashSize ${formatBytes(firmware.data.length)}`, 'success');
    } catch (error) {
        logActivity(`获取固件失败：${error.message}`, 'error');
        updateStatus('获取固件失败');
        busy = false;
        updateUi();
        return;
    }

    // 2. 上报本次烧录（此时固件信息已可用；上报失败不影响烧录）
    reportFlashStart(firmware);

    // 3. 连接设备（未连接则先请求选择设备）
    if (!(await checkAndTryConnect())) {
        busy = false;
        updateUi();
        return;
    }

    // 4. 烧录
    updateStatus('正在烧录…');

    // 初始化进度条并计算预计耗时
    const progressInterval = setupProgressInterval(firmware.data.length, FLASH_SPEED);
    const timeoutMs = calcTimeout(firmware.data.length, FLASH_SPEED);

    try {
        const firmwareLabel = firmware.version || `[${firmware.sha256Short}]`;
        logActivity(`正在烧录 ${firmwareLabel}（${formatBytes(firmware.data.length)}）…`, 'info');
        await withTimeout(
            async () => picoboot.flashEraseAndWrite(firmware.address, firmware.data),
            timeoutMs,
            '烧录固件'
        );

        clearProgressInterval(progressInterval, 100);

        logActivity('烧录成功', 'success');
        updateStatus('烧录完成');

        // 烧录成功后自动重启设备
        await rebootAndDisconnect();
    } catch (error) {
        clearProgressInterval(progressInterval, 100, true);
        logActivity(`烧录失败：${error.message}`, 'error');
        if (await tryRecover()) {
            updateStatus('烧录失败');
        } else {
            updateStatus('烧录失败（已断开）');
        }
    } finally {
        busy = false;
        updateUi();
    }
}

//
// 清空flash
//

/**
 * 清空flash流程：通过 PICOBOOT 直接擦除整片 flash（FLASH_SIZE 固定 2MB），
 * 不再借助擦除固件。擦除后为空白 flash（全 0xFF），
 * 设备始终处于 BOOTSEL 模式，擦除完成后可直接重新烧录固件。
 * @returns {Promise<void>}
 */
async function eraseFlash() {
    if (busy) return;

    // 二次确认放在 busy=true 之前，取消时不闪禁用态
    const ok = window.confirm('清空flash 将直接擦除整片 2MB flash：\n\n固件和所有已保存的数据都会被删除，擦除后设备保持在 BOOTSEL 模式，之后需重新烧录固件。确定继续吗？');
    if (!ok) {
        logActivity('已取消清空flash', 'info');
        return;
    }

    busy = true;
    updateUi();

    // 1. 连接设备（未连接则先请求选择设备）
    if (!(await checkAndTryConnect())) {
        busy = false;
        updateUi();
        return;
    }

    const start = picoboot.getTarget().flashStart();
    updateStatus('正在擦除整片 flash…');

    // 整片擦除耗时按烧录综合速度估算（实际擦除比擦+写更快，此估算偏保守）
    const progressInterval = setupProgressInterval(FLASH_SIZE, FLASH_SPEED);
    const timeoutMs = calcTimeout(FLASH_SIZE, FLASH_SPEED);

    try {
        logActivity(`正在擦除整片 flash：0x${start.toString(16)} - 0x${(start + FLASH_SIZE).toString(16)}（${formatBytes(FLASH_SIZE)}）…`, 'info');
        await withTimeout(
            async () => picoboot.flashErase(start, FLASH_SIZE),
            timeoutMs,
            '整片擦除'
        );

        clearProgressInterval(progressInterval, 100);
        logActivity('flash 已全部擦除（空白态 0xFF）', 'success');

        // 2. 断开连接；无需重启，设备本就处于 BOOTSEL 模式
        await disconnectNoThrow();
        updateStatus('清空完成（BOOTSEL 模式）');
        logActivity('清空完成后请重新烧录固件', 'warning');
    } catch (error) {
        clearProgressInterval(progressInterval, 100, true);
        logActivity(`清空失败：${error.message}`, 'error');
        if (await tryRecover()) {
            updateStatus('清空失败');
        } else {
            updateStatus('清空失败（已断开）');
        }
    } finally {
        busy = false;
        updateUi();
    }
}

//
// 用户配置导出/导入（flash 尾部 Lua + KV 区）
//

/**
 * 用户配置区在设备上的绝对地址（XIP 地址）。
 * @returns {number}
 */
function userConfigAddress() {
    return picoboot.getTarget().flashStart() + USER_CONFIG_REGION_OFFSET;
}

/**
 * 用户配置区依赖 pico-hid-mapper 的 RP2350 2MB flash 布局。
 * @returns {boolean}
 */
function checkConfigTarget() {
    if (!picoboot || picoboot.getTarget().type !== 'RP2350') {
        logActivity('用户配置功能仅支持 RP2350（pico-hid-mapper）设备', 'error');
        updateStatus('当前设备不支持用户配置');
        return false;
    }
    return true;
}

/**
 * 计算字节内容的 SHA-256（小写十六进制）。
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * 用户配置导出文件名（带本地时间戳）。
 * @returns {string}
 */
function configFileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `pico-hid-mapper-config-${stamp}.bin`;
}

/**
 * 触发浏览器下载一段字节。
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @return {void}
 */
function downloadBytes(bytes, fileName) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
}

/**
 * 分块读取一段 flash。
 * 先重置接口并退出 XIP（与 Picoboot.flashRead 的内部行为一致），
 * 之后用 Connection.flashRead 连续读取，避免每块都重复 reset/exitXip。
 * @param {number} address
 * @param {number} size
 * @param {(read: number, total: number) => void} onProgress
 * @returns {Promise<Uint8Array>}
 */
async function readFlashRegion(address, size, onProgress) {
    if (!picoboot || !connection) {
        throw new Error('没有已连接设备');
    }

    await connection.resetInterface();
    await connection.exitXip();

    const data = new Uint8Array(size);
    let offset = 0;

    while (offset < size) {
        const len = Math.min(USER_CONFIG_READ_CHUNK_SIZE, size - offset);
        const chunk = await connection.flashRead(address + offset, len);

        if (chunk.length !== len) {
            throw new Error(`读取长度不符：预期 ${len} 字节，实际 ${chunk.length} 字节`);
        }

        data.set(chunk, offset);
        offset += len;
        onProgress(offset, size);
    }

    return data;
}

/**
 * 导出用户配置区（Lua 脚本 + KV 设置），下载为 bin 文件。
 * @returns {Promise<void>}
 */
async function exportUserConfig() {
    if (busy) return;

    busy = true;
    updateUi();
    updateStatus('正在连接设备…');

    if (!(await checkAndTryConnect())) {
        busy = false;
        updateUi();
        return;
    }
    if (!checkConfigTarget()) {
        busy = false;
        updateUi();
        return;
    }

    updateStatus('正在读取用户配置…');
    const address = userConfigAddress();
    progressPercent = 1;
    updateProgress();

    try {
        logActivity(
            `正在读取用户配置区：0x${address.toString(16)} - 0x${(address + USER_CONFIG_REGION_SIZE).toString(16)}（${formatBytes(USER_CONFIG_REGION_SIZE)}）…`,
            'info'
        );

        const data = await withTimeout(
            async () => readFlashRegion(address, USER_CONFIG_REGION_SIZE, (read, total) => {
                progressPercent = Math.min(99, Math.round((read / total) * 100));
                updateProgress();
            }),
            calcTimeout(USER_CONFIG_REGION_SIZE, FLASH_SPEED),
            '读取用户配置'
        );

        const fileName = configFileName();
        downloadBytes(data, fileName);

        progressPercent = 100;
        updateProgress();
        logActivity(`用户配置已导出：${fileName}（${formatBytes(data.length)}）`, 'success');
        updateStatus('用户配置已导出');
    } catch (error) {
        progressPercent = 100;
        updateProgress(true);
        logActivity(`导出用户配置失败：${error.message}`, 'error');
        if (await tryRecover()) {
            updateStatus('导出失败');
        } else {
            updateStatus('导出失败（已断开）');
        }
    } finally {
        busy = false;
        updateUi();
    }
}

/**
 * 导入用户配置：校验大小 → 擦除并写入 Lua+KV 区 → 读回 SHA-256 校验。
 * 导入成功后保持 BOOTSEL，方便继续烧录固件。
 * @param {File} file
 * @returns {Promise<void>}
 */
async function importUserConfig(file) {
    if (busy) return;

    if (file.size !== USER_CONFIG_REGION_SIZE) {
        logActivity(
            `配置文件大小不正确：预期 ${USER_CONFIG_REGION_SIZE} 字节（${formatBytes(USER_CONFIG_REGION_SIZE)}），实际 ${file.size} 字节`,
            'error'
        );
        updateStatus('配置文件大小不正确');
        return;
    }

    const ok = window.confirm(
        '导入用户配置将覆盖设备上的：\n\n' +
        '· Lua 脚本（68 KB）\n' +
        '· 所有 KV 设置（128 KB）\n\n' +
        '当前配置会被擦除且无法撤销，确定继续吗？'
    );
    if (!ok) {
        logActivity('已取消导入用户配置', 'info');
        return;
    }

    busy = true;
    updateUi();
    updateStatus('正在连接设备…');

    if (!(await checkAndTryConnect())) {
        busy = false;
        updateUi();
        return;
    }
    if (!checkConfigTarget()) {
        busy = false;
        updateUi();
        return;
    }

    let data;
    try {
        data = new Uint8Array(await file.arrayBuffer());
        if (data.length !== USER_CONFIG_REGION_SIZE) {
            throw new Error(`读取到的长度不符：预期 ${USER_CONFIG_REGION_SIZE} 字节，实际 ${data.length} 字节`);
        }
    } catch (error) {
        busy = false;
        updateUi();
        logActivity(`读取配置文件失败：${error.message}`, 'error');
        updateStatus('读取配置文件失败');
        return;
    }

    updateStatus('正在导入用户配置…');
    const address = userConfigAddress();
    const progressInterval = setupProgressInterval(USER_CONFIG_REGION_SIZE, FLASH_SPEED);
    const timeoutMs = calcTimeout(USER_CONFIG_REGION_SIZE, FLASH_SPEED);

    try {
        logActivity(`正在导入用户配置：${file.name}（${formatBytes(data.length)}）…`, 'info');
        await withTimeout(
            async () => picoboot.flashEraseAndWrite(address, data),
            timeoutMs,
            '导入用户配置'
        );

        updateStatus('正在校验用户配置…');
        logActivity('正在读回校验…', 'info');

        const readBack = await withTimeout(
            async () => readFlashRegion(address, USER_CONFIG_REGION_SIZE, () => {}),
            timeoutMs,
            '校验用户配置'
        );

        const expected = await sha256Hex(data);
        const actual = await sha256Hex(readBack);

        if (expected !== actual) {
            throw new Error(
                `校验失败：写入内容与文件不一致（文件 ${expected.slice(0, SHA256_SHORT_LENGTH)}，设备 ${actual.slice(0, SHA256_SHORT_LENGTH)}）`
            );
        }

        clearProgressInterval(progressInterval, 100);
        logActivity(`用户配置已导入并通过校验（SHA-256 ${expected.slice(0, SHA256_SHORT_LENGTH)}）`, 'success');
        logActivity('设备保持在 BOOTSEL 模式；重新上电（不按 BOOTSEL）后配置生效', 'info');
        updateStatus('用户配置已导入（BOOTSEL）');
    } catch (error) {
        clearProgressInterval(progressInterval, 100, true);
        logActivity(`导入用户配置失败：${error.message}`, 'error');
        if (await tryRecover()) {
            updateStatus('导入失败');
        } else {
            updateStatus('导入失败（已断开）');
        }
    } finally {
        busy = false;
        updateUi();
    }
}

//
// 错误恢复（低层 PICOBOOT 操作）
//

/**
 * 尝试在超时或出错后恢复 Pico 连接。
 * 先查询 GET_COMMAND_STATUS，再尝试重置接口。
 * 两者都失败则断开设备。
 * 不抛错，返回 true 表示恢复成功，false 表示已断开。
 * @returns {Promise<boolean>}
 */
async function tryRecover() {
    logActivity('正在尝试恢复连接…', 'info');

    // 先查一次命令状态
    try {
        const status = await getCommandStatus();
        if (!status.isOk()) {
            logActivity(`Pico 设备报告错误状态：${status.getStatusName()}`, 'warning');
        } else {
            logActivity(`Pico 设备状态：${status.getStatusName()}`, 'info');
        }
    } catch (e) {
        logActivity('查询状态失败，尝试重置…', 'warning');
    }

    // 再尝试重置连接
    try {
        await reset();
        logActivity('连接恢复成功', 'success');
        return true;
    } catch (e) {
        logActivity('连接无法恢复，正在断开', 'error');
        try {
            await disconnect();
        } catch {
            // 忽略断开时的错误
        }
        return false;
    }
}

/**
 * 向设备发送 GET_COMMAND_STATUS。
 * 底层函数，只写控制台，抛错。
 * @returns {Promise<PicobootStatusCmd>}
 */
async function getCommandStatus() {
    if (!connected()) {
        console.log('没有已连接设备，无法查询命令状态');
        throw new Error('没有已连接设备');
    }

    try {
        console.log('正在查询命令状态…');

        const status = await withDefaultTimeout(
            async () => connection.getCommandStatus(),
            '查询命令状态'
        );

        console.log(`命令状态：${status.getStatusName()}`);

        return status;
    } catch (error) {
        console.log('查询命令状态出错');
        if (error.name === 'StatusError') {
            let statusError;
            try {
                statusError = error.status.getStatusName();
            } catch {
                statusError = 'unknown';
            }
            console.log(`Pico 设备报告错误状态：${statusError}`);
        } else {
            console.log(`查询命令状态时出错：${error.message}`);
        }

        // 继续向上抛
        throw error;
    }
}

/**
 * 向设备发送重置接口命令。
 * 底层函数，只写控制台，抛错。
 * @returns {Promise<void>}
 */
async function reset() {
    if (!connected()) {
        console.log('没有已连接设备，无法重置');
        throw new Error('没有已连接设备');
    }

    try {
        console.log('正在重置连接…');
        await withDefaultTimeout(
            async () => picoboot.resetInterface(),
            '重置接口'
        );
        console.log('连接重置成功');
    } catch (error) {
        console.log(`重置连接时出错：${error.message}`);
        throw error;
    }
}

//
// 事件绑定
//

connectBtn.addEventListener('click', async () => {
    if (busy) return;

    if (connection) {
        await disconnectNoThrow();
    } else {
        await connect();
    }

    updateUi();
});

flashBtn.addEventListener('click', async () => {
    await flash();
});

eraseBtn.addEventListener('click', async () => {
    await eraseFlash();
});

exportConfigBtn.addEventListener('click', async () => {
    await exportUserConfig();
});

importConfigBtn.addEventListener('click', () => {
    if (busy) return;
    importConfigFile.click();
});

importConfigFile.addEventListener('change', async () => {
    const file = importConfigFile.files && importConfigFile.files[0];
    if (!file) return;

    try {
        await importUserConfig(file);
    } finally {
        // 清空 value，允许下次选择同一个文件时再次触发 change
        importConfigFile.value = '';
    }
});

firmwareTrigger.addEventListener('click', () => {
    setVersionMenuOpen(!isVersionMenuOpen());
});

firmwareMenu.addEventListener('click', (e) => {
    const item = /** @type {HTMLElement|null} */ ((e.target instanceof Element) ? e.target.closest('.version-item') : null);
    if (!item) return;
    setFirmwareChannel(item.dataset.value || 'stable');
    setVersionMenuOpen(false);
});

// 点外部 / Esc 收起菜单（触发器自身的 click 由上面分支处理）
document.addEventListener('click', (e) => {
    if (!isVersionMenuOpen()) return;
    if (e.target instanceof Element && e.target.closest('.version-dropdown')) return;
    setVersionMenuOpen(false);
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isVersionMenuOpen()) {
        setVersionMenuOpen(false);
        e.stopPropagation();
    }
});

downloadBtn.addEventListener('click', () => {
    downloadFirmwareFile();
});

modalCloseBtn.addEventListener('click', () => {
    hideWebusbModal();
});

// 点遮罩空白处也可关闭（点卡片本身不关）
webusbModal.addEventListener('click', (e) => {
    if (e.target === webusbModal) hideWebusbModal();
});

//
// 启动
//

startup();
