# RN P2 功能文档

以五入口 RN 界面及 `4f152a5de` 上的代码为基线。每份功能文档包含**需求、实现设计、执行步骤、验收目标**。验收表逐条列出前置条件、操作和通过标准，记录实际结果及证据后更新 [迁移清单](../RN_MIGRATION_STATUS.md)。

## 高级训练与动作库

原 [高级训练与动作库目录](../../archive/rn-p2-training-library/README.md) 已归档。超级组、递减组、休息暂停组、RPE、RIR、动作收藏、动作演示均有独立验收表。

## 进度与身体数据

| 功能 | 完成条件 |
| --- | --- |
| [个人纪录（PR）](progress/01_PERSONAL_RECORDS.md) | 动作历史给出可追溯到原训练的实际纪录 |
| [估算 1RM](progress/02_ESTIMATED_1RM.md) | 按上游公式显示来源组、日期和估算曲线 |
| [训练趋势](progress/03_WORKOUT_TRENDS.md) | 时间范围内的次数、训练量和动作表现可核对 |
| [肌群图](progress/04_MUSCLE_MAP.md) | 按实际完成组显示覆盖和有效组分布 |
| [体重](progress/05_BODYWEIGHT.md) | 可维护称重读数并查看日值及周趋势 |
| [围度](progress/06_MEASUREMENTS.md) | 按日期和部位保存、纠错并查看历史 |
| [进度照片](progress/07_PROGRESS_PHOTOS.md) | 图片可添加、查看、删除，配对后可回读 |

## 导入、分享与连接

| 功能 | 完成条件 |
| --- | --- |
| [第三方历史导入](import-sharing-connection/01_HISTORY_IMPORT.md) | 文件识别、预览和导入结果与上游规则一致 |
| [计划分享](import-sharing-connection/02_PLAN_SHARING.md) | RN 与 Web 可互导计划文件，复制和排程选择可核对 |
| [二维码配对](import-sharing-connection/03_QR_PAIRING.md) | 扫描后确认地址，沿用移动端配对和账户隔离 |

## 平台集成

- [训练提醒](platform/01_TRAINING_REMINDERS.md)。按工作区计划和设备本地时刻调度 Android 通知。

## 共用流程

1. **实现顺序**。统计侧先共用已完成训练的去重、单位和日期投影，再接 PR、估算 1RM、趋势和肌群图。体重和围度经现有同步队列保存，进度照片依赖私有媒体传输。第三方历史导入与计划分享分别复用上游文件格式，二维码与提醒分别沿用现有配对和计划入口。
2. **数据回读**。离线场景用本机工作区，配对场景用独立测试 API，按 `baseRev/baseWid` 和 `409` 重试验证账户隔离、重放和 Web 读取。写入功能的具体数据、预期字段和边界见各自验收表。
3. **界面与发布**。使用 [RN 设计系统](../RN_UI_DESIGN_SYSTEM.md) 和 [视觉验收流程](../RN_UI_VISUAL_TESTING.md)。实现后在 `mobile-rn` 运行 `npm.cmd run check`，可见专用模拟器上用 Debug fixture、ADB 和截图验证入口。用正常模式及适配后的 [回归脚本](../../mobile-rn/scripts/README.md) 验证持久化、同步、实时时钟。涉及相机、媒体解码和锁屏通知时按各自验收表补真机检查。
4. **完成记录**。为单项填写对应验收表结果和证据，记录候选 APK、ABI、签名、SHA-256 和手动项目结果，再更新迁移清单。静态检查、冒烟和截图是共同工序，功能是否通过由该项验收表判定。
