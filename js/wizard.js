// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

//
// 新手引导向导：分步引导用户完成固件烧录。
//
// 两条路线：
//   A（WebUSB 在线烧录）：欢迎自检 → 选板型 → BOOTSEL 引导 → 连接 →
//       选版本 → 下载固件 → 烧录 → 完成
//   B（U 盘拷贝烧录，适用于 iOS 等不支持 WebUSB 的环境）：
//       欢迎自检 → 选板型 → 选版本 → 下载 UF2 → 拷贝烧录图文 → 完成
//
// 本文件只负责步骤编排与界面；设备连接、固件下载、烧录等底层操作由 app.js
// 通过 initWizard(api) 注入，与主界面共用同一套逻辑（连接 / 竞速下载 / 烧录+重启）。
//

/** @typedef {{name: string, address: number, data: Uint8Array, origSize: number, fileType: string, downloadSpeed: number, sha256Short: string, hash: string, version: string|null}} FirmwareData */
/** @typedef {{id: string, name: string, desc: string, img: string, bootselImg: string, chip: string, channels: string[]}} BoardDef */
/** @typedef {{label: string, desc: string, dot: string}} ChannelDef */

/** localStorage 键：记录已完成/跳过过引导，之后不再自动弹出（可随时从主界面按钮重新打开） */
const WIZARD_DONE_KEY = 'picoflash-wizard-done';

/** @type {BoardDef[]} 板型列表（图片与 BOOTSEL 动图在 img/ 下，缺失时自动显示占位框） */
const BOARDS = [
    {
        id: 'default',
        name: 'Waveshare RP2350-USB-C',
        desc: '使用稳定版固件',
        img: 'img/board-default.jpg',
        bootselImg: 'img/bootsel-default.webp',
        chip: 'RP2350',
        channels: ['stable', 'latest'],
    },
    {
        id: 'carl',
        name: '定制开发版（基础版）',
        desc: '使用稳定版固件',
        img: 'img/board-carl.jpg',
        bootselImg: 'img/bootsel-carl.webp',
        chip: 'RP2350',
        channels: ['stable', 'latest'],
    },
    {
        id: 'pico2w',
        name: 'Pico 2 W（蓝牙）',
        desc: '树莓派官方无线板，使用蓝牙变体固件',
        img: 'img/board-pico2w.jpg',
        bootselImg: 'img/bootsel-pico2w.webp',
        chip: 'RP2350',
        channels: ['stable:pico2w'],
    },
    {
        id: 'waveshare',
        name: 'Waveshare 无线板（蓝牙）',
        desc: '微雪 RP2350B-Plus W，使用 Waveshare 蓝牙变体固件',
        img: 'img/board-waveshare.jpg',
        bootselImg: 'img/bootsel-waveshare.webp',
        chip: 'RP2350',
        channels: ['stable:waveshare_pw'],
    },
];

/** @type {Object<string, ChannelDef>} 渠道展示文案（key 与主界面版本选择的 value 一致） */
const CHANNELS = {
    'stable': {
        label: '稳定版',
        desc: '推荐所有用户；日常使用、没有特别说明时，始终选这个',
        dot: 'dot-success',
    },
    'latest': {
        label: '最新版（调试）',
        desc: '调试构建，仅供作者通知时刷入；不确定请选稳定版',
        dot: 'dot-latest',
    },
    'stable:pico2w': {
        label: '稳定版 · Pico 2 W（蓝牙）',
        desc: 'DS5 蓝牙直连，无 Host 口',
        dot: 'dot-success',
    },
    'stable:waveshare_pw': {
        label: '稳定版 · Waveshare（蓝牙）',
        desc: 'DS5 蓝牙直连，无 Host 口',
        dot: 'dot-success',
    },
};

//
// 注入的底层 API（由 app.js 通过 initWizard 提供）
//

