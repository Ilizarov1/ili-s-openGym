# openGym RN 设计系统

基线为 Android `0.1.4`，上游界面以当前仓库的 Web / Capacitor 客户端为准。本文规定 RN 客户端的设计系统架构、token、组件和验收方式。执行步骤见 [RN_UI_EXECUTION.md](RN_UI_EXECUTION.md)。

## 1. 目标与范围

目标：

- 让 RN 客户端与上游使用同一套颜色、字体、间距、圆角、图标和页面结构。
- 新页面只能通过设计系统组件搭建，不再逐屏手写颜色和字号。
- 为后续五 Tab 信息架构、身体肌群图、动作媒体和浅色主题提供基础。

本期范围：

- `tokens`、`themes`、`ThemeProvider`。
- 图标、`Text`、按钮、卡片、列表行、分段、芯片、搜索框、底部 sheet、TabBar 等基础组件。
- `BodyMap`、`MiniBodyMap`、`MediaThumb`。
- 开发用 `DesignGallery` 和图标同步检查脚本。
- 现有界面先切换到新颜色和字体，不重写页面结构。

本期非目标：

- 不重做五 Tab 导航。
- 不迁移 Home / Plan / Library 的完整页面布局。
- 不实现浅色主题设置入口、主题持久化或自定义强调色 UI。
- 不实现统计图表、动作动画、RPE/RIR 等数据功能。

## 2. 设计原则

1. **上游 CSS 是唯一规范。** 颜色、字号、间距、圆角和图标以 `frontend/src/index.css`、`frontend/src/components/Icon.jsx`、`frontend/src/components/BodyMap.jsx` 为准。
2. **语义 token 优先。** 页面不写 `#30d158` 或 `fontSize: 17`，只使用 `theme.colors.accent` 和 `Text variant="body"`。
3. **原生适配，不做 DOM 复刻。** CSS 的 `color-mix`、`backdrop-filter`、文字继承在 RN 中分别用颜色函数、实色和 `Text` 组件替代。
4. **组件先于页面。** 先建立可复用组件，再用组件拼页面；不要为了单个页面新增一次性样式。
5. **渐进迁移。** 新界面只使用 `mobile-rn/src/design`；旧界面短期保留，完成迁移后删除旧 `ui.tsx`。

## 3. 上游来源映射

| 上游文件 | RN 对应 | 用途 |
| --- | --- | --- |
| `frontend/src/index.css` `:root` | `design/tokens.ts`、`design/themes.ts` | 颜色、字号、圆角、间距、阴影、动效 |
| `frontend/src/components/Icon.jsx` | `design/icons/icon-paths.tsx`、`Icon.tsx` | 126 个 24×24 描边图标 |
| `frontend/src/components/BodyMap.jsx` | `design/patterns/BodyMap.tsx` | 正反面肌群图 |
| `frontend/src/components/MiniBodyMap.jsx` | `design/patterns/MiniBodyMap.tsx` | 计划行和首页卡片的缩略肌群图 |
| `frontend/src/lib/body-paths.js` | 直接复用 | 身体路径数据 |
| `frontend/src/lib/muscles.js` | 直接复用 `MUSCLES`、`INERT`、`levelsOf`、`loadOfRoutine` | 肌群语义和训练负荷 |
| `frontend/src/components/TabBar.jsx`、`index.css` `#tabbar` | `design/components/TabBar.tsx` | 五栏底部导航和中央开始按钮 |
| `frontend/src/components/Media.jsx`、`lib/exercises.js` | `design/patterns/MediaThumb.tsx` | 动作缩略图 |
| `frontend/src/components/Modals.jsx`、`index.css` `.sheet` | `design/components/Sheet.tsx` | 底部弹出层 |
| `frontend/src/views/Library.jsx` | 后续页面迁移 | 动作库、筛选表 |

上游新增或修改设计 token 时，同步更新这里列出的 RN 文件，并在 `docs/RN_UI_EXECUTION.md` 记录来源。

## 4. 架构分层

```text
tokens        原始值：色板、字号、间距、圆角、动效、尺寸
  ↓
themes        语义值：bg / surface / label / accent / danger，dark + light + accent
  ↓
primitives    Text / Button / Card / Icon / Screen / Chip / Segmented / Sheet / TabBar
  ↓
patterns      ListRow / IconTile / StatTile / BodyMap / MediaThumb / EmptyState
  ↓
screens       后续页面；只组合上面的组件
```

目录：

