# Win7 + 8G内存！我用手搓微内核把 AI 框架按在地上摩擦

> 这不是一个框架，这是 AI 时代的协议。
> **This is not a framework, this is a protocol for the AI era.**

## 引子：我被 AI 框架的「臃肿病」和 Win7 混合双打了

先说个段子，不太好笑：

我想在本机上跑一个开源 AI Agent 框架。`npm install` 回车按下去，进度条走了八百年，
`node_modules` 吃掉了 **800MB** 硬盘。然后——

```
gyp ERR! find Python Python is not set from command line or npm configuration
gyp ERR! find Python Python is not set from environment variable PYTHON
gyp ERR! ...
```

**node-gyp，又是 node-gyp。** 一个 C++ Addon 编译失败，整个安装原地爆炸。

我不死心，换下一个框架。README 第一行写着：**「请确保已安装 Docker」**。
我看了看我的机器：

- **Windows 7 SP1**，2026 年了还在服役
- **8G 内存**，开个浏览器吃 4G
- 没有 Docker（Win7 上的 Docker Desktop？你认真的？）
- 没有 WSL2（Win7 不配拥有）
- 没有 VS 编译链（装一个 C 盘直接红）

**Docker、WSL、node-gyp、16G 内存起步 —— 现在的 AI 框架，是给神仙用的吗？**

我被折磨了三个晚上之后，决定不忍了。

---

## 绝地反击：我把它掀了，自己手搓了一个微内核

既然所有框架都在教我「能力应该怎么调用」，那我偏要问一个更本质的问题：

> **如果所有能力长得都一样，调度它们的代码是不是只用写一次？**

于是我写了 **`dsh-host-everything`** —— 一个零依赖、纯 TypeScript + Node.js 的
统一程序调度总线。核心思想一句话：

### Everything is a Host（万物皆主程序）

在传统框架里，「能力」的形状是乱的：

| 能力 | 传统调用方式 | 出错时的死法 |
|---|---|---|
| 跑 `git status` | `child_process.exec(...)` | 进程挂起、stdout 爆缓冲 |
| 读个时间 | 直接调函数 | 同步异常抛进调用栈 |
| 查远程 API | `fetch(...)` | 网络抖动、没有超时 |
| 框架内置工具 | 私有协议 | 和上面三种互不相通 |

每类能力一套调用方式，每套都得自己写超时、重试、错误处理。**Agent 的上下文里
塞满了「怎么调用」而不是「调用什么」。**

我的回答是：**别发明。** 任何能力，只要能写成 `execute(params) → result`，
它就是一个 **Host**：

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

四类主机，同一个协议：

| `type` | 含义 | 适配器 | 示例 |
|---|---|---|---|
| `system-native` | 操作系统原生命令 | `CliHost`（spawn） | `cmd` / `git` / `powershell` |
| `dsh-builtin` | 总线内置能力 | `NodeHost` | `echo` / `clock` / `fs` / `env` |
| `standalone-app` | 本地程序 / 脚本 | `CliHost` 或 `NodeHost` | 任意 `.exe` / `.js` |
| `external-service` | 远程进程 | `HttpHost`（仅核心 http/https） | REST / JSON-RPC |

对 Agent 来说，整个世界被压平成一句话：

```
run <host_id> [参数]
```

`git` 是进程？`clock` 是函数？`httpbin` 是网络服务？**关我屁事，它们全是 host。**

这就是「微内核」的取舍：**总线只做调度，不做能力。** 所有能力都以 Host 插件形式
挂在注册中心上。明天要接 gRPC？写一个 `GrpcHost` 实现 `execute`，注册中心、队列、
CLI、RPC 协议全都不用动。

---

## 核心解密：HostDispatcher，一个永不崩溃的调度总线

架构上只有两个核心部件，而且分工极度刻意：

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
          │   CliHost        NodeHost      HttpHost   │
          │   spawn 子进程    in-process   http/https │
          └──────────────────────────────────────────┘