/** @typedef {Object} WizardApi
 * @property {boolean} hasWebUsb 当前环境是否支持 WebUSB
 * @property {() => Promise<void>} connect 连接设备（复用主界面连接逻辑）
 * @property {() => boolean} connected 是否已建立完整连接
 * @property {() => {target: string, vidPid: string, product: string}|null} getTargetInfo 读取已选设备的芯片信息
 * @property {(channel: string) => void} setChannel 设置固件渠道（同步主界面下拉）
 * @property {() => string} getChannel 当前固件渠道
 * @property {() => string} channelLabel 当前渠道展示名
 * @property {() => Promise<string|null>} fetchStableVersion 获取稳定版版本号（尽力而为，失败返回 null）
 * @property {() => Promise<FirmwareData>} fetchFirmware 下载并解析当前渠道固件（多源竞速）
 * @property {() => Promise<void>} downloadFirmwareFile 触发浏览器下载 UF2 固件文件
 * @property {(firmware: FirmwareData, onProgress: (percent: number) => void) => Promise<{ok: boolean, connectFailed: boolean}>} burn 烧录固件并重启设备
 * @property {(message: string, type?: string) => void} log 写主界面活动日志
 */

/** @type {WizardApi} */
let api = null;

//
// DOM 引用与状态
//

let overlay = null;
let titleEl = null;
let progressEl = null;
let bodyEl = null;
let backBtn = null;
let nextBtn = null;
let skipBtn = null;

/** 向导内状态 */
const state = {
    /** @type {string|null} 当前路线：'usb'（在线烧录）| 'download'（U 盘拷贝） */
    route: null,
    /** @type {string|null} 已选板型 id */
    board: null,
    /** @type {string|null} 已选渠道值（与主界面版本 value 一致） */
    channel: null,
    /** @type {FirmwareData|null} 已下载固件 */
    firmware: null,
    /** @type {string|null} 连接后识别到的目标芯片（如 'RP2350'） */
    target: null,
};

/** 当前路线的步骤 id 列表（welcome 之后按路线展开） */
let stepList = ['welcome'];
let stepIdx = 0;

/** 向导内是否有异步操作进行中（烧录），期间锁住上一步/跳过 */
let wizardBusy = false;

/**
 * 按路线展开步骤列表。
 * 进入烧录模式（BOOTSEL）与浏览器能力无关——不支持 WebUSB 的设备
 * 同样要按住 BOOT 插线，才能出现可拷固件的 U 盘，因此两条路线共有。
 * 固件渠道不设独立步骤：向导面向新手，选完板型直接锁定该板型的稳定版。
 * @param {string} route
 * @returns {string[]}
 */
function stepsForRoute(route) {
    if (route === 'usb') {
        return ['welcome', 'board', 'bootsel', 'connect', 'download', 'flash', 'done'];
    }
    return ['welcome', 'board', 'bootsel', 'getfile', 'copyguide', 'done'];
}

/**
 * 根据 id 找板型定义。
 * @param {string} id
 * @returns {BoardDef|null}
 */
function boardById(id) {
    return BOARDS.find(b => b.id === id) || null;
}

/** 重置向导状态（重新开始一轮引导）。 */
function resetState() {
    state.route = null;
    state.board = null;
    state.channel = null;
    state.firmware = null;
    state.target = null;
    stepList = ['welcome'];
    stepIdx = 0;
}

//
// 工具
//

/**
 * 图片框：三态显示——加载中（转圈动画）、加载成功（图片）、加载失败（占位文案）。
 * @param {string} src 图片路径
 * @param {string} placeholderText 加载失败时显示的占位文案
 * @returns {string}
 */
/**
 * 图片占位框：图片缺失（onerror）时只显示占位文案，图片就位后自动展示。
 * @param {string} src 图片路径
 * @param {string} placeholderText 占位文案
 * @param {string} ratioClass 比例修饰类（'wide' = 16:9，默认正方形 1:1）
 * @returns {string}
 */
function imgFrame(src, placeholderText, ratioClass = '') {
    return `<div class="wizard-img-frame ${ratioClass} is-loading" data-src="${src}">
        <div class="img-loading"><span class="wizard-spinner"></span>图片加载中…</div>
        <div class="img-placeholder"><span class="img-placeholder-icon">🖼️</span>${placeholderText}</div>
        <img alt="${placeholderText}">
    </div>`;
}

/**
 * 渲染后挂载图片：加载成功切到图片，失败切到占位文案。
 * @param {HTMLElement} root
 * @return {void}
 */
function wireImages(root) {
    for (const el of root.querySelectorAll('.wizard-img-frame')) {
        const frame = /** @type {HTMLElement} */ (el);
        const img = /** @type {HTMLImageElement} */ (frame.querySelector('img'));
        img.addEventListener('load', () => {
            frame.classList.remove('is-loading', 'is-missing');
            frame.classList.add('has-img');
        });
        img.addEventListener('error', () => {
            frame.classList.remove('is-loading', 'has-img');
            frame.classList.add('is-missing');
        });
        img.src = frame.dataset.src || '';
    }
}