```text
mobile-rn/src/design/
  tokens.ts
  color.ts
  themes.ts
  ThemeProvider.tsx
  icons/
    icon-paths.tsx
    Icon.tsx
  components/
    Text.tsx
    PressableScale.tsx
    Button.tsx
    IconButton.tsx
    Card.tsx
    Screen.tsx
    Header.tsx
    ListRow.tsx
    IconTile.tsx
    Chip.tsx
    Segmented.tsx
    SearchField.tsx
    Sheet.tsx
    TabBar.tsx
    ProgressBar.tsx
    StatTile.tsx
    EmptyState.tsx
    Divider.tsx
    SectionHeader.tsx
    Badge.tsx
    index.ts
  patterns/
    BodyMap.tsx
    MiniBodyMap.tsx
    MediaThumb.tsx
    index.ts
  gallery/
    DesignGallery.tsx
  index.ts
```

约束：

- 只有 `tokens.ts`、`themes.ts`、`color.ts` 可以出现十六进制颜色。
- 只有 `tokens.ts` 可以出现字号、圆角、间距的原始数字。
- 组件不能从 `../../ui` 导入，也不能复制页面里的样式。
- 组件不能依赖训练数据或同步逻辑；`BodyMap`、`MiniBodyMap` 只接受纯数据。

## 5. Tokens

### 5.1 色板

原始色板取自上游 iOS 系统色：

| 名称 | 值 | 用途 |
| --- | --- | --- |
| `black` | `#000000` | 深色背景 |
| `white` | `#ffffff` | 深色主文字 |
| `gray1` | `#1c1c1e` | 卡片 |
| `gray2` | `#2c2c2e` | 次级面、按钮底 |
| `gray3` | `#3a3a3c` | 控件轨道 |
| `gray4` | `#636366` | 选中滑块 |
| `green` | `#30d158` | 深色默认强调色 |
| `greenPressed` | `#248a3d` | 深色强调色按下 |
| `blue` | `#0a84ff` | 信息、链接 |
| `orange` | `#ff9f0a` | 恢复、挑战、提醒 |
| `red` | `#ff453a` | 危险、删除 |
| `yellow` | `#ffd60a` | 目标、评分 |
| `teal` | `#40c8e0` | 辅助 |
| `indigo` | `#5e5ce6` | 备注 |
| `pink` | `#ff375f` | 辅助 |
| `purple` | `#bf5af2` | 辅助 |
| `mint` | `#63e6e2` | 辅助 |
| `brown` | `#ac8e68` | 辅助 |
| `grey` | `#8e8e93` | 中性 |

浅色主题色板：

| 名称 | 值 |
| --- | --- |
| `bg` | `#f2f2f7` |
| `bgEl` | `#f7f7fa` |
| `surface` | `#ffffff` |
| `surface2` | `#ececef` |
| `surface3` | `#e3e3e8` |
| `label` | `#000000` |
| `label2` | `rgba(60,60,67,0.75)` |
| `label3` | `rgba(60,60,67,0.30)` |
| `label4` | `rgba(60,60,67,0.16)` |
| `sep` | `rgba(60,60,67,0.29)` |
| `sepOp` | `rgba(60,60,67,0.20)` |

### 5.2 语义颜色

深色主题：

| Token | 值 | 用途 |
| --- | --- | --- |
| `bg` | `#000000` | 页面背景 |
| `bgEl` | `#0e0e10` | TabBar、sheet、弹出层 |
| `surface` | `#1c1c1e` | 卡片、输入框 |
| `surface2` | `#2c2c2e` | 次级按钮、按下填充 |
| `surface3` | `#3a3a3c` | 分段轨道、进度条底 |
| `label` | `#ffffff` | 主文字 |
| `label2` | `rgba(235,235,245,0.60)` | 次文字、说明 |
| `label3` | `rgba(235,235,245,0.32)` | 占位符、禁用 |
| `label4` | `rgba(235,235,245,0.18)` | grab handle、极弱线 |
| `sep` | `rgba(84,84,88,0.60)` | 列表分隔线 |
| `sepOp` | `rgba(84,84,88,0.34)` | TabBar 顶边、半透明分隔 |
| `accent` | `#30d158` | 主操作、选中态 |
| `accentPressed` | `#248a3d` | 主操作按下 |
| `accentInk` | `#30d158` | 深色主题的文字强调色 |
| `onAccent` | `#000000` | 强调色上的文字 |
| `accentSoft` | `rgba(48,209,88,0.16)` | 强调色浅底 |
| `accentLine` | `rgba(48,209,88,0.38)` | 强调色描边 |
| `danger` | `#ff453a` | 删除、错误 |
| `warning` | `#ff9f0a` | 警告、恢复 |
| `overlay` | `rgba(0,0,0,0.50)` | sheet 背景遮罩 |

浅色主题使用第 5.1 节的浅色值；`accentInk` 使用每个强调色的深色文字版本，保证在 `#f2f2f7` 和白色上的对比度。

### 5.3 强调色

默认 `green`（上游 `lime`）。支持 `green`、`blue`、`orange`、`purple`、`pink`、`red`、`teal`、`yellow`。

