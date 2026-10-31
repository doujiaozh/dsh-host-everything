```
##### #   # ##### ####  #   # ##### #   # ##### #   # ####    #####  ####     #     #   #  ###   #### #####
#     #   # #     #   # #   #   #   #   #   #   ##  # #   #     #   #        # #    #   # #   # #       #
##### #   # ##### ####   # #    #   #####   #   # # # #         #   #####   #####   ##### #   # #####   #
#      # #  #     #  #    #     #   #   #   #   #  ## # ###     #       #   #   #   #   # #   #     #   #
#####   #   ##### #   #   #     #   #   # ##### #   # ####    ##### ####    #   #   #   #  ###  ####    #
```

# **This is not a framework, this is a protocol for the AI era.**
### 这不是一个框架，这是 **AI 时代的协议**。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D12-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Runtime Deps](https://img.shields.io/badge/runtime%20dependencies-0-success)
![Native Addons](https://img.shields.io/badge/native%20addons-0-critical)
![node-gyp](https://img.shields.io/badge/node--gyp-NOT%20REQUIRED-success)
![Win7 Ready](https://img.shields.io/badge/Win7-Ready-0078D6?logo=windows&logoColor=white)
![Smoke Tests](https://img.shields.io/badge/smoke%20tests-13%2F13-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

![Demo](assets/demo.gif)

---

## 🤬 受够了？我也是

AI Agent 框架一个比一个能吃：

- 装个框架，`node_modules` 先吃掉 **800MB**，_half of npm_ 跟着进门；
- 悄悄来个 C++ Addon，`node-gyp` 开始编译，Python 版本不对 → Visual Studio 缺件 →
  **编译失败，安装原地爆炸**；
- 再附赠 Docker、Redis、etcd 全家桶，没有 16G 内存都不好意思跟人打招呼。

而我手里只有一台 **8G 内存的 Win7 老爷机**。风扇一响，`npm install` 就像在玩俄罗斯轮盘赌。

于是我把桌子掀了：**用纯 Node.js 核心模块 + 纯 TypeScript，手搓一个零依赖的调度微内核。**

> 运行时依赖数：**0**。
> `node-gyp`？这项目里连这个词都是敏感词。
> Docker / Redis / broker？不存在。`TaskQueue` 是纯内存的，一个 Map 两个数组。

**它叫 `dsh-host-everything` —— 万物皆主程序。**

---

## 🧠 Everything is a Host（万物皆主程序）

传统框架的毛病，是**能力边界的形状不一致**：

| 能力 | 传统调用方式 | 出错时的死法 |
|---|---|---|
| 跑 `git status` | `child_process.exec(...)` | 进程挂起、stdout 爆缓冲 |
| 读个时间 | 直接调函数 | 同步异常抛进调用栈 |
| 查远程 API | `fetch(...)` | 网络抖动、没有超时 |
| 框架内置工具 | 私有协议 | 和上面三种**互不相通** |

每类能力都要发明一套调用方式，每套都得自己写超时、重试、错误处理 —— Agent 还得全学会。

**这个项目的回答是：别发明。** 任何能力，只要能写成 `execute(params) → result`，它就是一个
**Host（主程序）**：

```ts
interface IHost {
  readonly id: string;
  readonly type: HostType;          // 四类之一
  execute(params): Promise<HostExecResult>;   // 永不抛出异常
  status(): HostStatus;             // 同步健康快照
  abort?(reason?: string): void;    // 可选：硬中止
  dispose?(): void | Promise<void>; // 可选：注销时清理
}
```

对 Agent 来说，世界被压平成一句话：`run <host_id> [参数]`。
`git` 是进程？`clock` 是函数？`httpbin` 是网络服务？**关我屁事，它们全是 host。**

| `type` | 含义 | 适配器 | 示例 |
|---|---|---|---|
| `system-native` | 操作系统自带的原生命令 | `CliHost`（child_process.spawn） | `cmd`、`powershell`、`git`、`node` |
| `dsh-builtin` | 总线自带的内置能力（纯 JS 模块） | `NodeHost` | `echo`、`clock`、`fs`、`env` |
| `standalone-app` | 独立编写的本地程序 / 脚本 | `CliHost` 或 `NodeHost` | `example-greet.js`、`win7-checkup.js` |
| `external-service` | 远程进程，网络可达 | `HttpHost`（仅核心 http/https） | REST 端点、JSON-RPC 服务 |

每类的差异只在**适配器**，协议层（params/result 信封）完全相同。

---

## 🏗️ 架构：一个故意很「蠢」的注册中心 + 一个永不崩溃的调度总线

微内核的意思就是：**总线只做调度，不做能力。** 所有能力都以 Host 插件形式挂上。

### 核心双引擎

```
          ┌──────────────────────────────────────────┐
          │            HostRegistry                  │   ← 故意很蠢
          │   Map<string, IHost>                     │      只管注册/注销/事件
          │   register · unregister · list · events  │      不执行任何东西
          └────────────────┬─────────────────────────┘
                           │ get(hostId) —— 拿不到就 HOST_NOT_FOUND，不抛错
          ┌────────────────▼─────────────────────────┐
          │           HostDispatcher                 │   ← 永不抛出异常
          │  ① 生成 taskId  ② 路由到 host            │
          │  ③ 丢进 TaskQueue（并发 4 / 等待 256）   │
          │  ④ Promise.race 看门狗 → 超时 abort()    │
          │  ⑤ 结果归一化为统一信封 + 事件广播        │
          └────────────────┬─────────────────────────┘
                           │ execute(params)
          ┌────────────────▼─────────────────────────┐
          │         HostAdapter 适配器层              │
          │   CliHost        NodeHost      HttpHost   │
          │   spawn 子进程    in-process   http/https │
          │                   或 child 隔离  REST/RPC │
          └──────────────────────────────────────────┘
```

### 一次调用的完整旅程

```
  run clock iso
      │
      ▼
  [HostCLI.tokenize] ──► { hostId: 'clock', params: { args: ['iso'] } }
      │
      ▼
  [HostDispatcher.dispatch]
      │  ① 生成 taskId  ② 查 HostRegistry（未注册 → HOST_NOT_FOUND，不抛错）
      │  ③ 丢进 TaskQueue（排队 / 并发控制 / 超时计时）
      ▼
  [NodeHost.execute] ──► builtin-time.js handler({ args: ['iso'] })
      │  返回值经 valueToResult() 归一化为标准信封
      ▼
  [BaseHost.trackResult] ──► 记录 runs / failures / latency / 状态
      │
      ▼
  { ok: true, hostId: 'clock', stdout: '2026-…Z', data: '2026-…Z', durationMs: 2 }
```

### 全景图

```
                    ┌────────────────────────────────────────────────┐
                    │              Agent / 用户 / DSH                │
                    │   "run clock iso"  ·  JSON-RPC  ·  TCP        │
                    └───────────┬───────────────────────┬────────────┘
                                │                       │
                 ┌──────────────▼──────────┐  ┌─────────▼──────────┐
                 │  HostCLI (宿主启动器)    │  │  Library API       │
                 │  REPL / --rpc / --serve │  │  require('...')    │
                 └──────────────┬──────────┘  └─────────┬──────────┘
                                └──────────┬────────────┘
                                           │
                    ┌──────────────────────▼──────────────────────┐
                    │        HostDispatcher (统一调度总线)         │
                    │  意图解析 → 路由 → 异步队列 → 看门狗 → 归一化 │
                    │        dispatch() 永不抛出异常               │
                    └──────┬───────────────────────────────┬──────┘
                           │                               │
           ┌──────────────▼──────────┐       ┌────────────▼───────────┐
           │   TaskQueue (纯内存)     │       │   HostRegistry (注册中心)│
           │  并发限制 · 限量等待队列  │       │  register/unregister/   │
           │  cancel / drain          │       │  list / 事件通知        │
           └──────────────┬──────────┘       └────────────┬───────────┘
                          │                               │
       ┌──────────────────┴───────────────────────────────┴────────────┐
       │                       HostAdapter 适配器层                    │
       ├──────────────┬──────────────┬───────────────┬─────────────────┤
       │  CliHost     │  NodeHost    │  HttpHost     │  (BaseHost)     │
       │  child_      │  in-process  │  http/https   │  指标·状态·信封 │
       │  process     │  或 child    │  REST/JSON-RPC│                 │
       │  spawn       │  隔离        │  仅核心模块    │                 │
       └──────┬───────┴──────┬───────┴───────┬───────┴─────────────────┘
              │              │               │
  ╔═══════════▼══════════════▼═══════════════▼═════════════════════╗
  ║   system-native      dsh-builtin      standalone-app    external-service
  ║   cmd / git /        echo / clock /   example-greet /   httpbin /
  ║   powershell /       fs / env         win7-checkup /    JSON-RPC
  ║   python             (仓库内置)       任意 .exe/.js     远程 API
  ╚════════════════════════════════════════════════════════════════╝
```

---

## 🚀 一键启动

```bash
git clone https://github.com/doujiaozh/dsh-host-everything.git
cd dsh-host-everything

npm install        # 只装 1 个 devDependency（TypeScript），运行时依赖 = 0
npm run build      # in-process 编译，不依赖 tsc CLI
npm run smoke      # 冒烟测试：13 项断言全绿
```

然后四种姿势任选：

```bash
# ① 交互式 REPL —— 人用
npm start
hostbus> hosts
hostbus> run clock iso
hostbus> run greet --name World --lang zh
hostbus> stats
hostbus> exit

# ② 一次性调度（CI 友好，失败时退出码非 0）
node bin/hostbus.js run clock iso

# ③ JSON-RPC over stdio —— 给 Agent / DSH 当子进程驱动
node bin/hostbus.js --rpc

# ④ JSON-RPC over TCP —— 给其他机器 / 工具调用
node bin/hostbus.js --serve 127.0.0.1:8421
```

**完事了。** 没有 Docker，没有 Redis，没有编译错误，没有玄学环境问题。

---

## 🛡️ 为什么它崩不了

1. **`dispatch()` 永不抛出异常** —— 未知 host、参数畸形、host 抛错，全部被归一化成
   `ok: false` 的结构化结果（三道防线：`BaseHost.caughtResult` → `NodeHost` 子进程
   隔离 → `HostDispatcher` 的 try/catch）。
2. **双层超时看门狗** —— 外层 `HostDispatcher` 用 `Promise.race` 计时，超时后调用
   `host.abort()` 硬中止；适配器内部（如 `CliHost`）还有自己的 `setTimeout` 兜底，
   杀掉卡死的子进程。两层都已验证：冒烟测试里故意跑一个 60 秒的 host，**600ms 内被
   干掉，总线继续服务**。
3. **纯内存异步队列** —— `TaskQueue` 限并发（默认 4）、限量等待（默认 256，超限
   `QUEUE_FULL`）、支持 `cancel` / `clear` / `drain`。一个 host 卡死只会占用一个
   并发槽，**永远不会饿死总线**。没有 Redis，没有外部 broker。
4. **子进程隔离** —— `NodeHost` 的 `isolation: 'child'` 模式把模块 fork 进独立进程，
   崩溃、死循环、内存泄漏都关在总线进程之外（通过 `bridge/node-runner.js` 的 stdio
   JSON 握手协议通信）。

冒烟测试是**故障注入式**的：我们故意造一个 60 秒不退出的 host、一个不存在的 host，
断言是「总线 Survive 并给出结构化错误」，而不是「happy path 跑通」：

```
dsh-host-everything smoke test
node v26.7.0 on win32

  · registry loads host definitions               PASS
  · builtin echo ok                               PASS
  · builtin echo returns structured data          PASS
  · builtin clock.iso                             PASS
  · builtin env platform                          PASS
  · builtin fs.stat package.json                  PASS
  · system-native node CLI executes               PASS
  · standalone greet CLI executes                 PASS
  · child isolation: hung child bounded in time   PASS
  · unknown host → HOST_NOT_FOUND                 PASS
  · watchdog: slow CLI host times out             PASS
  · bus still healthy after the kill              PASS
  · stats counter sane                            PASS

ALL CHECKS PASSED
```

**错误码表**（全部定义在 `HostErrorCode`，跨适配器稳定）：
`HOST_NOT_FOUND` · `TIMEOUT` · `ABORTED` · `QUEUE_FULL` · `QUEUE_DRAINED` ·
`SPAWN_FAILED` · `EXIT_CODE` · `HOST_ERROR` · `INVALID_PARAMS` · `NETWORK` ·
`HTTP_STATUS`（实际为 `HTTP_404` 这类带状态码的形式） · `SHUTDOWN`

---

## 🪟 在 Win7 下无痛运行（避坑指南）

本框架从第一行代码就按 Win7 兼容设计，以下是踩过并已回避的坑：

**1. 零原生编译 —— 绝不碰 node-gyp**
- 不用任何 C++ Addon。全部能力来自 Node 核心模块（`child_process` / `http` /
  `https` / `net` / `fs` / `readline` / `events`）+ 纯 JS。
- 不依赖 Docker、不依赖 Redis、不依赖任何本地常驻服务。`TaskQueue` 是纯内存实现。
- `npm install` 只装一个 devDependency（TypeScript）；**运行时零依赖**。

**2. Windows 不能直接 spawn `.js` 文件**
- `spawn('./tool.js')` 在 Windows 上报 `EFTYPE`（没有 shebang 关联）。
- 框架已内置规避：`CliHost.resolveSpawnTarget()` 检测 `.js/.cjs/.mjs` 入口，自动改用
  `process.execPath`（当前 Node）运行——配置里写 `command: './tool.js'` 也能工作。
- 示例配置里的 `greet` 则更进一步，显式写 `command: process.execPath`，POSIX 与
  Windows 行为完全一致。

**3. PowerShell / cmd 的退出码与 stdio**
- `CliHost` 对非零退出码返回 `ok:false` 但**仍然附上 stdout/stderr**，调试不丢信息。
- spawn 失败（`ENOENT`，命令不在 PATH）会提示 "usually means the command is not on
  PATH"，而不是一个无意义的 `errno`。
- 所有子进程 `windowsHide: true`，不弹黑窗。

**4. 输出缓冲爆炸**
- 每条流 8 MiB 上限，超限截断并追加截断标记，避免 GB 级 stdout 拖垮总线。

**5. Node 版本与 TypeScript**
- 运行时只要求 `node >= 12`，用的全是稳定核心 API。
- **编者注（本机实测）**：若你的 npm 镜像提供的 `typescript` 7.x 包是只有 `version`
  导出的桩（`tsc` 一跑就崩），把 devDependency 锁在 `^5.9.3` 即可——本项目自带
  `scripts/build.js`（用编译器 API 在进程内编译），不依赖 `tsc` CLI。
- `npm run build` 用的是 in-process 编译脚本（`node scripts/build.js`），刻意绕开
  任何 CLI 入口，在 weird 环境下更可控。

**6. Win7 体检工具**
- `hosts/win7-checkup.js`（`run win7-checkup`）是个**只读**体检探针：内存余量、
  负载、运行时长、系统版本号。不写注册表、不改系统，可以放心跑在任何古董机上。

---

## 📦 作为库使用

```ts
import {
  HostRegistry, TaskQueue, HostDispatcher,
  CliHost, NodeHost, HttpHost, HostCLI, buildRegistry,
} from 'dsh-host-everything';

// 动态注册（编程式）
const registry = new HostRegistry();
registry.register(new CliHost({ id: 'git', command: 'git' }));
registry.register(new NodeHost({ id: 'my-tool', modulePath: './tool.js', isolation: 'child' }));
registry.unregister('git');                    // 异步 dispose，不阻塞

// 调度
const bus = new HostDispatcher({ registry, concurrency: 4, defaultTimeoutMs: 30_000 });
const result = await bus.dispatch({
  hostId: 'git',
  params: { args: ['status'], timeoutMs: 5_000, parseJson: false },
});
if (!result.ok) console.log(result.error?.code, result.error?.message);

const stats = bus.stats();          // { dispatched, succeeded, failed, timeouts, active, pending, hosts, uptimeMs }
await bus.cancel(taskId);           // 只取消排队中的任务
await bus.shutdown();               // 清队列 → drain → 注销全部 host

// 事件
bus.on('dispatch:timeout', ({ taskId, hostId }) => alert(taskId, hostId));
```

声明式配置（CommonJS）：复制 `config/hosts.example.js` 为 `config/hosts.config.js`
（后者被 git 忽略）即可自定义，每个条目变成总线上的一个 Host。相对路径一律按
**配置文件所在目录**解析，仓库随便搬。

一个进程三种入口的 `HostCLI`：交互式 REPL（类 shell 分词 + `tokenize()` 引号转义）、
JSON-RPC over stdio（每行一个请求，方法：`run` / `dispatch` / `hosts` / `status` /
`stats` / `cancel` / `shutdown` / `ping` / `help`）、JSON-RPC over TCP。

---

## 🔌 与 DeepSeek Harness 集成

总线对 DSH 而言就是一个**被 child_process 包装的外部程序**——正是
`standalone-app` 哲学的自我应用：

```bash
# DSH 侧把总线当一个长驻子进程驱动（JSON-RPC over stdio）
node bin/hostbus.js --rpc
```

每行一个 JSON-RPC 2.0 请求，每行一个响应。DSH 不需要知道总线的内部结构，就像总线
不需要知道 `git` 的内部结构。反过来，DSH 自身的工具也可以被包装成 `dsh-builtin`
主程序挂到总线上——**两个方向，同一个协议**。

由于协议是行的、无状态的、JSON 的，**任何 Agent 框架（不只 DSH）都能用同样方式接入。**

---

## 🗂️ 项目结构

```
dsh-host-everything/
├── bin/
│   └── hostbus.js               # 启动器：REPL / --rpc / --serve / run / hosts
├── bridge/
│   └── node-runner.js           # 子进程隔离桥（被 fork，纯 CommonJS，不经 TS 编译）
├── config/
│   ├── hosts.example.js         # 示例配置（git-ignored 的 .config.js 由此复制）
│   └── hosts.config.js          # 你的本地配置（不入 git）
├── hosts/                       # 主程序实现（纯 CommonJS，注册中心可直接 require）
│   ├── builtin-echo.js          #   dsh-builtin: 回显
│   ├── builtin-time.js          #   dsh-builtin: clock
│   ├── builtin-fs.js            #   dsh-builtin: 只读 fs 探查（1 MiB 上限）
│   ├── builtin-env.js           #   dsh-builtin: 环境诊断 + which
│   ├── example-greet.js         #   standalone-app: JSON 问候生成器
│   └── win7-checkup.js          #   standalone-app: Win7 只读体检
├── scripts/
│   ├── build.js                 # in-process TypeScript 编译（不依赖 tsc CLI）
│   └── smoke.js                 # 冒烟测试（13 项断言，覆盖全部适配器 + 故障注入）
├── src/
│   ├── core/
│   │   ├── types.ts             #   契约：IHost / HostExecParams / HostExecResult / 错误码 / 事件
│   │   ├── errors.ts            #   HostError + describeError + failedResult
│   │   ├── HostRegistry.ts      #   注册中心：动态注册/注销/查询/事件
│   │   ├── TaskQueue.ts         #   纯内存并发受限 FIFO
│   │   └── HostDispatcher.ts    #   统一调度总线：路由/队列/看门狗/熔断/统计
│   ├── adapters/
│   │   ├── BaseHost.ts          #   适配器基类：指标/状态/信封组装
│   │   ├── CliHost.ts           #   CLI 适配器：spawn 任意命令行程序
│   │   ├── NodeHost.ts          #   Node 适配器：in-process 或 child 隔离
│   │   └── HttpHost.ts          #   HTTP 适配器：REST / JSON-RPC（仅核心模块）
│   ├── cli/
│   │   └── HostCLI.ts           #   REPL + JSON-RPC stdio + TCP 三合一
│   ├── config/
│   │   └── loader.ts            #   声明式配置 → 总线
│   ├── util/
│   │   └── values.ts            #   handler 返回值 → 结果信封
│   └── index.ts                 #   公共 API 出口
├── package.json
├── tsconfig.json
└── README.md
```

---

## ⭐ Star 它

**GitHub：https://github.com/doujiaozh/dsh-host-everything**

如果这个项目曾在你的古董机上跑起来过，或者「Everything is a Host」这五个字让你
点了下头——**去点个 Star 吧**，帮它冲上 Trending。

一个协议，四个适配器，零依赖，13 项测试，一台 8G 的 Win7。

**This is not a framework, this is a protocol for the AI era.**

---

## 📄 许可证

MIT —— 见 [LICENSE](LICENSE)。
