#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 实例域安全修复的回归（第九轮，2026-09-12）
//
// ## 缺陷（全部为「破坏性动作缺少前置确认」类）
//
// P1-1 升级失败**两条路径都无回滚**：回滚逻辑只写在「重启后起不来」的分支里，
//     而「npm 安装失败」与「重启失败」直接置 failed 就结束 →
//     实例已被停 + 磁盘版本不确定 → 只能人工处理（guardian 也不自愈）。
//
// P1-2 `removeInstance` **未确认单元已停**就 `rmSync(root, {recursive:true})`：
//     `stopUnit` 失败只 `return false`（不抛）→ 对运行中实例删 HOME = **不可逆数据丢失**。
//
// P1-3 `ports.release(inst.port)` **不带 ownerId** → 语义是「无条件按端口号删除」，
//     可能删掉**他人**的端口登记（上一轮刚给 release 加了归属校验，此处置之不理）。
//
// P1-4 `_updCache` 只写不删（长寿命守卫内存单调增长）+ 60s 定时器未 unref。
//
// P2   我上一轮留下的**自相矛盾**：`set sandboxSupported` 与「用方法而非 setter」的注释并存。
//
// P2   `_prepareSystemd` **无条件删除**用户的 `dsh-web@.service`（本模块只删不写该文件）。
//
// ## 锁定不变量
//   L-a  三条失败路径共用同一个 rollback（一处实现）
//   L-b  删数据目录前必须复核 isUnitActive
//   L-c  删除实例时不得调用不带 ownerId 的 release
//   L-d  _updCache 有清理路径；清理定时器 unref
//   L-e  sandboxSupported 无 setter（只有显式测试方法）
//   L-f  systemd 模板让位用 rename（不删数据）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
// ⚠ 2026-09-16 步骤8a（DIRECTORY-STRUCTURE-DESIGN §4.5）：instance 域已拆为
//   core/ops/upgrade + index 门面。本套源码级断言的**对象是「域」**（回滚共用、
//   删除前复核、getter 纪律…），与文件切分无关 —— 按域聚合读取，避免把判据搬走
//   而静默失去覆盖面。
const inst = fs.readdirSync(path.join(ROOT, 'src', 'domains', 'instance')).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', f), 'utf8'))
  .join(String.fromCharCode(10));
// 剥离注释行（源码级断言必须区分「代码」与「说明代码的文字」——本仓已踩多次）
const code = inst.split(String.fromCharCode(10))
  .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .join(String.fromCharCode(10));