| 名称 | 深色 accent | 深色 onAccent | 浅色 accent | 浅色 accentInk | 浅色 onAccent |
| --- | --- | --- | --- | --- | --- |
| green | `#30d158` | 黑 | `#34c759` | `#1a7f37` | 黑 |
| blue | `#0a84ff` | 白 | `#007aff` | `#0062cc` | 白 |
| orange | `#ff9f0a` | 黑 | `#ff9500` | `#a85200` | 黑 |
| purple | `#bf5af2` | 白 | `#af52de` | `#8944ab` | 白 |
| pink | `#ff375f` | 白 | `#ff2d55` | `#d70036` | 白 |
| red | `#ff453a` | 白 | `#ff3b30` | `#d70015` | 白 |
| teal | `#40c8e0` | 黑 | `#30b0c7` | `#0071a4` | 黑 |
| yellow | `#ffd60a` | 黑 | `#ffcc00` | `#8f5e00` | 黑 |

`accentPressed` 使用上游 `--acc-2`：green `#248a3d`、blue `#0060df`、orange `#c76b00`、purple `#8944ab`、pink `#d70036`、red `#d70015`、teal `#0071a4`、yellow `#b25000`。

### 5.4 字体

| Variant | 字号 | 行高 | 字重 | 字距 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `pageTitle` | 30 | 32 | 700 | -0.84 | 手机页面标题（窄屏） |
| `pageTitleWide` | 34 | 36 | 700 | -0.95 | 平板/宽屏页面标题 |
| `title2` | 22 | 26 | 600 | -0.46 | 大号分区标题 |
| `title3` | 20 | 24 | 600 | -0.42 | 卡片标题、sheet 标题 |
| `headline` | 17 | 22 | 600 | -0.17 | 列表主标题加粗 |
| `body` | 17 | 22 | 400 | -0.17 | 正文、列表主标题 |
| `subhead` | 15 | 20 | 400 | -0.09 | 次级正文 |
| `footnote` | 13 | 18 | 400 | -0.05 | 说明、行副标题 |
| `chip` | 14 | 18 | 400 | -0.08 | 芯片文字 |
| `segment` | 14 | 18 | 500 | -0.08 | 分段控件文字 |
| `caption` | 12 | 16 | 400 | 0 | 标签、轴文字 |
| `caption2` | 11 | 14 | 500 | 0 | Tab 标签、徽标 |
| `button` | 17 | 22 | 600 | -0.20 | 按钮文字 |
| `tab` | 10 | 12 | 500 | 0.05 | TabBar 标签 |

规则：

- 使用系统字体，不打包 SF Pro。原版 Android 也使用系统字体。
- 默认允许系统字体缩放；不要给文字固定高度。
- `Text` 的 `numberOfLines`、`adjustsFontSizeToFit` 由调用方决定。

### 5.5 间距与圆角

| Token | 值 | 用途 |
| --- | --- | --- |
| `space.xxs` | 2 | 极紧贴 |
| `space.xs` | 4 | 图标与文字、微小间隔 |
| `space.sm` | 8 | 行内间隔 |
| `space.md` | 12 | 列表 gap、卡片间距 |
| `space.lg` | 16 | 页面边距、卡片内边距 |
| `space.xl` | 20 | 大块间隔 |
| `space.xxl` | 22 | 分区间隔 |
| `space.xxxl` | 32 | 空状态上下留白 |

| Token | 值 | 用途 |
| --- | --- | --- |
| `radius.xs` | 7 | 小标签、密集控件 |
| `radius.sm` | 8 | 小按钮 |
| `radius.md` | 9 | 分段轨道 |
| `radius.lg` | 12 | 按钮、输入框 |
| `radius.card` | 14 | 卡片 |
| `radius.xl` | 16 | 大卡片 |
| `radius.xxl` | 22 | sheet 顶部 |
| `radius.pill` | 99 | 胶囊按钮、芯片 |

| 布局 | 值 |
| --- | --- |
| 页面左右边距 | 16 |
| 卡片内边距 | 16 |
| 卡片间距 | 12 |
| 页面标题下方 | 18 |
| 列表行左右内边距 | 14 |
| 列表行上下内边距 | 11 |
| 列表行最小高度 | 46（实际点击区不小于 44） |
| 图标块 | 29（密集行）/ 36（卡片）/ 40（大块） |

### 5.6 尺寸

