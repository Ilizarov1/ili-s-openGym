# 子系统路由：`wearables`（手表与穿戴设备客户端）

> 返回总路由：[AGENTS.md](../../../AGENTS.md) · [docs/README.md](../../README.md) · 工程规范：[code-standards.md](../../code-standards.md)

## 1. 职责与边界

负责四大穿戴平台客户端及其与手机宿主端之间的训练状态快照、组完成勾选、RPE/RIR 录入、组间休息倒计时和心率回传协议：Apple Watch（watchOS）、Wear OS、Garmin Connect IQ 与 Zepp OS（Amazfit），以及 iOS 锁屏小组件 / Live Activity 联动。

## 2. 代码入口与目录映射

| 路径 | 职责说明 |
|---|---|
| `frontend/ios/App/Watch`、`WatchCore`、`WatchWidgets` | Apple Watch 原生应用（Digital Crown 调重/次数、防误触锁、心率采集与表盘复杂功能） |
| `frontend/android/wear/` | Wear OS 原生手表端（Kotlin + Jetpack Compose），与 Apple Watch 共用同步协议 |
| `frontend/garmin/` | Garmin Connect IQ 手表端（Monkey C），基于精简训练快照协议 |
| `watch-zepp/` | Zepp OS（Amazfit）手表端工程与配套手机中继 |
| `frontend/src/lib/watch-sync.js` | Apple Watch 与 Wear OS 共用的双向训练会话同步桥 |
| `frontend/src/lib/garmin-snapshot.js` | 面向 Garmin 内存约束裁剪的快照序列化与回传解析器 |
| `frontend/src/lib/widgets.js`、`health-sync.js` | 锁屏小组件刷新、Apple Health 与 Android Health Connect 双向健康数据同步 |

## 3. 核心契约与不变式

1. **协议向后兼容**：手表固件更新滞后于手机端或 Web 端；修改 `watch-sync.js` 或 `garmin-snapshot.js` 载荷字段时必须保持默认值容错，不得因缺省新字段导致旧版表端崩溃或丢弃已完成的正式组。
2. **离线与幂等回传**：腕上勾选组或结束休息在蓝牙短暂断连重连后回传，必须按会话与组标识幂等合并，防止重复计组或覆盖手机端最新修改。
3. **内存与电量预算**：Garmin（Monkey C）与 Zepp OS 设备内存极小，严禁将完整 5,600 动作库或未裁剪历史记录塞入腕端快照。

## 4. 常用验证命令（PowerShell）

```powershell
# 运行前端与手表同步桥 / Garmin 快照相关的纯函数单测
cd frontend; npx.cmd vitest run src/lib/watch-sync src/lib/garmin-snapshot
```

> 原生表端编译分别通过 Xcode（macOS / `.github/workflows/ios.yml`）、Gradle（Wear OS）、Connect IQ SDK（Garmin）与 Zeus CLI（Zepp OS）执行，详见下方各平台指南。

## 5. 文档路由

- [Wear OS 手表端开发、协议与测试指南](../../WEAR_OS.md)
- [Garmin Connect IQ 手表端构建与发布指南](../../GARMIN.md)
- [Zepp OS（Amazfit）手表端与中继说明](../../ZEPP_OS.md)
- [iPhone / Apple Watch / Health Connect 手机端总览](../../MOBILE.md)
- [健康平台与外部服务集成说明](../../INTEGRATIONS.md)
