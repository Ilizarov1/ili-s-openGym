# openGym 项目地图

Windows 环境统一使用 PowerShell。普通问答只读资料和源码，不运行测试。

## 代码

```text
mobile-rn/           Expo Android 工程与训练、历史、配对界面
mobile-rn/src/       计划、动作与历史编辑，训练数据、备份、提醒和同步
mobile-rn/src/progress/  PR、1RM、训练趋势和肌群图投影
mobile-rn/src/body/      体重、围度和进度照片
mobile-rn/src/sharing/   第三方历史导入、计划分享和上游模块兼容层
mobile-rn/src/pairing/   配对二维码解析
mobile-rn/src/reminders/ 训练提醒排程、通知和导航
mobile-rn/src/design/  RN 设计系统：tokens、主题、图标、基础组件、身体图和开发画廊
mobile-rn/eslint.config.js  RN ESLint 配置和导入边界
mobile-rn/scripts/   Android 模拟器回归、五 Tab 冒烟、视觉截图、fixture、目录媒体生成、自定义 lint 和图标检查
frontend/src/        Web 与 Capacitor 共用的页面、状态、训练和同步逻辑
frontend/android/    上游 Capacitor Android 工程与原生插件
frontend/ios/        上游 iOS、Apple Watch 和小组件
api/                 NestJS 路由、认证、设备配对、JSON 存储和同步；server.js 加载 dist
api/coach/           AI Coach 服务与共用逻辑
api/agent-runtime/   共享 Agent 运行核心（契约、围栏、编排、提供商）
api/src/agent/       NestJS Agent 模块、按账号存储、配置与作业
frontend/src/agent/  Web 服务端 Agent 客户端与 Zustand 状态
mobile-rn/src/agent/ RN 本机执行、SQLite、SecureStore 和服务端客户端
api/integrations/    外部集成和投递队列
web/                 Web 镜像构建和 Nginx 配置
catalogue/           动作原始数据、翻译和演示媒体
mcp/                 可选的训练数据 MCP 服务
watch-zepp/          Zepp OS 手表端
website/             项目官网
cloudflare/          站点边缘路由和故障切换
scripts/             动作目录生成、构建和发布工具
.github/、.gitlab/   CI、发布和贡献模板
docker-compose.yml   自托管服务入口
helm/、kubernetes/、contrib/nix/   其他部署方式
```

## 文档

