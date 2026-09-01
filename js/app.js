// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

//
// Imports（相对路径，兼容二级目录/根目录/自定义域名部署）
//

import { Picoboot } from '../pkg/picoboot.js';
import { Connection } from '../pkg/connection.js';
import { PicobootStatusCmd } from '../pkg/commands.js';
import { FLASH_START } from '../pkg/constants.js';
import { uf2ToFlashBuffer } from './uf2/uf2.js';
import {
    FIRMWARE_STABLE_HASH_URL,
    FIRMWARE_LATEST_HASH_URL,
    FIRMWARE_STABLE_VERSION_URL,
    FIRMWARE_CDN_PREFIX,
    FIRMWARE_CDN_SUFFIX,
    FETCH_TIMEOUT,
    DEFAULT_USB_TIMEOUT,
    FLASH_SPEED,
    DEFAULT_REBOOT_DELAY,
    SHA256_SHORT_LENGTH,
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
 * @property {string|null} version 稳定版固件版本号（仅稳定版渠道；最新版为 null）
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

/** @type {'stable'|'latest'} 当前固件版本渠道 */
let firmwareChannel = 'stable';

/** localStorage 键：记住用户上次选择的固件版本 */
const FIRMWARE_CHANNEL_STORAGE_KEY = 'picoflash-firmware-channel';

// Progress bar
/** @type {number} */
let progressPercent = 0;
/** @type {HTMLElement} */
const progressFill = document.getElementById('progressFill');

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

// 活动日志
/** @type {HTMLElement} */
const activityContent = document.getElementById('activityContent');

// 固件版本切换
const versionStableBtn = /** @type {HTMLButtonElement} */ (document.getElementById('versionStableBtn'));
const versionLatestBtn = /** @type {HTMLButtonElement} */ (document.getElementById('versionLatestBtn'));

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
 * 计算烧录接口在某目标上的 Flash 结束地址。
 * @param {import('../pkg/target.js').Target} target
 * @returns {number|null}
 */
function flashEndForTarget(target) {
    if (target.type === 'RP2040') return 0x11000000;
    if (target.type === 'RP2350') return 0x12000000;
    return null;
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
    const flashEnd = flashEndForTarget(target);

    deviceTarget.textContent = target.toString();
    deviceVidPid.textContent = `${info.vendorId.toString(16).padStart(4, '0')}:${info.productId.toString(16).padStart(4, '0')}`;
    deviceManufacturer.textContent = info.manufacturerName || '-';
    deviceProduct.textContent = info.productName || '-';
    deviceSerial.textContent = info.serialNumber || '-';
    deviceUsbVersion.textContent = `${info.usbVersionMajor}.${info.usbVersionMinor}.${info.usbVersionSubminor}`;
    deviceDeviceVersion.textContent = `${info.deviceVersionMajor}.${info.deviceVersionMinor}.${info.deviceVersionSubminor}`;
    deviceFlashRange.textContent = `0x${target.flashStart().toString(16)} - ${flashEnd ? `0x${flashEnd.toString(16)}` : '--'}`;
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

//
// 固件版本切换
//

/**
 * 从 localStorage 读取上次选择的固件版本，默认稳定版。
 * @returns {'stable'|'latest'}
 */
function loadFirmwareChannel() {
    try {
        const saved = localStorage.getItem(FIRMWARE_CHANNEL_STORAGE_KEY);
        if (saved === 'stable' || saved === 'latest') {
            return saved;
        }
    } catch {
        // localStorage 不可用（隐私模式等），回退默认值
    }
    return 'stable';
}

/**
 * 设置固件版本渠道，更新 UI 并持久化。
 * @param {'stable'|'latest'} channel
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
    logActivity(`固件版本已切换为：${channel === 'stable' ? '稳定版' : '最新版'}`, 'info');
}

/**
 * 更新版本切换按钮的激活态。
 * @return {void}
 */
function updateVersionUi() {
    const stable = firmwareChannel === 'stable';

    versionStableBtn.classList.toggle('is-active', stable);
    versionLatestBtn.classList.toggle('is-active', !stable);
    versionStableBtn.setAttribute('aria-pressed', String(stable));
    versionLatestBtn.setAttribute('aria-pressed', String(!stable));
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
 * 从固定 URL 拉取并解析 UF2 固件。
 * 每次调用都会带新的缓存规避参数；失败时抛错。
 * @returns {Promise<FirmwareData>}
 */
async function fetchFirmwareData() {
    logActivity(`获取固件中（${firmwareChannel === 'stable' ? '稳定版' : '最新版'}）…`, 'info');

    // 1. 获取所选渠道（稳定版/最新版）的版本 hash
    const hashUrl = addCacheBuster(firmwareChannel === 'stable' ? FIRMWARE_STABLE_HASH_URL : FIRMWARE_LATEST_HASH_URL);
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

    // 2. 用 hash 拼接固件地址并下载
    const firmwareUrl = `${FIRMWARE_CDN_PREFIX}${hash}${FIRMWARE_CDN_SUFFIX}`;
    const startTime = Date.now();
    const res = await withTimeout(
        async () => fetch(addCacheBuster(firmwareUrl), { cache: 'no-store' }),
        FETCH_TIMEOUT,
        '获取固件'
    );

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const uf2Data = new Uint8Array(await res.arrayBuffer());
    const elapsedMs = Date.now() - startTime;
    const downloadSpeed = elapsedMs > 0 ? (uf2Data.length * 1000) / elapsedMs : 0;

    // 对下载的 UF2 字节计算 SHA-256，取前几位作为校验值
    const hashBuf = await crypto.subtle.digest('SHA-256', uf2Data);
    const hashHex = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    const sha256Short = hashHex.slice(0, SHA256_SHORT_LENGTH);

    const { address, data } = uf2ToFlashBuffer(uf2Data);

    // 3. 稳定版渠道附带获取版本号（仅日志展示用，失败不影响烧录）
    let version = null;
    if (firmwareChannel === 'stable') {
        version = await fetchFirmwareVersion();
    }

    const fileName = `pico-hid-mapper-${hash}.uf2`;
    return { name: fileName, address, data, origSize: uf2Data.length, fileType: 'uf2', downloadSpeed, sha256Short, version };
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

    // 2. 连接设备（未连接则先请求选择设备）
    if (!(await checkAndTryConnect())) {
        busy = false;
        updateUi();
        return;
    }

    // 3. 烧录
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
 * 清空flash流程：擦除整片 flash 地址窗口（固件 + 所有已存数据）。
 * 擦除前弹出二次确认；擦除后不重启（flash 已空，无固件可运行），
 * 直接断开连接，设备保持 BOOTSEL 模式，等待重新烧录。
 * @returns {Promise<void>}
 */
async function eraseFlash() {
    if (busy) return;

    // 二次确认放在 busy=true 之前，取消时不闪禁用态
    const ok = window.confirm('清空flash 将擦除整片 flash：固件和所有已保存的数据都会被删除，设备将无法启动，之后必须重新烧录固件。\n\n擦除后设备保持 BOOTSEL 模式。确定继续吗？');
    if (!ok) {
        logActivity('已取消清空flash', 'info');
        return;
    }

    busy = true;
    updateUi();

    // 连接设备（未连接则先请求选择设备）
    if (!(await checkAndTryConnect())) {
        busy = false;
        updateUi();
        return;
    }

    // 计算擦除范围：整片 flash 地址窗口
    const target = picoboot.getTarget();
    const flashEnd = flashEndForTarget(target);
    if (flashEnd == null) {
        logActivity(`未知目标（${target.toString()}），无法确定 flash 范围，已取消`, 'error');
        updateStatus('清空已取消');
        busy = false;
        updateUi();
        return;
    }

    const start = FLASH_START;
    const size = flashEnd - start;

    updateStatus('正在清空flash…');

    // 初始化进度条并计算预计耗时（整片擦除较慢，可能需要几分钟）
    const progressInterval = setupProgressInterval(size, FLASH_SPEED);
    const timeoutMs = calcTimeout(size, FLASH_SPEED);

    try {
        logActivity(`正在清空 flash：0x${start.toString(16)} - 0x${flashEnd.toString(16)}（${formatBytes(size)}）…`, 'info');
        await withTimeout(
            async () => picoboot.flashErase(start, size),
            timeoutMs,
            '清空flash'
        );

        clearProgressInterval(progressInterval, 100);

        logActivity('清空完成', 'success');
        logActivity('flash 已全部擦除，设备保持 BOOTSEL 模式，请重新烧录固件', 'warning');
        updateStatus('清空完成');

        // 不重启：flash 已空，无固件可运行；直接断开，设备留在 BOOTSEL。
        // 不能复用 disconnectNoThrow()——它会把状态行覆盖成「已断开连接」
        try {
            await withDefaultTimeout(
                async () => picoboot.disconnect(),
                '断开连接'
            );
        } catch (error) {
            logActivity(`断开连接出错：${error.message}`, 'warning');
        } finally {
            connection = null;
            picoboot = null;
        }
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

versionStableBtn.addEventListener('click', () => {
    setFirmwareChannel('stable');
});

versionLatestBtn.addEventListener('click', () => {
    setFirmwareChannel('latest');
});

//
// 启动
//

startup();
