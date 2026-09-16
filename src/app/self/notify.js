'use strict';

// ⚠ 步骤7 收尾：notify 用 platform.service() 发桌面通知；该依赖原在 supervisor.js 顶部，机械下沉时未随之携带。
const platform = require('../../platform/os/index');

// ⚠ 步骤7 收尾：notify 用 matrix 判定平台差异；该依赖原在 supervisor.js 顶部，机械下沉时未随之携带。
const matrix = require('../../platform/contract/matrix');

// ═══════════════════════════════════════════════════════════════════════════
// app/self/notify.js —— 桌面通知
//
// 职责：经 platform/os 发桌面通知（守卫自身行为）。
//
// 步骤 7（2026-09-16）：从 src/supervisor.js（组装根）下沉 —— 使 root 只剩组装与启动，
//   满足 DIRECTORY-STRUCTURE-DESIGN §5.2 DS-G7（supervisor.js ≤200 行）。
// ═══════════════════════════════════════════════════════════════════════════


function notify(host, title, body) {
    if (!host.notifyEnabled) return;
    platform.notify(title, body, () => {
      host.notifyEnabled = false; // 环境无通知工具，静默停用
      host.logger.warn('桌面通知不可用（' + matrix.osTag() + '），已停用');
    });
}

module.exports = { notify };