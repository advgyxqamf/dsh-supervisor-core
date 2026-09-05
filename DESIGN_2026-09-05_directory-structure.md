dsh-supervisor/
├─ bin/
│  └─ dsh-supervisor                      # CLI/daemon 入口（守卫拉起）
├─ src/
│  ├─ guard/                              # 守卫层（产品壳：串联+监管+策略分发）
│  │  ├─ supervisor.js                    # 守卫核心：串联各功能、监管生命周期、策略分发
│  │  ├─ lifecycle/                       # 生命周期监管（收各域生命周期状态面）
│  │  │  ├─ index.js                      # LifecycleManager（唯一注册表/统一入口）
│  │  │  ├─ managed.js                    # ManagedLifecycle（统一状态机抽象）
│  │  │  ├─ adapters.js                   # 把各域模块包成 ManagedLifecycle 注册
│  │  │  └─ ports.js                       # 端口注册表（生命周期监管的观测底座：记录各受管对象绑定端口）
│  │  ├─ monitor/                         # 健康观测（探各域底层服务）
│  │  │  ├─ index.js                      # probe/probeInstance（L1 端口 / L2 HTTP）
│  │  │  └─ probe.js                      # infra 探测地基（TCP/HTTP 纯工具）
│  │  └─ guardian/                        # 守护策略（不健康→拉起/恢复决策）
│  │     └─ index.js                      # shouldGuard / 崩溃窗口 / 退避决策
│  │
│  ├─ domains/                            # 功能域（平级，各自业务自治）
│  │  ├─ router/                          # 智能路由域
│  │  │  ├─ daemon.js                     # 服务进程入口（原 router-daemon.js）★域内
│  │  │  ├─ ctl.js                        # 守卫控制通道（原 router-ctl.js）★域内
│  │  │  ├─ index.js                      # RouterService 核心
│  │  │  ├─ providers/                    # 供应商抽象
│  │  │  │  ├─ base.js  direct.js  proxy.js  quota-strategies.js
│  │  │  ├─ switch.js  forward-core.js  aux.js  evidence.js  store.js  proxy-apps.js
│  │  │  └─ instances/proxy-instance.js   # 反代实例（黑盒自治）
│  │  ├─ relay/                           # 远程控制域
│  │  │  ├─ daemon.js                     # 服务进程入口（原 lan-daemon.js）★域内
│  │  │  ├─ index.js  manager.js  frpmgr.js
│  │  ├─ instance/                        # 实例管理域
│  │  │  ├─ native.js                     # 原生 DSH（特殊实例，统一生命周期逻辑）
│  │  │  ├─ sandbox.js                    # 沙箱实例（systemd-run）
│  │  │  └─ index.js                      # InstanceManager（watchdog + 守护）
│  │  ├─ plugin/                          # 插件域
│  │  │  ├─ market.js                     # 插件市场（简单功能，无独立服务）
│  │  │  └─ plugins.js
│  │  └─ dist/                            # 分发/升级域
│  │     ├─ index.js                      # 守卫自更新等运行时升级
│  │     └─ self-update.js
│  │
│  ├─ platform/                           # 公共机制（真通用设施，被各域+守卫共享）
│  │  ├─ registry.js                      # 镜像源管理
│  │  ├─ installer.js                     # 安装执行器 runNpmInstall
│  │  ├─ token.js                         # 会话令牌（原 domain/token）
│  │  ├─ events.js  tasks.js  logs.js     # 事件总线 / 任务中心 / 日志
│  │  ├─ config.js  version.js  fs-utils.js  fse
│  │  └─ platform/                        # 三端能力（autostart/browser/notify/pidlookup/process/daemon-lifecycle）
│  │
│  ├─ api/                                # API 出口（按域拆文件，index 组装）
│  │  ├─ index.js                         # 门卫 + 静态托管 + 按前缀分发到各域 handler
│  │  ├─ guard.js                         # /status /healthz /events /start/stop /settings /env /autostart
│  │  ├─ lifecycle.js                     # /lifecycle/*
│  │  ├─ instances.js                     # /instances/*
│  │  ├─ router.js                        # /router/*（转发 daemon 或守卫转发）；含 /router/ports
│  │  ├─ relay.js                         # /lan/* /lan-access /lan/frp
│  │  ├─ plugins.js                       # /plugins/*
│  │  ├─ native.js                        # /native/* /guard/* /self-update/* /dist/registry
│  │  └─ tasks.js                         # /tasks*
│  └─ (config 常量/工具可留 src 顶层或入 platform)
├─ docs/                                 # 设计文档
├─ scripts/                              # 产品外发布策略（打包/发布/生成 manifest，不进运行时）
├─ ui-react/  (构建产物，gitignore)
└─ test/
