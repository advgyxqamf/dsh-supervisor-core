# FIX-8 反代实例重启假成功与 API 失败恒 200

范围（独占）:
- src/domains/router/ops/apps-registry.js
- src/domains/router/endpoint.js
- src/api/domains/instances.js
- src/api/domains/router.js
- src/api/transport/body.js

## 缺陷

A1 apps-registry.js applyProxyUpdate 用不带 force 的 stopInstance。
proxy.js 的 stopInstance 对「ready+可用+被 selected/active 指向」的常驻实例只置
_stopPendingUntilIdle 后返回，不杀进程。600ms 后 startInstance 见 inst.pid 仍在，
返回 {ok:true, already:true}，job 记 restarted++ 并把 step 置 done，实际旧进程从未重启。
修法: stopInstance(inst, true)。

A2 endpoint.js deactivateProvider 同样用不带 force 的 stopInstance。
停用后该供应商不再有补刀路径（对账只处理 activated 供应商），在用实例进程泄漏。
修法: stopInstance(i, true)。

B1 instances.js 的 remove/update/stop 恒 send(200)，与 start 的 ok 映射不一致。
结果为 {ok:false} 仍回 200，面板显示已删除/已更新/已停止而实际未生效。
修法: 与 start 同规 r && r.ok ? 200 : 400；响应体仍为原结果对象。

B2 router.js 的 /router/start|stop 在 setRouterRunning 返回 {ok:false} 时也回 200。
修法: ok === false 映射 400。

B3 body.js collectBody 在 req 'end' 事件里同步调用 onDone。
回调同步抛出会逃出请求处理的异常边界，升级为进程级 uncaughtException。
修法: try/catch 包裹 onDone；未发响应头时回 500 JSON，已发头则只收尾 end。

## 对外契约变化（可观测）

- POST /instances/{stop,update,remove}: 结果 {ok:false} 由 200 改为 400；成功仍 200，
  响应体结构不变。
- POST /router/{start,stop}: setRouterRunning 返回 {ok:false} 时由 200 改为 400；
  成功仍 200，响应体结构不变。
- 其余路由、字段、事件不变。

## 测试影响

未改动任何被测试断言钉住的字符串。
- test/api-contract-test.js 的 stopInstance stub 返回 {ok:true}，仍 200。
- test/p2p-api-test.js 的 /router/start|stop 真实返回 ok:true，仍 200。
- test/round13-router-relay-gaps-test.js ③ 的 force stopInstance 计数只增不减，
  反向判据（删除路径无裸 stopInstance）仍成立。
- test/round13-dropped-result-test.js 的 B/D 行级判据保留: 改动后的 start/stop 两行
  仍为 .then(...).catch(...) 且 catch 在链尾。
- test/probe-gate-and-ownership-test.js E-e 的 tasks.step/stepState 判据未触碰。

## 验证

node --check 五个文件均通过。按硬约束未运行任何测试。