| Token | 值 | 用途 |
| --- | --- | --- |
| `sizes.icon` | 24 | 默认图标 |
| `sizes.tabIcon` | 25 | TabBar 图标 |
| `sizes.buttonIcon` | 19 | 按钮内图标 |
| `sizes.tileSm` | 29 | 密集列表图标块 |
| `sizes.tileMd` | 36 | 卡片图标块 |
| `sizes.tileLg` | 40 | 大图标块 |
| `sizes.touch` | 44 | 最小触控区 |
| `sizes.tabStart` | 52 | 中央开始按钮 |
| `sizes.input` | 46 | 输入框 |
| `sizes.button` | 46 | 默认按钮 |
| `sizes.hairline` | 0.5 | 分隔线 |

### 5.7 动效

| Token | 值 | 用途 |
| --- | --- | --- |
| `motion.fast` | 140ms | 按下、颜色变化 |
| `motion.med` | 220ms | 分段滑块 |
| `motion.sheet` | 340ms | sheet 进出 |
| `motion.ease` | `cubic-bezier(.32,.72,0,1)` | 全局 easing |
| `motion.pressScale` | 0.97 | 按钮按下 |
| `motion.pressScaleSmall` | 0.92 | 小按钮按下 |
| `motion.pressScaleCard` | 0.985 | 可点击卡片按下 |

开启系统“减少动态效果”时，取消缩放和位移动画，只保留透明度变化。

### 5.8 阴影

| Token | 值 | 用途 |
| --- | --- | --- |
| `shadow.tabStart` | accent 55%、y=6、radius=18、elevation=8 | 中央开始按钮 |
| `shadow.segThumb` | 黑色 24%、y=3、radius=8、elevation=2 | 分段滑块 |
| `shadow.sheet` | 黑色 35%、y=-8、radius=24、elevation=24 | sheet |

Android 彩色阴影在低版本可能不生效；中央按钮同时保留绿色圆形背景作为主要识别，不依赖阴影。

## 6. 主题与样式机制

`ThemeProvider` 提供：

```tsx
<ThemeProvider mode="dark" accent="green">
  <AppScreen />
</ThemeProvider>
```

- `useTheme(): Theme`：当前主题。
- `useThemeController(): { mode, accent, setMode, setAccent }`：开发画廊切换用。
- `useThemedStyles(factory)`：按主题缓存 `StyleSheet.create`。

`createTheme({ mode, accent })` 负责：

- 合并深色/浅色语义色。
- 计算 `accentSoft = alpha(accent, 0.16)`、`accentLine = alpha(accent, 0.38)`。
- 根据模式选择 `accentInk`、`onAccent`、`accentPressed`。
- 返回 `theme.colors`、`space`、`radius`、`type`、`motion`、`shadows`、`sizes`。

颜色工具：

```ts
alpha('#30d158', 0.16)        // rgba(48,209,88,0.16)
mix('#30d158', '#1c1c1e', .32) // 32% accent + 68% base
```

`mix` 的第一个参数是前景，第二个是背景，第三个是前景比例。

## 7. 组件规范

所有组件：

- 使用 `useTheme()` 或 `useThemedStyles()`，不写死颜色。
- 支持 `style?: StyleProp<ViewStyle>` 或 `StyleProp<TextStyle>`。
- 支持 `testID`，用于 ADB 和后续自动化。
- 默认 `accessibilityRole` 正确；可点击元素有 `accessibilityLabel` 或可见文字。
- 触控区不小于 44×44；小图标通过 `hitSlop` 补足。
- 禁用状态有 `disabled`，并设置 `accessibilityState={{ disabled: true }}`。

### 7.1 Text

```tsx
type TextVariant =
  | 'pageTitle' | 'pageTitleWide' | 'title2' | 'title3' | 'headline'
  | 'body' | 'subhead' | 'footnote' | 'caption' | 'caption2' | 'button' | 'tab';

type TextTone =
  | 'label' | 'secondary' | 'tertiary' | 'quaternary'
  | 'accent' | 'danger' | 'onAccent';

type TextProps = React.ComponentProps<typeof RNText> & {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
};
```

默认 `variant="body"`、`tone="label"`。`style` 最后合并，允许局部覆盖；但页面不应依赖覆盖来改变字号。

### 7.2 Icon

```tsx
type IconProps = {
  name: IconName;
  size?: number;                 // 默认 24
  color?: string;                // 默认 theme.colors.label
  strokeWidth?: number;          // 默认 1.7
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;   // 不传时 aria-hidden
};
```

- 24×24 viewBox，`strokeLinecap="round"`、`strokeLinejoin="round"`。
- 图标名与上游 `P` 对象一致。
- `ICON_NAMES` 导出全部名称，供 drift 检查和画廊使用。
- 使用 `React.memo`，避免训练页大量图标重复渲染。

### 7.3 IconTile

```tsx
type IconTileProps = {
  name: IconName;
  size?: 'sm' | 'md' | 'lg';     // 29 / 36 / 40
  tone?: 'accent' | 'soft' | 'orange' | 'blue' | 'neutral';
  style?: StyleProp<ViewStyle>;
};
```