//
// 各步骤定义
//

const STEP_DEFS = {

    welcome: {
        title: '欢迎使用 pico⚡flash',
        nextLabel: null, // render 时按环境决定
        html() {
            const supported = api.hasWebUsb;
            return `
                <p class="wizard-lede">这个向导会带你一步步完成固件烧录：选择板型 → 进入烧录模式 → 烧录固件。</p>
                <div class="wizard-env ${supported ? 'env-ok' : 'env-warn'}">
                    ${supported
                        ? '✓ 当前浏览器支持 WebUSB，可以进行在线一键烧录'
                        : '✗ 当前浏览器不支持 WebUSB（如 iOS Safari）。<br>你可以下载固件文件，通过系统 U 盘方式烧录，效果完全一样。'}
                </div>
                ${supported ? `
                <div class="wizard-alt">
                    <button id="wizardRouteDownload" class="wizard-linklike" type="button">
                        只想下载固件文件（U 盘拷贝烧录）？
                    </button>
                </div>` : ''}
            `;
        },
        wire() {
            const supported = api.hasWebUsb;
            if (supported) {
                // 在线烧录为主路径；也给想直接拿文件的用户一条入口
                nextBtn.textContent = '开始在线烧录引导';
                const alt = /** @type {HTMLButtonElement|null} */ (bodyEl.querySelector('#wizardRouteDownload'));
                alt?.addEventListener('click', () => {
                    state.route = 'download';
                    stepList = stepsForRoute('download');
                    stepIdx = 1;
                    console.log('向导：选择路线 B（下载固件 + U 盘拷贝烧录）');
                    renderStep();
                });
            } else {
                nextBtn.textContent = '开始（下载固件烧录）';
            }
        },
        /**
         * @returns {boolean}
         */
        onNext() {
            if (!state.route) {
                state.route = api.hasWebUsb ? 'usb' : 'download';
                stepList = stepsForRoute(state.route);
                console.log(`向导：选择路线 ${state.route === 'usb' ? 'A（WebUSB 在线烧录）' : 'B（U 盘拷贝烧录）'}`);
            }
            return true;
        },
    },

    board: {
        title: '选择你的设备',
        nextLabel: '下一步',
        html() {
            return `
                <p class="wizard-lede">请选择你手上的板型（决定后续烧录模式引导与可用固件版本）：</p>
                <div class="wizard-board-grid">
                    ${BOARDS.map(b => `
                        <button type="button" class="wizard-board${state.board === b.id ? ' is-selected' : ''}" data-board="${b.id}">
                            ${imgFrame(b.img, '板型图片待补充')}
                            <span class="board-name">${b.name}</span>
                            <span class="board-desc">${b.desc}</span>
                        </button>
                    `).join('')}
                </div>
            `;
        },
        wire() {
            wireImages(bodyEl);
            for (const card of bodyEl.querySelectorAll('.wizard-board')) {
                card.addEventListener('click', () => {
                    const id = /** @type {HTMLElement} */ (card).dataset.board || '';
                    if (state.board !== id) {
                        // 换板型后，之前按板型选的渠道与固件全部失效
                        state.channel = null;
                        state.firmware = null;
                        state.board = id;
                    }
                    for (const c of bodyEl.querySelectorAll('.wizard-board')) {
                        c.classList.toggle('is-selected', c === card);
                    }
                    console.log(`向导：选择板型 ${id}`);
                });
            }
        },
        /** @returns {boolean} */
        onNext() {
            if (!state.board) {
                alert('请先选择一个板型');
                return false;
            }
            // 渠道不设独立步骤：锁定该板型的稳定版（蓝牙板即对应蓝牙变体）
            const board = boardById(state.board);
            if (board) {
                state.channel = board.channels[0];
                state.firmware = null;
                api.setChannel(state.channel);
                console.log(`向导：按板型自动选择固件渠道 ${state.channel}`);
            }
            return true;
        },
    },

    bootsel: {
        title: '进入烧录模式（BOOTSEL）',
        nextLabel: '已进入烧录模式',
        html() {
            const board = boardById(state.board || '');
            return `
                <p class="wizard-lede">接下来让板子进入<b>烧录模式</b>（BOOTSEL）——这是烧录固件的前提。</p>
                ${imgFrame(board?.bootselImg || '', '按键与插线动图待补充', 'wide')}
                <ol class="wizard-steps-list">
                    <li>拔掉板子上的 USB 线（如已连接）</li>
                    <li>按住 <strong>BOOT / BOOTSEL</strong> 键</li>
                    <li>保持按住，插入 USB 线连接到这台设备</li>
                    <li>松开按键 —— 板子进入烧录模式</li>
                </ol>
                <details class="wizard-trouble">
                    <summary>没有成功进入烧录模式？</summary>
                    <ul>
                        <li>确认 USB 线支持<b>数据传输</b>——很多充电线不传数据</li>
                        <li>换一个 USB 口，优先直连，不经集线器/扩展坞</li>
                        <li>尝试先按住 BOOT 再插线，插稳后再松开</li>
                    </ul>
                </details>
            `;
        },
        wire() {
            wireImages(bodyEl);
        },
        /** @returns {boolean} */
        onNext() {
            api.log('向导：用户已进入烧录模式（BOOTSEL）', 'info');
            return true;
        },
    },

    connect: {
        title: '连接设备',
        nextLabel: '下一步',
        html() {
            return `
                <p class="wizard-lede">点击下方按钮，在弹出的浏览器窗口中选择你的设备（名称为 <span class="mono">RP2350 BOOT</span>）。</p>
                <div class="wizard-center">
                    <button id="wizardConnectBtn" class="btn btn-primary btn-flash">连接设备</button>
                </div>
                <div id="wizardConnectResult"></div>
            `;
        },
        wire() {
            const result = /** @type {HTMLElement|null} */ (bodyEl.querySelector('#wizardConnectResult'));
            const btn = /** @type {HTMLButtonElement|null} */ (bodyEl.querySelector('#wizardConnectBtn'));

            // 已连接（例如连接后才打开向导）：直接显示识别结果
            if (api.connected()) {
                showConnectResult(result);
                if (btn) btn.hidden = true;
            }

            btn?.addEventListener('click', async () => {
                btn.disabled = true;
                if (result) result.innerHTML = '<p class="wizard-status"><span class="wizard-spinner"></span> 等待选择设备…</p>';
                try {
                    await api.connect();
                } finally {
                    btn.disabled = false;
                }
                showConnectResult(result);
            });
        },
        /**
         * @returns {Promise<boolean>}
         */
        async onNext() {
            if (!api.connected()) {
                await api.connect();
            }
            if (!api.connected()) {
                alert('还没有连接设备；如果浏览器没有弹出选择窗口，请确认板子已进入烧录模式后重试。');
                return false;
            }
            return true;
        },
    },

    download: {
        title: '下载固件',
        nextLabel: '继续',
        html() {
            return `
                <div id="wizardDownloadArea">
                    <p class="wizard-status"><span class="wizard-spinner"></span> 正在获取固件…</p>
                </div>
            `;
        },
        wire() {
            if (state.firmware) {
                renderDownloadResult();
            } else {
                void fetchFirmwareForWizard();
            }
        },
        /**
         * @returns {Promise<boolean>}
         */
        async onNext() {
            // 进入步骤时已自动下载；若失败，点「继续」时重试一次
            if (!state.firmware) {
                await fetchFirmwareForWizard();
            }
            if (!state.firmware) {
                alert('固件尚未下载成功，请重试或检查网络。');
                return false;
            }
            return true;
        },
    },

    flash: {
        title: '烧录固件',
        nextLabel: '⚡ 开始烧录',
        html() {
            const board = boardById(state.board || '');
            const fw = state.firmware;
            return `
                <div class="wizard-summary">
                    <div><span>固件版本</span><strong>${fw?.version ? 'v' + fw.version : CHANNELS[state.channel || 'stable']?.label || api.channelLabel()}</strong></div>
                    <div><span>固件大小</span><strong>${fw ? formatBytes(fw.origSize) : '-'}</strong></div>
                    <div><span>SHA-256</span><strong class="mono">${fw ? fw.sha256Short : '-'}</strong></div>
                    <div><span>目标芯片</span><strong>${state.target || board?.chip || '-'}</strong></div>
                </div>
                <div class="wizard-note danger">烧录会擦除并重写固件区，过程中请勿拔线或关闭页面。</div>
                <div id="wizardBurnArea"></div>
            `;
        },
        /**
         * 点「开始烧录」即执行烧录，成功才进入完成页。
         * @returns {Promise<boolean>}
         */
        async onNext() {
            const area = /** @type {HTMLElement|null} */ (bodyEl.querySelector('#wizardBurnArea'));
            const fw = state.firmware;
            if (!fw || !area) return false;

            wizardBusy = true;
            if (area) {
                area.innerHTML = `
                    <div class="wizard-progress-meta"><span>烧录中，请勿拔线…</span><span class="wizard-percent">1%</span></div>
                    <div class="wizard-progress-bar"><div class="wizard-progress-fill" style="width:1%"></div></div>
                `;
            }
            const fill = area.querySelector('.wizard-progress-fill');
            const percentText = area.querySelector('.wizard-percent');

            try {
                const result = await api.burn(fw, (percent) => {
                    if (fill instanceof HTMLElement) fill.style.width = `${percent}%`;
                    if (percentText) percentText.textContent = `${Math.round(percent)}%`;
                });
                if (result.ok) {
                    api.log('向导：烧录完成', 'success');
                    return true;
                }
                if (area) {
                    const reason = result.connectFailed
                        ? '未能连接设备。请确认板子仍处于烧录模式（可返回上一步重新引导），然后重试。'
                        : '烧录失败。设备连接已尝试恢复，可直接重试；若多次失败，建议重新进入烧录模式。';
                    area.innerHTML = `<div class="wizard-note danger">${reason}</div>`;
                }
                return false;
            } finally {
                wizardBusy = false;
            }
        },
    },

    getfile: {
        title: '下载固件文件',
        nextLabel: '我已下载固件',
        html() {
            const board = boardById(state.board || '');
            const def = CHANNELS[state.channel || 'stable'];
            return `
                <p class="wizard-lede">已为「${board?.name || '你的板子'}」选择 <strong>${def?.label || state.channel}</strong>。点击下方按钮下载固件文件（.uf2）：</p>
                <div class="wizard-center">
                    <button id="wizardSaveFileBtn" class="btn btn-primary btn-flash">⬇ 下载 .uf2 固件</button>
                </div>
                <div id="wizardSaveFileResult"></div>
                <p class="wizard-hint">下载的文件形如 <span class="mono">pico-hid-mapper-&lt;版本hash&gt;.uf2</span>，请留意浏览器下载提示；若没有开始下载，请检查弹窗/下载权限。</p>
            `;
        },
        wire() {
            const btn = /** @type {HTMLButtonElement|null} */ (bodyEl.querySelector('#wizardSaveFileBtn'));
            const result = /** @type {HTMLElement|null} */ (bodyEl.querySelector('#wizardSaveFileResult'));
            btn?.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    await api.downloadFirmwareFile();
                    if (result) {
                        result.innerHTML = '<div class="wizard-note ok">已触发下载。若浏览器未提示，请查看通知或主界面日志。</div>';
                    }
                } finally {
                    btn.disabled = false;
                }
            });
        },
        /** @returns {boolean} */
        onNext() {
            return true;
        },
    },

    copyguide: {
        title: '拷贝固件完成烧录',
        nextLabel: '完成引导',
        html() {
            return `
                <p class="wizard-lede">把下载好的固件文件拷进板子的 U 盘，即可完成烧录：</p>
                <ol class="wizard-steps-list">
                    <li>打开文件管理器，确认板子的 U 盘已出现：
                        <br>· iPhone / iPad →「文件」App，侧边栏会出现 U 盘
                        <br>· 电脑 → 名为 <span class="mono">RP2350</span>（或 RPI-RP2）的 U 盘
                        <br>前面进入烧录模式后一直插着线的话，U 盘应该已经在了</li>
                    <li>没看到 U 盘？重新按住 <strong>BOOT / BOOTSEL</strong> 插线再松开，U 盘出现后继续</li>
                    <li>把下载的 <span class="mono">.uf2</span> 文件拷贝 / 拖入 U 盘根目录</li>
                    <li>U 盘自动消失、板子重启 = 烧录成功 ✅</li>
                </ol>
                <details class="wizard-trouble">
                    <summary>看不到 U 盘？</summary>
                    <ul>
                        <li>确认 USB 线支持数据传输（充电线不行）</li>
                        <li>按第 2 步重新进入烧录模式：必须先按住 BOOT 再插线</li>
                        <li>iOS 上需要解锁屏幕后重新插线，并在「文件」App 侧边栏查看</li>
                    </ul>
                </details>
            `;
        },
        /** @returns {boolean} */
        onNext() {
            return true;
        },
    },

    done: {
        title: '完成',
        hideBack: true,
        hideNext: true,
        html() {
            const routeUsb = state.route === 'usb';
            return `
                <div class="wizard-done">🎉</div>
                <p class="wizard-lede center">${routeUsb
                    ? '固件烧录完成，设备已自动重启进入新固件。'
                    : '引导完成。固件拷入 U 盘后板子会自动重启，进入新固件。'}</p>
                <button id="wizardCloseBtn" class="btn btn-success wizard-done-btn" type="button">完成，进入主界面</button>
            `;
        },
        wire() {
            const close = /** @type {HTMLButtonElement|null} */ (bodyEl.querySelector('#wizardCloseBtn'));
            close?.addEventListener('click', () => {
                closeWizard();
            });
        },
    },
};