```text
AGENTS.md                                项目地图
README.md                                产品功能和快速启动
CHANGELOG.md                             版本变更
ROADMAP.md                               上游路线图
CONTRIBUTING.md                          贡献流程
CLA.md                                   贡献者许可协议
CLAUDE.md                                上游开发指南
LICENSE                                  项目许可证
NOTICE.md                                第三方许可说明
SECURITY.md                              安全报告方式
.github/pull_request_template.md         GitHub PR 模板
.gitlab/issue_templates/Bug.md           GitLab 缺陷模板
.gitlab/issue_templates/Feature.md       GitLab 功能模板
.gitlab/issue_templates/Question.md      GitLab 提问模板
.gitlab/merge_request_templates/Default.md   GitLab 合并请求模板

docs/
  README.md                              文档入口
  ARCHITECTURE.md                        上游架构、同步与平台边界
  API.md                                 HTTP 接口使用说明
  MOBILE.md                              Capacitor 客户端与配对
  APP_STORES.md                          上游移动端构建和发布
  RN_MIGRATION_STATUS.md                 RN 已完成、待迁移和验收清单
  RN_UI_DESIGN_SYSTEM.md                 RN 设计系统架构、token、组件和治理
  RN_UI_SCREEN_MIGRATION.md              RN 已有页面重构设计、阶段和验收
  RN_UI_VISUAL_TESTING.md                RN 视觉测试流程、fixture、深链和设计系统硬性约束
  rn-exercise-search/
    DESIGN.md                            RN 常规动作检索的范围、共享规则与验收契约
    BASELINE.md                          入口、选择行为、分页基线和设备待验表
    ACCEPTANCE.md                        自动化验收证据、构建结果和待设备项
    01_ENTRY_BASELINE.md                 RN 搜索入口、选择行为和分页基线
    02_REUSE_WEB_SEARCH.md               Web 基础检索复用、双端对齐和回归
    03_EXISTING_ALIASES.md               已有用户别名读取、同步和工作区隔离
    04_COMBINED_FILTERS.md               目标肌群、器械和单侧组合筛选
    05_FUSE_SUGGESTIONS.md               Fuse.js 零结果候选和四入口集成验收
  agent-runtime/
    REQUIREMENTS.md                      双执行环境、上下文、工具围栏、记忆与验收要求
    DESIGN.md                            RN 与 NestJS 的模块、契约和持久化设计
    EXECUTION.md                         分阶段实施、验收证据和回退步骤
    ACCEPTANCE.md                        环境、命令、A1-A7 证据和待设备项
    REVIEW.md                            评审整改清单与本轮修改记录
    REVIEW2.md                           第二轮评审问题、证据与整改顺序
  rn-p2/
    README.md                            P2 功能导航、当前范围和共用流程
    progress/
      01_PERSONAL_RECORDS.md             个人纪录的比较规则和来源
      02_ESTIMATED_1RM.md                估算 1RM 的公式、历史曲线及验收
      03_WORKOUT_TRENDS.md               训练趋势的时间范围、汇总和动作指标
      04_MUSCLE_MAP.md                   训练覆盖肌群、有效组数和前后视图
      05_BODYWEIGHT.md                   体重读数、日值和周趋势
      06_MEASUREMENTS.md                 按日记录围度、单位转换和同步
      07_PROGRESS_PHOTOS.md              进度照片、日期归档和私有媒体同步
    import-sharing-connection/
      01_HISTORY_IMPORT.md               第三方历史文件预览、合并和去重
      02_PLAN_SHARING.md                 计划文件互导、复制和周排程选择
      03_QR_PAIRING.md                   移动端配对二维码、确认和账户隔离
    platform/
      01_TRAINING_REMINDERS.md           Android 训练日提醒、权限和时钟验收
  SELF_HOSTING.md                        Docker 自托管指南
  SELF_HOSTING_HTTPS.md                  局域网 HTTPS
  SELF_HOSTING_KUBERNETES.md             Kubernetes 部署
  SELF_HOSTING_MAC.md                    macOS 自托管
  NIX.md                                 NixOS 部署
  FAQ.md                                 常见问题
  MODULES.md                             功能模块开关
  DATA_IMPORTS.md                        数据导入导出
  INTEGRATIONS.md                        外部服务集成
  AI_COACH.md                            AI Coach 配置和使用
  GARMIN.md                              Garmin 端
  WEAR_OS.md                             Wear OS 端
  ZEPP_OS.md                             Zepp OS 端
  dev/COMBINE_ROUTINES.md                合并训练计划设计
  dev/FATIGUE_SETS_MODEL.md              肌群疲劳计算模型
  dev/LIST_VIEW.md                       训练界面的布局模式
  dev/SET_TYPES.md                       递减组和休息暂停组

archive/                                 已完成需求的实现、验收与证据归档
  README.md                              归档索引、完成状态和替代文档
  RN_ANDROID_EXECUTION.md                RN Android 0.1.x 实施与验收记录
  RN_UI_EXECUTION.md                     RN 设计系统实施与模拟器验收
  nestjs-migration/                      NestJS API 迁移设计、执行和验收
  rn-workout-set-ui/                     训练组行、组菜单和递减组实现与验收
  rn-replacement-picker/                 替换动作选择器实现与验收
  rn-p2-training-library/                P2 高级训练与动作库需求、设计和验收目标

api/openapi.yaml                         HTTP 接口契约
api/coach/prompts/
  common.md                              通用教练约束
  ask.md                                 日常训练问答
  adapt.md                               调整进行中的训练
  create.md                              创建训练计划
  review.md                              审查现有计划
  refine.md                              按反馈修订提案
  debrief.md                             复盘已结束训练
  repair.md                              修复未通过验证的提案

catalogue/
  README.md                              动作数据结构与构建
  i18n-glossary-pt-sv.md                  葡语和瑞典语翻译术语
  media/NOTICE.md                        动作媒体许可
  browse/README.md                       动作浏览入口
  browse/back.md                         背部动作目录
  browse/cardio.md                       有氧动作目录
  browse/chest.md                        胸部动作目录
  browse/full-body.md                    全身动作目录
  browse/lower-arms.md                   前臂动作目录
  browse/lower-legs.md                   小腿动作目录
  browse/neck.md                         颈部动作目录
  browse/shoulders.md                    肩部动作目录
  browse/upper-arms.md                   上臂动作目录
  browse/upper-legs.md                   大腿动作目录
  browse/waist.md                        腰腹动作目录

helm/README.md                           Helm 部署和参数
mcp/README.md                            MCP 接入、工具与认证
scripts/README.md                        构建和发布脚本索引
website/README.md                        官网源码和维护方式
```

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