- `accent`：背景 `accent`，图标 `onAccent`。用于计划/首页主图标。
- `soft`：背景 `accentSoft`，图标 `accentInk`。
- `orange` / `blue`：对应浅底 + 对应颜色。
- `neutral`：背景 `surface2`，图标 `label2`。
- 圆角：29 → 7，36 → 10，40 → 11。

### 7.4 Button

```tsx
type ButtonVariant = 'primary' | 'secondary' | 'tinted' | 'ghost' | 'danger';
type ButtonSize = 'md' | 'sm' | 'xs';

type ButtonProps = {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;       // 默认 secondary
  size?: ButtonSize;             // 默认 md
  icon?: IconName;
  iconPosition?: 'left' | 'right';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;           // md 默认 true，sm/xs 默认 false
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};
```

样式：

| Variant | 背景 | 文字/图标 |
| --- | --- | --- |
| primary | `accent` | `onAccent` |
| secondary | `surface2` | `label` |
| tinted | `accentSoft` | `accentInk` |
| ghost | 透明 | `accentInk` |
| danger | `alpha(danger, .15)` | `danger` |

尺寸：

- md：minHeight 46，padding 14/18，radius 12，`type.button`。
- sm：minHeight 34，padding 8/14，radius 8，字号 15/600，图标 16。
- xs：minHeight 28，padding 5/10，radius 7，字号 13/600，图标 14。

按下：`scale(pressScale)`，140ms；`primary` 按下背景 `accentPressed`。加载时显示 `ActivityIndicator`，禁止重复点击。

### 7.5 IconButton

```tsx
type IconButtonProps = {
  name: IconName;
  onPress?: () => void;
  size?: 'sm' | 'md';            // 36 / 44
  tone?: 'neutral' | 'accent' | 'danger';
  disabled?: boolean;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
};
```

- 圆形，背景 `surface2`（neutral）、`accentSoft`（accent）、`alpha(danger,.15)`（danger）。
- 图标默认 20，居中。
- 用于齿轮、关闭、更多、分享。

### 7.6 Card

```tsx
type CardProps = {
  children: React.ReactNode;
  onPress?: () => void;
  padded?: boolean;              // 默认 true
  gap?: number;                  // 默认 10
  style?: StyleProp<ViewStyle>;
  testID?: string;
};
```

- 背景 `surface`，圆角 14，内边距 16，`marginBottom` 12，无边框。
- `padded={false}` 用于装 `ListRow` 或媒体。
- 可点击时使用 `PressableScale`，缩放 `pressScaleCard`。

### 7.7 Screen

```tsx
type ScreenProps = {
  children: React.ReactNode;
  scroll?: boolean;              // 默认 true
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  edges?: Array<'top' | 'right' | 'bottom' | 'left'>;
  testID?: string;
};
```

- 背景 `bg`。
- SafeArea 默认 `top/left/right`；底部由 TabBar 或页面自己处理。
- 滚动内容 padding 16，底部 28。
- 非滚动模式使用 `View flex:1`。

### 7.8 Header

```tsx
type HeaderProps = {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onBack?: () => void;
  compact?: boolean;             // 子页面用 title3
  style?: StyleProp<ViewStyle>;
};
```

- 大标题：`pageTitle`，行高 32，margin 8/0/18。
- 副标题：`subhead` + `label2`，marginTop 4。
- `right` 放齿轮、分享、更多；`onBack` 显示 `chevronLeft` IconButton。
- 标题不换行时使用 `numberOfLines={1}`；需要换行时保留默认。

### 7.9 ListRow

```tsx
type ListRowProps = {
  leading?: React.ReactNode;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  chevron?: boolean;             // 默认 false
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};
```

- 行高最小 46，padding 11/14，gap 12。
- 标题 `body`，副标题 `footnote` + `label2`。
- 按下背景 `surface2`，不缩放（列表行用填充反馈）。
- `chevron` 在 trailing 后显示 18px `chevronRight`，颜色 `label3`。
- 不自动画分隔线；需要时用 `Divider`。

### 7.10 Chip

```tsx
type ChipProps = {
  children: React.ReactNode;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  size?: 'md' | 'sm';            // 14 / 12
  tone?: 'accent' | 'neutral';   // 默认 accent
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};
```

- md：padding 6/13，radius 99，字号 14。
- sm：padding 3/10，radius 99，字号 12。
- 未选中背景 `surface`，文字 `label`；选中背景 `accent`，文字 `onAccent`。
- 按下缩放 `pressScale`。
- 动作库筛选行使用 neutral 选中态（`surface3` + `label`），避免强调色被筛选按钮用光。

### 7.11 Segmented

```tsx
type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconName;
};

type SegmentedProps<T extends string> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};
```