//
// 渲染与导航
//

/**
 * 渲染当前步骤（标题、进度点、正文、底部按钮）。
 * @return {void}
 */
function renderStep() {
    const id = stepList[stepIdx];
    const def = STEP_DEFS[id];
    if (!def) return;

    titleEl.textContent = def.title;

    // 进度点
    progressEl.innerHTML = stepList.map((sid, i) =>
        `<span class="wizard-pip${i < stepIdx ? ' is-done' : i === stepIdx ? ' is-current' : ''}"></span>`
    ).join('');

    // 底部按钮
    backBtn.hidden = stepIdx === 0 || !!def.hideBack;
    nextBtn.hidden = !!def.hideNext;
    if (!def.hideNext) {
        nextBtn.textContent = def.nextLabel || '下一步';
    }

    bodyEl.innerHTML = def.html();
    if (def.wire) def.wire();

    bodyEl.scrollTop = 0;
    console.log(`向导：显示步骤 ${id}（${stepIdx + 1}/${stepList.length}）`);
}

/**
 * 前进一步；已是最后一步则关闭向导。
 * @return {void}
 */
function advance() {
    if (stepIdx + 1 < stepList.length) {
        stepIdx += 1;
        renderStep();
    } else {
        closeWizard();
    }
}

/**
 * 关闭向导并记住「已完成」，之后不再自动弹出。
 * @return {void}
 */
