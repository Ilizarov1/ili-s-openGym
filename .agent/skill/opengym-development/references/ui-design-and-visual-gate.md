# UI 设计系统九维审查清单与真实操作 GIF 硬验收规范

本手册约束 `mobile-rn` 与 `web-client` 所有涉及用户可见界面的变更。

---

## 1. 设计系统前置必读基准

| 客户端 | 必读规范与代码真源 | 静态自动化门禁 |
|---|---|---|
| **RN Android (`mobile-rn`)** | [`docs/RN_UI_DESIGN_SYSTEM.md`](../../../../docs/RN_UI_DESIGN_SYSTEM.md)、[`docs/RN_UI_SCREEN_MIGRATION.md`](../../../../docs/RN_UI_SCREEN_MIGRATION.md)、[`docs/RN_UI_VISUAL_TESTING.md`](../../../../docs/RN_UI_VISUAL_TESTING.md)、`mobile-rn/src/design/` | `cd mobile-rn; npm.cmd run check`（含 `design:check`） |
| **Web / Capacitor (`web-client`)** | `frontend/src/index.css`（`:root` 颜色/圆角/字号变量）、`frontend/src/components/`、`frontend/src/sheets.jsx` | `cd frontend; npm.cmd test`、`check-locales.mjs`、`check-source-strings.mjs --strict` |

---

## 2. UI 九维深度审查清单（修改 UI 逐项过筛）

### ① Token 与组件原语纯洁度
- [ ] 页面与业务组件内**零硬编码**十六进制颜色（`#...`/`rgb(...)`）、裸字号、裸圆角或随意拼凑的内外边距。
- [ ] 优先组合既有原语（RN：`Screen`、`Header`、`Card`、`ListRow`、`Button`、`Chip`、`Segmented`、`SearchField`、`Sheet`；Web：共享 `Icon`、`.sheet`、标准按钮与表单样式），新增通用组件须同步纳入 `DesignGallery`（RN）。

### ② 间距节奏、对齐与数字防抖
- [ ] 容器左右内边距、卡片组垂直间距、标题与正文间距严格遵循设计系统阶梯，视觉重心对齐。
- [ ] 图标（24×24 / 20×20）与单行文本光学垂直居中；与多行折行文本搭配时采用首行基线/顶部对齐，禁止图标悬空漂移。
- [ ] 列表分割线（`Divider`）起止缩进与文本列左边缘对齐一致。
- [ ] 计时器、重量、次数、1RM、百分比等动态变化数值一律启用等宽数字（CSS `font-variant-numeric: tabular-nums` / RN `fontVariant: ['tabular-nums']`），防止跳秒或加减步进时整行文字左右抖动。

### ③ 文本截断、折行与多语言/大字号弹性
- [ ] Flex 行内文本容器显式声明 `flexShrink: 1`（RN）或 `min-width: 0`（Web CSS），防止超长自定义动作名或德语/俄语长词顶出右侧操作按钮或徽章。
- [ ] 明确区分**单行截断**（`numberOfLines={1}` / `text-overflow: ellipsis`，用于 Chip、Tab、紧凑表头）与**受控多行折行**（2~3 行，用于动作名称、错误提示），核心业务数值（重量 × 次数）绝不允许被截断为 `...`。
- [ ] 兼容阿拉伯语等 RTL 布局方向（使用逻辑属性 `paddingHorizontal`/`marginStart` 或 CSS 逻辑内边距，方向性箭头按语言方向镜像）及系统字体放大（125%~150%）不发生文字重叠或裁切。

### ④ 移动端触摸热区与手势解耦
- [ ] 所有可点击/可勾选元素实际触控热区 **≥ 44×44 dp/px**；视觉尺寸较小的关闭按钮、菜单图标、复选框必须配置 `hitSlop` 或外层透明内边距扩展热区，相邻破坏性按钮留足防误触间距。
- [ ] 具备清晰的按下态（Pressed 缩放或透明度变化）、禁用态（Disabled）与异步加载态反馈。
- [ ] 横向手势（左滑删组、右滑复制组、横向滚动筛选 Chip）与外层纵向 `ScrollView`/`FlatList`、底部 `Sheet` 下拉关闭手势互不抢占，斜向滑动不误触发删改。

### ⑤ 视口宽度变化与软键盘下的焦点保持（高频易错点）
- [ ] **禁止动态卸载导致失焦**：响应式断点切换（窄屏 ↔ 宽屏、手机横竖屏、平板分屏调整宽度）或父组件状态更新时，严禁在渲染函数内部内联定义子组件（`const Row = () => ...`）或使用随输入内容变化的 `key`，确保当前聚焦的 `TextInput`/`<input>` 保持焦点、光标选区位置与未提交草稿不丢失。
- [ ] **软键盘避让与滚动可见**：移动端软键盘弹出/切换输入行时，底部主提交按钮与当前聚焦输入框不被键盘或浮动工具栏遮挡，收起键盘后滚动偏移正常复位。
- [ ] Web 端支持完整键盘可达性（`Tab` 顺序合理、`Enter` 提交、`Escape` 关闭弹窗并将焦点归还触发按钮）。