- 轨道背景 `rgba(118,118,128,0.24)`，radius 9，padding 2，高 32。
- 选中滑块 `#636366`，radius 7，阴影 `shadow.segThumb`，220ms 动画。
- 文字 14/500；未选中 `label2`/400；选中 `label`/500。
- 使用 `onLayout` 计算滑块宽度，`Animated.timing` 平移。
- 无障碍：每个选项 `accessibilityRole="button"`，`accessibilityState={{ selected }}`。

### 7.12 SearchField

```tsx
type SearchFieldProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onClear?: () => void;
  resultCount?: number;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};
```

- 容器背景 `surface`，radius 12，minHeight 46，padding 0/12。
- 左侧 `magnifier` 19，颜色 `label2`。
- 输入 17/400，占位符 `label3`。
- 有值时显示 `xmark` 圆形清除按钮，44×44 触控区。
- `resultCount` 显示在右侧，`footnote` + `label2`。

### 7.13 Sheet

```tsx
type SheetProps = {
  visible: boolean;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  dismissible?: boolean;         // 默认 true
  testID?: string;
};
```

- `Modal transparent statusBarTranslucent navigationBarTranslucent`。
- 遮罩 `overlay`；点击遮罩关闭。
- 面板背景 `bgEl`，顶部圆角 22，padding 8/18/(20+bottom inset)。
- 顶部 grab：36×5，radius 99，`label4`，margin 6/auto/14。
- 标题 `title3`，marginBottom 14。
- 内容可滚动；`footer` 固定在底部，上方 12 间隔。
- 进出动画 340ms；支持下滑关闭（dy > 90 或快速下滑）。
- `onRequestClose` 绑定 `onClose`，支持 Android 返回键。

### 7.14 TabBar

```tsx
type TabItem = { key: string; label: string; icon: IconName };

type TabBarProps = {
  tabs: [TabItem, TabItem, TabItem, TabItem]; // 中央开始按钮两侧各两项
  active: string;
  onSelect: (key: string) => void;
  onStart: () => void;
  startLabel?: string;           // 默认“开始”
  runningLabel?: string;         // 运行中显示时长
  running?: boolean;
  testID?: string;
};
```

- 背景 `bgEl`，顶部 0.5px `sepOp` 边，padding 7/6/(6+bottom inset)。
- 4 个 tab：图标 25，标签 `type.tab`；未选中 `label2`，选中 `accent`。
- 中央按钮：52×52，marginTop -24，背景 `accent`，图标 `play` 26/2.0，阴影 `shadow.tabStart`，标签 10/600 accent。
- 运行中：背景 `warning`，图标/文字黑色，标签显示时长。
- 无障碍：tab `accessibilityRole="tab"`、`accessibilityState={{ selected }}`；中央按钮 `accessibilityLabel`。

### 7.15 Divider

```tsx
type DividerProps = {
  inset?: number;                // 左侧缩进，默认 0
  style?: StyleProp<ViewStyle>;
};
```

- 高度 0.5，背景 `sep`，可设置 `marginLeft`。

### 7.16 SectionHeader

```tsx
type SectionHeaderProps = {
  title: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};
```

- 标题 `footnote` + `label2`，大写可选；右侧 action 用 `Button size="xs" variant="ghost"`。

### 7.17 Badge

```tsx
type BadgeProps = {
  children: React.ReactNode;
  tone?: 'accent' | 'neutral' | 'orange' | 'danger';
  style?: StyleProp<ViewStyle>;
};
```

- 背景对应浅底，文字对应颜色，radius 6，padding 2/6，`caption2`。

### 7.18 ProgressBar

```tsx
type ProgressBarProps = {
  value: number;                 // 0..1
  tone?: 'accent' | 'orange';
  height?: number;               // 默认 6
  style?: StyleProp<ViewStyle>;
};
```

- 底 `surface3`，前景 `accent` 或 `warning`，圆角 99。
- 宽度钳制 0..1。

### 7.19 StatTile

```tsx
type StatTileProps = {
  icon?: IconName;
  label: string;
  value: string;
  detail?: string;
  tone?: 'accent' | 'orange' | 'blue' | 'neutral';
  style?: StyleProp<ViewStyle>;
};
```

- 行布局：IconTile + 文本列；value `title2`，label `caption` + `label2`，detail `footnote`。
- 用于统计页概览。

### 7.20 EmptyState

```tsx
type EmptyStateProps = {
  icon?: IconName;
  title: string;
  text?: string;
  children?: React.ReactNode;    // 操作按钮
  style?: StyleProp<ViewStyle>;
};
```

- 居中，padding 32，图标 40 + `label3`，标题 `title3`，说明 `subhead` + `label2`，操作区 gap 12。

### 7.21 PressableScale