function closeWizard() {
    overlay.hidden = true;
    try {
        localStorage.setItem(WIZARD_DONE_KEY, 'done');
    } catch {
        // localStorage 不可用时忽略，仅影响下次是否自动弹出
    }
    console.log('向导：已关闭');
}

/**
 * 打开向导（新一轮，从头开始）。
 * @return {void}
 */
function openWizard() {
    resetState();
    overlay.hidden = false;
    renderStep();
    console.log('向导：已打开');
}

//
// 连接步骤的结果展示
//

/**
 * 在连接步骤显示识别到的设备信息，并与所选板型的预期芯片交叉核对。
 * @param {HTMLElement|null} result
 * @return {void}
 */
function showConnectResult(result) {
    if (!result) return;

    if (!api.connected()) {
        result.innerHTML = `
            <div class="wizard-note warn">
                未连接设备。可能原因：取消了选择、板子不在烧录模式、数据线不支持传输。可再次点击「连接设备」重试。
            </div>`;
        return;
    }

    const info = api.getTargetInfo();
    if (!info) {
        result.innerHTML = '<div class="wizard-note warn">已连接，但读取设备信息失败。</div>';
        return;
    }

    state.target = info.target;

    const board = boardById(state.board || '');
    const mismatch = board && board.chip !== info.target;

    result.innerHTML = `
        <div class="wizard-connect-ok">
            <span class="ok-badge">✓ 已连接</span>
            <span>识别到 <strong>${info.target}</strong>（${info.vidPid}，${info.product}）</span>
        </div>
        ${mismatch ? `
        <div class="wizard-note warn">
            识别到的芯片（${info.target}）与所选板型（${board?.name}，预期 ${board?.chip}）不一致，请确认板型选择是否正确；如确认无误可继续。
        </div>` : ''}
    `;
}