```

**HostRegistry 故意很蠢**：它就是一张 `Map<id, IHost>`，只管生命周期（注册 / 注销 /
dispose）和事件通知，**不执行任何东西**。蠢意味着不会出 bug，谁都能替换。

**HostDispatcher 负责所有的硬活**，四条铁律：

### ① `dispatch()` 永不抛出异常

未知 host、参数畸形、host 自己炸了 —— 全部归一化成 `ok: false` 的结构化结果：

```ts
const host = this.registry.get(req.hostId);
if (!host) {
  return failedResult(req.hostId, HOST_NOT_FOUND,
    `host "${req.hostId}" is not registered — try registry.list`, 0, req.taskId);
}
```

三道防线：`BaseHost.caughtResult` → `NodeHost` 子进程隔离 → 总线的 try/catch。
**Agent 拿到的永远是结构化数据，永远不会是一个 crash。**

### ② 双层超时看门狗

外层用 `Promise.race` 计时，超时调 `host.abort()` 硬中止：

```ts
const watchdog = new Promise<never>((_, reject) => {
  timer = setTimeout(
    () => reject(new HostError(TIMEOUT, `host "${host.id}" exceeded the ${timeoutMs}ms budget`)),
    timeoutMs);
});
const result = await Promise.race([host.execute(params), watchdog]);
```

适配器内部（如 `CliHost`）还有自己的 `setTimeout` 兜底杀卡死进程。
**两层都验证过**：测试里故意跑一个 60 秒不退出的 host，**600ms 内被干掉，总线继续服务。**

### ③ 纯内存异步队列，没有 Redis

`TaskQueue` 限并发（默认 4）、限量等待（默认 256，超限 `QUEUE_FULL`）、
支持 `cancel` / `clear` / `drain`。一个 host 卡死只占一个并发槽，
**永远不会饿死总线**。没有 Redis，没有外部 broker —— 你那台 Win7 不用装任何服务。

### ④ 子进程隔离

`NodeHost` 的 `isolation: 'child'` 模式把模块 fork 进独立进程，
崩溃、死循环、内存泄漏全部关在总线进程之外（经 `bridge/node-runner.js` 的
stdio JSON 握手协议通信）。

**调度一次的完整旅程：**

```
run clock iso
  → [HostCLI.tokenize] → { hostId: 'clock', params: { args: ['iso'] } }
  → [HostDispatcher.dispatch] → taskId → 查 Registry → 进 TaskQueue
  → [NodeHost.execute] → builtin-time.js handler({ args: ['iso'] })
  → [BaseHost.trackResult] → 记录 runs / failures / latency
  → { ok: true, stdout: '2026-…Z', durationMs: 2 }
```

而所有这些 —— HostRegistry、TaskQueue、HostDispatcher、三个适配器、CLI、
REPL、JSON-RPC —— 加起来的运行时依赖是：**0**。

---

## 战果展示：13/13 全绿，零原生编译

### 冒烟测试，全是故障注入式的

我的测试不是「happy path 跑通就行」，而是**故意搞坏**：造一个 60 秒不退出的 host、
一个不存在的 host，断言「总线 Survive 并给出结构化错误」。

本机实测（Node v26.7.0 on win32，就是那台 8G Win7 老爷机）：

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

（上面是真实运行输出的复制，发文章时我会截成图放上来，绿油油的一片更好看。）

### 零原生编译：我们从根上绕开了 node-gyp

别的项目怎么解决「跨平台编译」问题？上 WASM、上 Docker、上预编译二进制 ——
**还是得编译**。

我的解法更简单粗暴：**根本不编译。**

- **不用任何 C++ Addon**，全部能力来自 Node 核心模块（`child_process` / `http` /
  `https` / `net` / `fs` / `readline` / `events`）+ 纯 JS。没有 `.node` 文件，
  `node-gyp` 在这个项目里没有存在感。
- `npm install` **只装 1 个 devDependency（TypeScript）**，运行时依赖 **0**。
- 连 `npm run build` 都不用 `tsc` CLI —— 自己写了 `scripts/build.js`，
  用 TypeScript 编译器 API 在进程内编译，**weird 环境也稳**。
- Windows 的坑也提前踩完了：`spawn('./tool.js')` 在 Windows 报 `EFTYPE`，
  `CliHost.resolveSpawnTarget()` 自动改用 `process.execPath`；非零退出码照样附
  stdout/stderr；子进程 `windowsHide: true` 不弹黑窗；输出流 8 MiB 封顶防爆炸。

甚至还带了个 **Win7 只读体检工具** `run win7-checkup`：内存余量、负载、运行时长、
系统版本号，不写注册表不改系统，**放心跑在任何古董机上**。

一键启动，就这：

```bash
git clone https://github.com/doujiaozh/dsh-host-everything.git
cd dsh-host-everything
npm install     # 只装 TypeScript，运行时依赖 = 0
npm run build   # in-process 编译
npm run smoke   # 13/13 全绿
npm start       # 进 REPL：run clock iso / run git status / stats
```

没有 Docker，没有 Redis，没有编译失败，没有玄学环境问题。

---

## 开源呼吁：帮它冲上 Trending，Star 一下

**GitHub：https://github.com/doujiaozh/dsh-host-everything**

兄弟姐妹们，我清楚地知道这篇标题很中二、banner 很莽、语气很欠揍 —— 但代码是认真的：

- ✅ 运行时**零依赖**，`node >= 12` 就能跑
- ✅ Win7 / 8G 内存实测通过
- ✅ 13 项故障注入式测试全绿
- ✅ MIT 协议，随便用
- ✅ 纯 Node 核心模块，没有原生编译，没有 Docker

**如果「Everything is a Host」这五个字让你点了下头 —— 去点个 Star 吧。**

如果它曾在你的古董机上跑起来过，欢迎在 issue 里告诉我你的机器配置，
我想收集 100 台古董机的故事。

**这不是一个框架，这是 AI 时代的协议。**

一个协议，四个适配器，零依赖，13 项测试，一台 8G 的 Win7。

我们 Trending 见。🚀