```tsx
type PressableScaleProps = {
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  scaleTo?: number;              // 默认 0.97
  style?: StyleProp<ViewStyle>;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityState?: AccessibilityState;
  testID?: string;
  onPressIn?: () => void;
  onPressOut?: () => void;
};
```

- 使用 `Animated.Value` + `Animated.spring`，`useNativeDriver: true`。
- 尊重 reduced motion；禁用时不做缩放。
- 作为 Button、IconButton、Card、Chip 的底层。

## 8. Patterns

### 8.1 BodyMap

```tsx
type BodyMapProps = {
  load?: Record<string, number>; // muscle slug -> effective sets
  levels?: Record<string, number>; // 0..4，优先级高于 load
  body?: 'male' | 'female';
  height?: number;               // 每个视图高度，默认 min(340, 屏幕高 * .46)
  style?: StyleProp<ViewStyle>;
};
```

- 直接导入 `../../../../frontend/src/lib/body-paths.js` 默认导出。
- 直接导入 `MUSCLES`、`INERT`、`levelsOf`。
- 两个 `Svg`：正面/背面，`viewBox` 来自路径数据的 `vb`。
- 颜色：
  - 全身底板 `mix(surface, label, .11)`。
  - 迷你底板 `mix(surface, label, .26)`。
  - 轮廓 `mix(surface, label, .18)`；迷你 `mix(surface, label, .34)`。
  - l1 = `mix(accent, base, .32)`、l2 `.56`、l3 `.78`、l4 `100%`。
- 迷你图轮廓描边 3（viewBox 单位），全身图 1。

### 8.2 MiniBodyMap

```tsx
type MiniBodyMapProps = {
  routines: Array<{ ex?: Array<{ id: string; sets?: number }> }>;
  body?: 'male' | 'female';
  height?: number;               // 默认 46
  style?: StyleProp<ViewStyle>;
};
```

- 使用 `loadOfRoutine({ ex: routines.flatMap(r => r.ex ?? []) })`。
- 没有负荷时返回 `null`。
- 用于计划行、首页今日卡、训练标题。

### 8.3 MediaThumb

```tsx
type MediaThumbProps = {
  exerciseId: string;
  server?: string | null;        // 配对服务器地址
  size?: number;                 // 默认 56
  radius?: number;               // 默认 10
  style?: StyleProp<ViewStyle>;
  testID?: string;
};
```

- 使用 `expo-image` 的 `Image`，`cachePolicy="memory-disk"`，`contentFit="cover"`。
- URL：`{server}/exercise-media/still/{canonicalId}.webp`。
- `canonicalId` 通过 `EXALIAS` 解析；别名动作使用目标 ID。
- 无服务器、加载失败、自定义动作时显示 `surface2` 中性块 + `dumbbell` 图标。
- 不打包动作图片；图片由服务器提供并缓存。

### 8.4 DesignGallery

- 只在 `__DEV__` 中从设置页入口打开。
- 依次展示：
  1. 主题切换（dark/light）和强调色 chips。
  2. 色板、字体层级。
  3. 图标网格（全部 `ICON_NAMES`）。
  4. Button 全部 variant/size/状态。
  5. IconButton、Chip、Segmented、SearchField。
  6. Card、ListRow、IconTile、Divider、Badge、SectionHeader。
  7. ProgressBar、StatTile、EmptyState。
  8. BodyMap、MiniBodyMap、MediaThumb。
  9. Sheet 演示按钮。
  10. TabBar 静态预览。
- 每个区块有标题和说明；使用 `testID` 方便 ADB 定位。
- 画廊本身是设计系统的活文档，新增组件必须同步加入。

## 9. 图标与资产

### 9.1 图标

- 从 `frontend/src/components/Icon.jsx` 的 `P` 对象完整移植 126 个图标。
- 保留原名；`ICON_NAMES` 由对象键生成。
- 移植时保留 `fill="currentColor"` 的图标（`starFill`、`dot`、`more`、`grip`、`info` 的小圆点等）。
- `grip` 的数组 map 展开为 6 个 `Circle`，不要保留运行时数组。
- 不新增上游没有的图标；确需新增时先加到上游，再同步。

### 9.2 身体图

- 路径数据不复制，直接复用 `frontend/src/lib/body-paths.js`。
- 肌群语义不复制，直接复用 `frontend/src/lib/muscles.js`。
- 后续上游路径更新时，RN 自动获得新数据。

### 9.3 动作媒体

- 静图在服务器 `exercise-media/still/<id>.webp`，由 `expo-image` 磁盘缓存。
- 动画/视频不在本期范围。
- 练习模式无服务器时用中性占位图。

## 10. 可访问性