// ── L-a：回滚收敛到一处 ──
{
  const calls = (code.match(/await rollback\(/g) || []).length;
  check('L-a 三条失败路径共用 rollback（3 处调用）', calls === 3, calls + ' 处');
  check('L-a rollback 辅助已定义', /const rollback = async \(why\) => \{/.test(code), '有');
  // 反向：确认原先内联的那份重复实现已删除。
  //   ⚠ 不能用 `let rbOk = false` 判定 —— 新的助手里也有同名局部变量（我第一版踩了这个）。
  //   改用「回滚装的旧版本」这一**特征调用**的出现次数：应当只有助手内一处。
  const rbInstalls = (code.match(/version: oldVersion/g) || []).length;
  check('L-a 回滚安装调用只出现一次（内联重复已删）', rbInstalls === 1, rbInstalls + ' 处');
  const defs = (code.match(/const rollback = async/g) || []).length;
  check('L-a rollback 只定义一次', defs === 1, defs + ' 处');
}

// ── L-b：删数据目录前复核 isUnitActive ──
check('L-b 复核 isUnitActive', /isUnitActive\(unit\)/.test(code), '有');
check('L-b 仍活跃时不删目录（条件含 !stillActive）', /!stillActive/.test(code), '有');
check('L-b 仍活跃时记事件（不静默）', /inst_remove_data_preserved/.test(code), '有');

// ── L-c：不得有无 ownerId 的 release ──
check('L-c 删除实例时不再调用 release(inst.port)',
  !/ports\.release\(inst\.port\)/.test(code), '已删');
check('L-c 保留按 owner 精确释放（unregister）', /ports\.unregister\('inst:' \+ id\)/.test(code), '有');

// ── L-d：_updCache 清理 + unref ──
check('L-d 存在收尾清理方法', /_scheduleJobCleanup\(id\) \{/.test(code), '有');
check('L-d 清理包含 _updCache（此前只写不删）', /delete _updCache\[id\]/.test(code), '有');
check('L-d 定时器 unref', /if \(t\.unref\) t\.unref\(\)/.test(code), '有');
// 反向：不得再有未 unref 的裸 60s 清理定时器
check('L-d 无未 unref 的裸清理定时器',
  !/setTimeout\(\(\) => \{ if \(_updJobs\[id\]/.test(code), '已改');

// ── L-e：sandboxSupported 无 setter ──
check('L-e getter 存在', /get sandboxSupported\(\)/.test(code), '有');
check('L-e **无** setter（防赋值静默绕过能力门）',
  !/set sandboxSupported\(/.test(code), '无 setter');
check('L-e 保留显式测试方法', /_setSandboxSupportedForTest\(v\)/.test(code), '有');

// ── L-f：systemd 模板让位用 rename（不删数据）──
//
//     域改造后 _prepareSystemd 随实例域拆分搬移（SSOT §5.3：lifecycle/ops）。
//    原先用「/_prepareSystemd() { ... }」抓函数体 —— 函数一改名/改缩进即静默抓空
//    （body 为空 → 断言空转或假红）。行为级验证由
//    test/instance-systemd-aside-behavior-test.js 真实调用承担；此处改为不依赖
//    函数形态的域级结构判据（读取面仍是整个 instance 域聚合，见文件顶部）。
{
  check('L-f 让位用 renameSync（而非 unlink 删除）',
    /renameSync\([^)]*systemdTemplatePath[^)]*,\s*aside\)/.test(code), '有');
  check('L-f 不再无条件 unlinkSync 该路径', !/unlinkSync\([^)]*systemdTemplatePath/.test(code), '已改');
  check('L-f 让位后记事件（可追溯）', /systemd_template_moved_aside/.test(code), '有');
  // ── L-f′：让位目标名必须**带时间戳**，且**不得**先删同名文件（2026-09-13，D-2 改进）──
  //
  //   缺陷：旧实现 aside = 固定名 '.disabled-by-dsh'，且先 `rmSync(aside, {force:true})`
  //     再 rename。用户（或上一次让位）若恰好有同名文件，会被**静默删除** ——
  //     为一次改名动作丢失用户数据，概率极低但**不可逆**。
  //   行为级验证见 test/instance-systemd-aside-behavior-test.js；此处只锁形态无关的结构判据（快速失败）。
  //   用**子串包含**而非正则：避免转义地狱（第一版正则要求目标里多出一个反斜杠 → 假红）。
  check('L-f′ 让位目标名带时间戳（不再固定 .disabled-by-dsh）',
    /['"]\.disabled-by-dsh-['"]\s*\+\s*stamp/.test(code), '有');
  check('L-f′ 不再先 rmSync 让位目标（删除该行，而非加保护）',
    !/rmSync\(\s*aside/.test(code), '已删');
  check('L-f′ 仍保留固定名文件（不覆盖已有文件）',
    /while\s*\(fs\.existsSync\(aside\)\)/.test(code), '有');
}

// ── L-h：删除实例的「数据已保留」必须对用户可见（P3，2026-09-13）──
//   缺陷：L-b 做到「单元仍活跃则不删数据目录」并记了事件，但 removeInstance 返回
//     裸 {ok:true}、API 原样转发、前端成功即静默刷新 —— 而确认框承诺
//     「彻底删除…不可恢复」。安全结果对用户不可见 = 谎报「数据已清」。
{
  check('L-h removeInstance 在上报保留数据（dataPreserved 字段）',
    /dataPreserved: true/.test(code), '有');
  check('L-h 保留数据的同时仍返回 ok:true（实例确已移除）',
    /stillActive \? \{ ok: true, dataPreserved: true/.test(code), '有');
  // 前端消费：经 supervisorApi 包装（不再静默）
  const uiClient = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'client.ts'), 'utf8');
  const uiPage = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'InstancesPage.tsx'), 'utf8');
  check('L-h 前端类型声明含 dataPreserved', /instanceRemove:.*dataPreserved/.test(uiClient), '有');
  check('L-h 前端据 dataPreserved 提示用户（不再静默）',
    /dataPreserved === true/.test(uiPage), '有');
  check('L-h 反向：普通删除路径仍返回裸 ok（不误加字段）',
    /\} else \{ return \{ ok: true \}; \}|: \{ ok: true \};/.test(code), '有');
}

// ── L-g：新增实例前探测端口**真实占用**（P3）──
//   缺陷：原实现只查「是否与本进程实例重名」+「注册表是否已登记」，
//     从不探测本机是否已有进程在监听 → 建到被占端口后实例启动 bind 失败，
//     BACKOFF 反复重试至多 20 次；用户看到「实例一直起不来」而非「端口被占」。
{
  // ⚠ 域改造后 addInstance 从 core.js 的 class 方法搬为 ops.js 的模块函数
  //   （async function addInstance(payload)）——判据须容忍两种形态，否则文件一搬即假红。
  check('L-g addInstance 为 async（需 await 探测）',
    /async\s+(?:function\s+)?addInstance\s*\(\s*payload\s*\)\s*\{/.test(code), '有');
  check('L-g 用 ports.isTaken 探测（既有唯一实现：登记 ∪ 监听）',
    /await ports\.isTaken\(port\)/.test(code), '有');
  // ⚠ 必须在 **addInstance 函数体**内比较 —— 文件前面还有别的 registerUser 调用点
  //   （load/_syncInstancePorts），用全局 indexOf 会命中它们（我第一版踩了这个）。
  const aiBody = (code.match(/async\s+(?:function\s+)?addInstance\s*\(\s*payload\s*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  const iT = aiBody.indexOf('await ports.isTaken(port)');
  const iR = aiBody.indexOf("ports.registerUser(port, 'inst:' + id)");
  check('L-g 探测在 registerUser 之前（先给清晰错误再登记）',
    iT > 0 && iR > 0 && iT < iR, 'isTaken@' + iT + ' registerUser@' + iR);
  check('L-g 探测失败不阻断创建（保留既有降级行为）',
    /探测失败不阻断创建/.test(code), '有');
  // 配套：API 调用点必须等 Promise（否则 r.ok 恒 undefined → 恒 400 且响应不可序列化）
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'instances.js'), 'utf8');
  check('L-g API 调用点用 Promise.resolve 包装（适配 async）',
    /Promise\.resolve\(sup\.instances\.addInstance\(j\)\)/.test(apiSrc), '已改');
  check('L-g API 不再把返回值当同步对象用（r.ok 直接读已消失）',
    !/const r = sup\.instances\.addInstance\(j\);/.test(apiSrc), '已改');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);