//
// 下载步骤
//

/**
 * 下载固件并刷新下载步骤的结果区。
 * 带自增序号防止重试/返回操作后旧结果覆盖新状态。
 * @returns {Promise<void>}
 */
async function fetchFirmwareForWizard() {
    const seq = ++downloadSeq;
    const area = /** @type {HTMLElement|null} */ (bodyEl.querySelector('#wizardDownloadArea'));
    if (!area) return;

    area.innerHTML = '<p class="wizard-status"><span class="wizard-spinner"></span> 正在获取固件…</p>';
    api.log('向导：开始获取固件', 'info');

    try {
        const fw = await api.fetchFirmware();
        if (seq !== downloadSeq) return;
        state.firmware = fw;
        api.log(`向导：固件获取成功（${fw.version ? 'v' + fw.version : fw.sha256Short}）`, 'success');
        renderDownloadResult();
    } catch (error) {
        if (seq !== downloadSeq) return;
        api.log(`向导：固件获取失败：${error.message}`, 'error');
        area.innerHTML = `
            <div class="wizard-note danger">固件下载失败：${error.message}</div>
            <div class="wizard-center">
                <button id="wizardRetryDlBtn" class="btn btn-secondary" type="button">重试下载</button>
            </div>`;
        const retry = /** @type {HTMLButtonElement|null} */ (area.querySelector('#wizardRetryDlBtn'));
        retry?.addEventListener('click', () => {
            void fetchFirmwareForWizard();
        });
    }
}