- 触控区不小于 44×44；小图标使用 `hitSlop`。
- 可点击元素必须有 `accessibilityRole` 和可读标签。
- 选中态用 `accessibilityState={{ selected }}`，禁用态用 `disabled`。
- 支持系统字体缩放；不要给文字固定高度。
- 颜色对比：正文和按钮文字至少 4.5:1，大字号至少 3:1；浅色主题的 `accentInk` 已按上游对比度选择。
- 支持系统“减少动态效果”：取消缩放、位移和 sheet 动画。
- 图标默认装饰性（`accessible={false}`）；只有单独承担操作时才传 `accessibilityLabel`。

## 11. 治理

### 11.1 硬规则

1. `src/screens/**` 和 `App.tsx` 不允许出现十六进制颜色、`fontSize`、`borderRadius` 原始数字。
2. 页面不允许从 `src/ui.tsx` 导入新组件；迁移完成后删除该文件。
3. 列表行不允许直接堆多个全宽按钮；操作放详情、chevron 或 sheet。
4. 新图标必须来自上游 `Icon.jsx`；新颜色必须来自 token。
5. 组件新增或修改必须同步 `DesignGallery`。
6. 只有 `design/` 内部可以写样式常量；页面只传布局相关的 `style`（如 `marginTop`）。

### 11.2 检查脚本

`mobile-rn/scripts/check-design-system.mjs`：

- 解析上游 `Icon.jsx` 的图标名，与 `design/icons/icon-paths.tsx` 的 `ICON_NAMES` 比较，缺少时退出码 1。
- 扫描 `src/screens/**` 和 `App.tsx`（存在时）中的十六进制颜色和 `fontSize`，发现后退出码 1；迁移期可对 `App.tsx` 设置白名单，清理后移除。
- 输出检查摘要。

`package.json`：

```json
"design:check": "node scripts/check-design-system.mjs"
```

### 11.3 变更流程

- 上游 token 变化：先更新本文和 `tokens.ts`/`themes.ts`，再更新 Gallery 截图。
- 新组件：先在 Gallery 中列出，再在页面使用。
- 页面迁移：每个页面单独提交，迁移后删除该页面对 `ui.tsx` 的依赖。
- 设计评审：固定模拟器 412×915，对比 Home / Plan / Library / Sheet 截图；记录在 `docs/RN_UI_EXECUTION.md`。

## 12. 与旧 UI 的迁移

本期先做“颜色桥接”：

- `ui.tsx` 的 `color` 改为引用 `darkTheme.colors`。
- 卡片去掉边框，改用 `surface` + 14 圆角。
- 页面标题改为 30/700，正文 17/400，卡片标题 17/600。
- 按钮和输入框改用新颜色、圆角和背景。

后续页面迁移顺序：

1. Plan（验证 Header、Segmented、Card、ListRow、IconTile、MiniBodyMap）。
2. Home（验证周条、今日卡、IconTile、MiniBodyMap、TabBar）。
3. Library（验证 SearchField、Chip、Sheet、MediaThumb）。
4. Stats / Workout / History / Settings。
5. 删除 `ui.tsx`。

## 13. 验收

- `npm.cmd run typecheck` 通过。
- `npm.cmd run design:check` 通过。
- 可见 Android 模拟器打开 DesignGallery，dark/light、图标、按钮、chip、segmented、sheet、body map、tab bar 均正常渲染。
- `adb logcat` 无 `ReactNativeJS` 错误。
- 旧界面颜色和字体已切换到新 token，训练流程不受影响。
- 设计文档与执行文档中的文件路径、API 和实际代码一致。

## 14. 参考

- `frontend/src/index.css`：颜色、字体、卡片、按钮、chip、segmented、tabbar、sheet。
- `frontend/src/components/Icon.jsx`：图标路径和描边规范。
- `frontend/src/components/BodyMap.jsx`、`MiniBodyMap.jsx`、`lib/muscles.js`、`lib/body-paths.js`。
- `frontend/src/components/TabBar.jsx`：五栏导航和中央开始按钮。
- `frontend/src/views/Library.jsx`：动作库与筛选 sheet 的交互参考。
- `docs/RN_ANDROID_DESIGN.md`、`docs/RN_ANDROID_EXECUTION.md`：RN 客户端现有约束。

## 15. 已知限制

- Android 15/16 边到边模式下，浅色主题的状态栏仍保留深色条和浅色图标；内容区已正确切换，后续接原生状态栏 API 时修复。
- 动作缩略图依赖配对服务器；练习模式显示中性占位图，不打包 33 MB 静图或 157 MB 动画。
- `react-native-svg`、`expo-image` 是原生模块，新增或升级后必须重新 prebuild 和 Gradle 构建。
- 本期只完成设计系统、开发画廊和旧界面的颜色/字体桥接；Home、Plan、Library、Stats 的页面结构迁移不在本期范围。
