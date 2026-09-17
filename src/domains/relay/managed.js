'use strict';

// 受管清单投影（半纯）：沙箱实例 + 原生主干 main 合成，以及本机非回环地址枚举。
// 纯投影部分可脱离域对象单测（给 { instances, mainOf }；instances 只需提供 all() 查询接口）。

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

/** 受管 DSH 合成清单：沙箱实例(instancemgr) + 原生主干 main(守卫核心视图)。
 *  顺序是沙箱在前、main 在尾部（main 经 mainOf() 注入；daemon 模式下 main 由 lan-state.json
 *  进入 instances.all()、mainOf 为 null）。
 *  main 与沙箱 id 空间不相交：沙箱 id 恒由 instance 域生成（inst-*，见 instance/model.js#createRecord），
 *  历史 main 记录在装配期由 app/state/store.js#migrateMainRecord 迁出 instances.json。
 *  故清单不会出现同 id 项，「main 被沙箱抢先命中」不可能发生；findManaged 从左取首个即等价于「main 可达」。 */
function allManaged({ instances, mainOf }) {
  const sandboxes = (instances && typeof instances.all === 'function' && instances.all()) || [];
  const main = (typeof mainOf === 'function') ? mainOf() : null;
  return main ? [...sandboxes, main] : sandboxes;
}

/** 合成查找：按 id 取首个匹配（清单无同 id 项，见 allManaged 注释）。 */
function findManaged(list, id) {
  return (list || []).find((x) => x.id === id) || null;
}

module.exports = { localAddresses, allManaged, findManaged };
