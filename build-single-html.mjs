#!/usr/bin/env node
// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License
//
// 把本项目打包成一个自包含的单个 HTML 文件（不含固件）。
// 固件仍在运行时从 js/config.js 中的 FIRMWARE_URL 拉取。
//
// 用法：node build-single-html.mjs
// 输出：picoflash-single.html

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// 打包顺序：依赖在前
const BUNDLE_FILES = [
    'pkg/constants.js',
    'pkg/errors.js',
    'pkg/commands.js',
    'pkg/target.js',
    'pkg/connection.js',
    'pkg/picoboot.js',
    'js/uf2/uf2.js',
    'js/config.js',
    'js/app.js',
];

/**
 * 去掉 ES module 的 import 语句（单行与多行），因为打包后所有代码处于同一模块作用域。
 * @param {string} src
 * @returns {string}
 */
function stripImports(src) {
    return src.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/g, '');
}

/**
 * 去掉 export 关键字与 re-export 语句，全部变为同一模块内的普通声明。
 * @param {string} src
 * @returns {string}
 */
function stripExports(src) {
    // 去掉 `export { ... } from '...';` 形式的 re-export
    src = src.replace(/export\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/g, '');
    // 去掉行首的 `export `（export class / const / function）
    return src.replace(/^export\s+/gm, '');
}

/**
 * 把单个 JS 文件转成可拼接的模块片段。
 * @param {string} relPath
 * @returns {string}
 */
function bundleFile(relPath) {
    const src = readFileSync(join(ROOT, relPath), 'utf8');
    return stripExports(stripImports(src)).trim();
}

const js = BUNDLE_FILES.map(bundleFile).join('\n\n');
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

// 把外链样式与外部模块脚本替换为内联
const bundledHtml = html
    .replace('<link rel="stylesheet" href="/style.css">', `<style>\n${css}\n</style>`)
    .replace('<script type="module" src="/js/app.js"></script>', `<script type="module">\n${js}\n</script>`);

// 校验：打包后不应再有任何外部模块引用
const leftover = bundledHtml.match(/<script[^>]*src=|<link[^>]*rel="stylesheet"[^>]*href=/g);
if (leftover) {
    console.error('打包结果仍包含外部引用：', leftover);
    process.exit(1);
}

writeFileSync(join(ROOT, 'picoflash-single.html'), bundledHtml);
console.log(`已生成 picoflash-single.html（${(bundledHtml.length / 1024).toFixed(1)} KB）`);
