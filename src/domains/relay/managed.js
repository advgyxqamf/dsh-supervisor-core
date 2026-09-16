'use strict';

// 受管清单投影（半纯）：沙箱实例 + 原生主干 main 合成，以及本机非回环地址枚举。
// 纯投影部分可脱离域对象单测（给 { instances, mainOf } 即可）。

const os = require('node:os');

/** 本机 IPv4 非回环地址（供 LAN 面板展示可访问地址）。 */
function localAddresses() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  } catch {}
  return out;
}

/** 受管 DSH 合成清单：沙箱实例(instancemgr) + 原生主干 main(守卫核心视图)。 */
function allManaged({ instances, mainOf }) {
  const sandboxes = (instances && instances.instances) || [];
  const main = (typeof mainOf === 'function') ? mainOf() : null;
  return main ? [...sandboxes, main] : sandboxes;
}

/** 合成查找：main 优先守卫视图，其余走沙箱数组。 */
function findManaged(list, id) {
  return (list || []).find((x) => x.id === id) || null;
}

module.exports = { localAddresses, allManaged, findManaged };