/**
 * 下载成功后渲染固件信息面板。
 * @return {void}
 */
function renderDownloadResult() {
    const area = /** @type {HTMLElement|null} */ (bodyEl.querySelector('#wizardDownloadArea'));
    const fw = state.firmware;
    if (!area || !fw) return;

    area.innerHTML = `
        <div class="wizard-summary">
            <div><span>版本</span><strong>${fw.version ? 'v' + fw.version : '最新构建'}</strong></div>
            <div><span>SHA-256</span><strong class="mono">${fw.sha256Short}</strong></div>
        </div>
        <div class="wizard-note ok">✓ 固件已下载并通过校验</div>
    `;
}

//
// 格式化（与 app.js 同款实现，向导内独立使用）
//

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

//
// 启动
//

/** 下载序号（防止过期异步结果写回界面） */
let downloadSeq = 0;

/**
 * 初始化向导：注入底层 API、绑定骨架事件、首次访问自动弹出。
 * 由 app.js 在启动时调用。
 * @param {WizardApi} injected
 * @return {void}
 */
export function initWizard(injected) {
    api = injected;

    overlay = /** @type {HTMLElement} */ (document.getElementById('wizardOverlay'));
    titleEl = /** @type {HTMLElement} */ (document.getElementById('wizardTitle'));
    progressEl = /** @type {HTMLElement} */ (document.getElementById('wizardProgress'));
    bodyEl = /** @type {HTMLElement} */ (document.getElementById('wizardBody'));
    backBtn = /** @type {HTMLButtonElement} */ (document.getElementById('wizardBackBtn'));
    nextBtn = /** @type {HTMLButtonElement} */ (document.getElementById('wizardNextBtn'));
    skipBtn = /** @type {HTMLButtonElement} */ (document.getElementById('wizardSkipBtn'));

    backBtn.addEventListener('click', () => {
        if (wizardBusy || stepIdx === 0) return;
        stepIdx -= 1;
        renderStep();
    });

    nextBtn.addEventListener('click', async () => {
        if (wizardBusy) return;
        const def = STEP_DEFS[stepList[stepIdx]];
        if (!def) return;

        nextBtn.disabled = true;
        backBtn.disabled = true;
        try {
            const ok = def.onNext ? await def.onNext() : true;
            if (ok) advance();
        } catch (error) {
            console.log(`向导：步骤 ${stepList[stepIdx]} 出错：${error.message}`);
            api.log(`向导：操作失败：${error.message}`, 'error');
        } finally {
            nextBtn.disabled = false;
            backBtn.disabled = false;
        }
    });

    skipBtn.addEventListener('click', () => {
        if (wizardBusy) {
            alert('正在烧录，请等待完成后再退出向导。');
            return;
        }
        closeWizard();
    });

    // 主界面入口按钮：头部「新手引导」按钮 + 连接设备卡片中的引导链接（data-open-wizard）
    for (const el of document.querySelectorAll('[data-open-wizard]')) {
        el.addEventListener('click', () => {
            openWizard();
        });
    }

    // 首次访问自动弹出（已完成/跳过过则不再打扰）
    let seen = false;
    try {
        seen = !!localStorage.getItem(WIZARD_DONE_KEY);
    } catch {
        // localStorage 不可用时视为未看过，自动弹出
    }
    if (!seen) {
        openWizard();
    }

    console.log('向导：已初始化');
}
