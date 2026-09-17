'use strict';

// app/settings/token-kinds.js —— 令牌分类/恢复文件名/源推断的业务声明（DS-G4 §4.2 反转法唯一声明处）。
// platform 令牌组件只保留注册接口（kinds/pool/persist），值取自反转前 platform 同名字面量，逐字未改。
// 注入时机：require 即注入（模块顶层副作用），app/assembly/compose.js 构造 DshTokenService 前 require 本模块；
//   Node 模块缓存保证只注入一次。未注入时 kind 注册表为空、无推断映射、恢复文件用通用名。
// 纪律：只做数据声明 + 注入调用；只 require 被注入的 platform 模块，绝不反向依赖域/编排对象。

const kinds = require('../../platform/service/token/kinds');
const pool = require('../../platform/service/token/pool');
const persist = require('../../platform/service/token/persist');

/** §1 全部 kind（顺序与 SSOT 表格一致）。值 = 反转前 kinds.js 的同名对象，逐字未改。 */
const KINDS = {
  // 1) 原生 main 会话令牌：DSH 进程自己生成，我方只能捕捉；每次 DSH 重启轮换。
  'dsh-main': {
    side: 'dsh',
    strategy: 'capture+persist',
    persistent: true,
    captured: true,
    store: 'pool-file',
    unitBacked: false,
    desc: '原生 main 会话令牌（DSH 进程生成；捕捉+持久化+跟随）',
  },
  // 2) 沙箱实例会话令牌：与 main 同策略、只是源不同（systemd 单元 journald）。
  'dsh-instance': {
    side: 'dsh',
    strategy: 'capture+persist',
    persistent: true,
    captured: true,
    store: 'pool-file',
    unitBacked: true,
    desc: '沙箱实例会话令牌（DSH 进程生成；源为 dsh-web@<id> 单元）',
  },
  // 3) 浏览器会话 cookie：由 1/2 经 HTTP 303 换取，随 dshToken 轮换重换。
  //    刻意为 persistent:false —— cookie 是**派生缓存**，落盘等于多一份会话凭据副本。
  'dsh-auth': {
    side: 'dsh-derived',
    strategy: 'exchange',
    persistent: false,
    captured: false,
    store: 'memory',
    unitBacked: false,
    desc: '浏览器会话 cookie（dsh-auth-*，由 dsh-main/dsh-instance 换取；只存进程内存）',
  },
  // 4-6) 用户配置类：不是 DSH 令牌。不捕捉、不进令牌池展示、不随 DSH 轮换。
  'remote-token': {
    side: 'user',
    strategy: 'config',
    persistent: false,
    captured: false,
    store: 'config',
    unitBacked: false,
    desc: '远程/局域网门卫令牌（用户在 UI 填写）',
  },
  'api-access-key': {
    side: 'user',
    strategy: 'config',
    persistent: false,
    captured: false,
    store: 'config',
    unitBacked: false,
    desc: '出回环访问密钥（用户 config 填写）',
  },
  'frp-auth': {
    side: 'user',
    strategy: 'config',
    persistent: false,
    captured: false,
    store: 'config',
    unitBacked: false,
    desc: 'FRP 认证令牌（用户在 UI 填写，透传给 frpc）',
  },
  // 7) 我方签发的门卫会话 cookie。
  'lan-gate': {
    side: 'self',
    strategy: 'issue+verify',
    persistent: false,
    captured: false,
    store: 'browser',
    unitBacked: false,
    desc: 'lan gate cookie（dsh_lan_token，我方签发并校验）',
  },
};

/** 源形态 -> kind 推断（对应 platform/service/token/pool.js 的 inferKind 常量，语义逐字保持）。
 *  byId：id 直接命中；unitPrefix：单元名前缀命中；unitKind：任意非空单元的兜底；fileKind：本地恢复文件源。 */
const KIND_INFERENCE = {
  byId: { main: 'dsh-main' },
  unitPrefix: [['dsh-web@', 'dsh-instance']],
  unitKind: 'dsh-instance',
  fileKind: 'dsh-main',
};

/** 令牌恢复文件默认名（原 platform/service/token/persist.js#tokenFileName 的字面量）。 */
const TOKEN_FILE_NAME = 'dsh-main-token.log';

// 注入（require 即生效；幂等）
kinds.setKinds(KINDS);
pool.configureKindInference(KIND_INFERENCE);
persist.configureTokenFileName(TOKEN_FILE_NAME);

module.exports = { KINDS };