### ⑥ 安全区（Safe Area）与底部浮层叠加
- [ ] 顶部适配状态栏、刘海/灵动岛/挖孔屏；底部适配系统手势导航条（Home Indicator）。
- [ ] 当页面存在底部 `TabBar`、进行中训练浮条、休息倒计时 `RestDock` 或底部固定操作栏时，滚动列表底部 `contentContainerStyle` / `padding-bottom` 必须留足浮层总高度 + 安全区余量，确保最后一组训练行或末尾按钮可完整滚出并顺畅点击。

### ⑦ 五态完备性（5-State Matrix）
- [ ] **Empty（空态）**：无计划、无历史、筛选零结果时提供明确说明与下一步主引导动作，不留空白死屏。
- [ ] **Loading（加载态）**：异步拉取或 AI 识别期间保留稳定占位高度，避免内容返回时剧烈布局偏移（CLS），并支持中途取消。
- [ ] **Populated（常规与极值态）**：同时验证 1 条数据与 50+ 条数据、含热身/递减/超级组混合、超长备注等极值场景。
- [ ] **Error / Offline（异常与离线态）**：断网、409 同步冲突、相机/通知权限被拒时给出人话提示与重试/本地继续入口，不吞错也不裸露堆栈。
- [ ] **Pending / Disabled（防重入态）**：保存、导入、配对兑换按钮在异步处理中幂等加锁，防止快速双击产生重复记录。

### ⑧ 暗色/浅色双主题与无障碍对比度
- [ ] 同时在 **Dark** 与 **Light** 主题（及自定义强调色）下核验背景层级（`bg` / `surface` / `elevated`）、卡片描边、次要说明文字与占位符对比度，杜绝“黑底深灰字”或“白底浅灰字”不可读。
- [ ] 尊重系统减少动态效果设置（Web `prefers-reduced-motion: reduce` / RN `AccessibilityInfo.isReduceMotionEnabled`），非必要循环动效可降级为静态或淡入淡出。

### ⑨ 列表虚拟化与交互帧率
- [ ] 动作库（5,600+ 条目）、历史记录等大数据集保持虚拟化渲染或增量分页，输入搜索词时筛选响应流畅，不阻塞输入法上屏。

---

## 3. 前端硬验收：真实操作 GIF 强制门禁

> **铁律：单测全绿不等于视觉过关（Tests alone do not establish visual acceptance）。**

### 3.1 适用范围
凡 PR 或开发任务涉及上述任意用户可见 GUI 行为变化（Web、Capacitor 或 RN Android），**必须**交付真实操作录屏转换的 `.gif` 动图证据。纯后端无界面逻辑、纯构建脚本或纯文档改动除外（须在变更声明中明确标注 `GUI 变更：无`）。

### 3.2 GIF 质量与内容要求
1. **真实连贯交互**：必须在真实运行的浏览器页面或 Android 模拟器/真机上实际点击、输入、滑动录制，完整包含 **「触发前状态 → 交互动作过程 → 变更后终态」**（建议时长 3~15 秒，帧率 10~15 fps，宽度 360~720 px，兼顾清晰度与仓库体积，单文件宜控制在 5 MB 以内）。
2. **严禁伪造替代**：不得用静态单图重命名为 `.gif`，不得只录空白加载帧，涉及响应式宽度焦点保持或软键盘避让的需求必须在 GIF 中直接演示拉宽窗口/弹出软键盘焦点不丢失的过程。
3. **落盘与引用位置**：
   - 保存路径：`.agent/notes/proposed/<feature-slug>/evidence/<flow>.gif`（验收完成后随目录迁入 `.agent/notes/implemented/<feature-slug>/evidence/<flow>.gif`）。
   - 在对应需求文档（`ACCEPTANCE.md` 或 `PROPOSAL.md`）中使用相对路径嵌入展示：`![<交互说明>](evidence/<flow>.gif)`。

### 3.3 录制工具速查（Windows PowerShell）
- **RN Android 模拟器/真机一键录制转 GIF**：
  ```powershell
  # 先按 rn-android-env.md 申领模拟器取得 $serial，再录制 8 秒操作并自动生成调色板优化 GIF
  .\.agent\scripts\record-gif.ps1 -Serial emulator-5556 -Seconds 8 -Out .\.agent\notes\proposed\<slug>\evidence\<flow>.gif
  ```
- **Web 浏览器交互录制转 GIF**：
  - 使用浏览器自动化录屏导出 `.webm`/`.mp4` 后，调用同一脚本转换：
    ```powershell
    .\.agent\scripts\record-gif.ps1 -InputVideo .\recording.webm -Out .\.agent\notes\proposed\<slug>\evidence\<flow>.gif
    ```
