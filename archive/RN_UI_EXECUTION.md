# openGym RN 设计系统执行方案

本文是 [RN_UI_DESIGN_SYSTEM.md](../docs/RN_UI_DESIGN_SYSTEM.md) 的执行清单。按顺序执行；任务 1、2、3 可并行，任务 4 之后由主 Agent 完成。每个任务都写明了文件、接口、约束和验收命令。

页面重构（五 Tab、首页、计划、统计、动作库、设置）见 [RN_UI_SCREEN_MIGRATION.md](../docs/RN_UI_SCREEN_MIGRATION.md)。五 Tab 冒烟脚本为 `mobile-rn/scripts/five-tab-smoke.ps1`。

## 0. 前置条件

- 工作目录：`D:\dev\open-gym`。
- RN 目录：`mobile-rn/`。
- 已安装：`react-native-svg@15.15.3`、`expo-image@~55.0.11`。
- 已安装 Expo SDK 55、RN 0.83、TypeScript。
- Android 模拟器 `emulator-5556` 已启动，分辨率 1080×2400，密度 420（逻辑约 412×915）。
- 工具链：
  - JDK：`C:\Users\zjzjn\AppData\Local\RnToolchain\jdk-17.0.21+9`
  - Android SDK：`C:\Users\zjzjn\AppData\Local\RnToolchain\android-sdk`
  - ADB：`C:\Users\zjzjn\AppData\Local\RnToolchain\android-sdk\platform-tools\adb.exe`

## 1. 文件所有权

并行任务只允许修改自己名下的文件。任务 4 由主 Agent 负责。

| 任务 | 文件 |
| --- | --- |
| 任务 1 | `mobile-rn/src/design/tokens.ts`、`color.ts`、`themes.ts`、`ThemeProvider.tsx`、`icons/icon-paths.tsx`、`icons/Icon.tsx`、`components/Text.tsx` |
| 任务 2 | `mobile-rn/src/design/components/PressableScale.tsx`、`Button.tsx`、`IconButton.tsx`、`Card.tsx`、`Screen.tsx`、`Header.tsx`、`ListRow.tsx`、`IconTile.tsx`、`Chip.tsx`、`Segmented.tsx`、`SearchField.tsx`、`Sheet.tsx`、`TabBar.tsx`、`ProgressBar.tsx`、`StatTile.tsx`、`EmptyState.tsx`、`Divider.tsx`、`SectionHeader.tsx`、`Badge.tsx`、`components/index.ts` |
| 任务 3 | `mobile-rn/src/design/patterns/BodyMap.tsx`、`MiniBodyMap.tsx`、`MediaThumb.tsx`、`patterns/index.ts`、`gallery/DesignGallery.tsx` |
| 任务 4 | `mobile-rn/src/design/index.ts`、`mobile-rn/App.tsx`、`mobile-rn/src/ui.tsx`、`mobile-rn/package.json`、`mobile-rn/scripts/check-design-system.mjs`、`AGENTS.md`、`docs/RN_MIGRATION_STATUS.md` |
| 任务 5 | `archive/RN_UI_EXECUTION.md` 的验收记录 |

禁止：

- 修改 `frontend/`、`api/`、`catalogue/`。
- 修改 `mobile-rn/package.json`、`app.json`、`package-lock.json`（任务 4 除外）。
- 修改其他任务名下的文件。
- 运行 `npm install`、Gradle 或启动模拟器（任务 4 之后统一做）。
- 用 `any` 逃避类型；确实需要时在注释里说明原因。

并行期间类型检查可能因为其他任务文件尚不存在而报错。每个子 Agent 只需保证自己的文件内部类型正确；最终由主 Agent 统一跑 `npm run typecheck`。

## 2. 任务 1：Foundation、图标与 Text

### 2.1 `tokens.ts`

实现并导出：

```ts
export const palette = { ... } as const;
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 22, xxxl: 32 } as const;
export const radius = { xs: 7, sm: 8, md: 9, lg: 12, card: 14, xl: 16, xxl: 22, pill: 99 } as const;
export const sizes = {
  icon: 24, tabIcon: 25, buttonIcon: 19,
  tileSm: 29, tileMd: 36, tileLg: 40,
  touch: 44, tabStart: 52, input: 46, button: 46,
  hairline: 0.5,
} as const;
export const motion = {
  fast: 140, med: 220, sheet: 340,
  ease: [0.32, 0.72, 0, 1] as const,
  pressScale: 0.97, pressScaleSmall: 0.92, pressScaleCard: 0.985,
} as const;
export const typography = { ... } as const; // 14 个 variant，见设计文档 5.4
export const shadows = { ... } as const;
export const layout = {
  pagePadding: 16, cardPadding: 16, cardGap: 12, headerBottom: 18,
  sectionGap: 22, listRowPaddingX: 14, listRowPaddingY: 11, listRowMinHeight: 46,
} as const;
```

要求：

- `typography` 每个值包含 `fontSize`、`lineHeight`、`fontWeight`、`letterSpacing`。
- `shadows` 包含 `tabStart`、`segThumb`、`sheet`；`tabStart` 的阴影颜色由组件用当前 accent 覆盖，token 只给几何值。
- 不做主题相关计算；主题在 `themes.ts`。

### 2.2 `color.ts`

```ts
export function alpha(color: string, opacity: number): string;
export function mix(foreground: string, background: string, amount: number): string;
export function contrastRatio(a: string, b: string): number;
export function readableOn(background: string): '#000000' | '#ffffff';
```

要求：

- 支持 `#rgb`、`#rrggbb`、`#rrggbbaa`、`rgb()`、`rgba()` 输入。
- `amount` 钳制 0..1；`alpha` 的 opacity 钳制 0..1。
- `mix` 输出 `#rrggbb`。
- `contrastRatio` 使用 WCAG 相对亮度。
- 非法颜色抛 `Error`，不要静默返回黑色。
- 纯函数，无 React/RN 依赖。

### 2.3 `themes.ts`

```ts
export type ThemeMode = 'dark' | 'light';
export type AccentName = 'green' | 'blue' | 'orange' | 'purple' | 'pink' | 'red' | 'teal' | 'yellow';
export type ThemeColors = { ... };
export type Theme = {
  mode: ThemeMode;
  accent: AccentName;
  colors: ThemeColors;
  space: typeof space;
  radius: typeof radius;
  type: typeof typography;
  motion: typeof motion;
  shadows: typeof shadows;
  sizes: typeof sizes;
  layout: typeof layout;
};
export function createTheme(mode?: ThemeMode, accent?: AccentName): Theme;
export const darkTheme: Theme;
export const lightTheme: Theme;
```

要求：

- 深色/浅色/强调色取值严格按设计文档 5.1–5.3。
- `accentSoft`、`accentLine` 用 `alpha()` 计算。
- 浅色主题的 `accentInk` 按强调色预设选择，深色主题等于 `accent`。
- `onAccent` 按预设选择黑/白。
- `shadow.tabStart` 的 `shadowColor` 用 `accent`，`shadowOpacity` 0.55，y=6，radius=18，elevation=8。
- 不导出可变对象给页面修改；`createTheme` 每次返回新对象。

### 2.4 `ThemeProvider.tsx`

```tsx
export function ThemeProvider(props: {
  children: React.ReactNode;
  mode?: ThemeMode;
  accent?: AccentName;
}): React.ReactElement;

export function useTheme(): Theme;
export function useThemeController(): {
  mode: ThemeMode;
  accent: AccentName;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentName) => void;
};
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: Theme) => T,
): T;
```

要求：

- Provider 内部 `useState` 管理 mode/accent，初始值来自 props；props 变化时同步。
- `theme` 用 `useMemo` 按 mode/accent 创建。
- 无 Provider 时 `useTheme()` 返回 `darkTheme`，`useThemeController()` 返回只读默认值（set 为空操作）或抛出明确错误；优先返回默认值，保证 Gallery 预览和测试不崩。
- `useThemedStyles` 用 `useMemo` 缓存 `StyleSheet.create(factory(theme))`。
- 不引入 Redux/Zustand。

### 2.5 `icons/icon-paths.tsx`

- 从 `frontend/src/components/Icon.jsx` 复制 `P` 对象，共 126 个图标。
- 使用 `react-native-svg` 的 `Path`、`Circle`、`Rect` 组件；不要保留 DOM `<svg>`。
- 保留注释和图标名。
- `grip` 的 `[...].map` 展开为 6 个 `Circle`。
- 导出：

```ts
export const iconPaths: Record<string, React.ReactNode>;
export const ICON_NAMES: string[];
export type IconName = keyof typeof iconPaths; // 或 string union
```

要求：

- 所有 `path d` 字符串与上游完全一致。
- `fill="currentColor"` 改为 `fill="currentColor"`（RN SVG 支持），`stroke="none"` 保留。
- 不添加新图标。
- 文件顶部注释来源：`frontend/src/components/Icon.jsx`。

### 2.6 `icons/Icon.tsx`

```tsx
export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
};
export const Icon: React.MemoExoticComponent<React.FC<IconProps>>;
```

要求：

- 默认 `size=24`、`strokeWidth=1.7`、`color=theme.colors.label`。
- `Svg` 设置 `viewBox="0 0 24 24"`、`fill="none"`、`stroke={color}`、`strokeLinecap="round"`、`strokeLinejoin="round"`、`strokeWidth`。
- 子元素中显式 `fill`/`stroke` 优先，不要被父级覆盖。
- 未知名称返回 `null` 或空 `Svg`，不抛错。
- `accessibilityLabel` 存在时 `accessible`、`accessibilityRole="image"`；否则 `accessible={false}`。
- `style` 应用到 `Svg`。
- 使用 `memo`。

### 2.7 `components/Text.tsx`

```tsx
export type TextVariant = keyof typeof typography;
export type TextTone = 'label' | 'secondary' | 'tertiary' | 'quaternary' | 'accent' | 'danger' | 'onAccent';
export type TextProps = React.ComponentProps<typeof RNText> & {
  variant?: TextVariant; // 默认 body
  tone?: TextTone;       // 默认 label
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
};
export function Text(props: TextProps): React.ReactElement;
```

要求：

- 从 `useTheme()` 取颜色。
- `tone` 映射：label→label、secondary→label2、tertiary→label3、quaternary→label4、accent→accentInk、danger→danger、onAccent→onAccent。
- `style` 最后合并；调用方可以加 margin，但不要改字号。
- 默认 `allowFontScaling` 保持 RN 默认（true）。
- 支持 `numberOfLines`、`ellipsizeMode` 等原生 props。
- 不创建全局 `Text` 覆盖；只用显式组件。

### 2.8 任务 1 验收

- 文件全部存在，导出名与本文一致。
- 图标数量 126；`ICON_NAMES.length === 126`。
- `color.ts` 的 `alpha('#30d158', .16) === 'rgba(48,209,88,0.16)'`。
- `mix('#30d158', '#1c1c1e', .32)` 返回合理的十六进制值。
- 没有从 `react` 以外引入 DOM 包。
- 报告：创建的文件、图标数量、任何与上游的偏差。

## 3. 任务 2：Primitives

所有组件位于 `mobile-rn/src/design/components/`，从 `../tokens`、`../themes`、`../ThemeProvider`、`../icons/Icon`、`./Text` 导入。不要从 `../../ui` 导入。

### 3.1 `PressableScale.tsx`

按设计文档 7.21 实现。

- 使用 `Animated.Value(1)`、`Animated.spring` 或 `Animated.timing`，`useNativeDriver: true`。
- `onPressIn` 缩放到 `scaleTo`，`onPressOut` 回到 1；140ms。
- `disabled` 时不响应，`opacity: 0.42` 可选。
- 支持 `accessibilityRole`、`accessibilityLabel`、`accessibilityState`、`testID`、`hitSlop`。
- 作为其他可点击组件的底层。

### 3.2 `Button.tsx`

按设计文档 7.4 实现。

- 支持 `children`、`icon`、`iconPosition`、`variant`、`size`、`fullWidth`、`loading`、`disabled`。
- md 默认 fullWidth，sm/xs 默认非 fullWidth。
- `primary` 按下背景 `accentPressed`；其他 variant 按下可加 `opacity: .72` 或 `surface3`。
- 加载时显示 `ActivityIndicator size="small"`，颜色 `onAccent`/`accentInk`/`label` 按 variant。
- 文本使用 `Text variant="button"`（sm 用 `subhead`，xs 用 `footnote`），tone 按 variant。
- 图标使用 `Icon`，尺寸 19/16/14。
- 无障碍：`accessibilityRole="button"`，`accessibilityState={{ disabled, busy: loading }}`。

### 3.3 `IconButton.tsx`

按设计文档 7.5 实现。

- 圆形按钮，`size` 36/44，`tone` neutral/accent/danger。
- 图标 20，使用 `Icon`。
- 必须传 `accessibilityLabel`。
- 按下缩放 `pressScaleSmall`。

### 3.4 `Card.tsx`

按设计文档 7.6 实现。

- 默认 `padded`、`gap=10`、`marginBottom=12`。
- 无边框、`surface`、radius 14。
- `onPress` 时使用 `PressableScale`，`scaleTo={theme.motion.pressScaleCard}`。
- `padded={false}` 时不加内边距。

### 3.5 `Screen.tsx`

按设计文档 7.7 实现。

- `SafeAreaView` 来自 `react-native-safe-area-context`，`edges` 默认 `['top','left','right']`。
- `scroll` 默认 true，使用 `ScrollView`，`contentContainerStyle` 合并 `{ padding: 16, paddingBottom: 28 }` 和调用方样式。
- `keyboardShouldPersistTaps="handled"`。
- 非滚动用 `View flex:1`。
- 背景 `theme.colors.bg`。

### 3.6 `Header.tsx`

按设计文档 7.8 实现。

- 左侧可选返回 `IconButton name="chevronLeft"`。
- 标题 `Text variant={compact ? 'title3' : 'pageTitle'}`。
- 副标题 `Text variant="subhead" tone="secondary"`。
- 右侧 `right` 节点。
- 布局：`flexDirection:'row'`、`alignItems:'flex-end'`、`justifyContent:'space-between'`、gap 12、margin 8/0/18。
- 标题列 `flex:1, minWidth:0`，防止右侧按钮被挤出。

### 3.7 `ListRow.tsx`

按设计文档 7.9 实现。

- `PressableScale`，`scaleTo={1}` 或直接用 `Pressable`（列表行用背景填充，不缩放）。
- 按下背景 `surface2`；未按下透明。
- 行内 `leading`、文本列、`trailing`、chevron。
- `title` 使用 `Text variant="body"`，`subtitle` 使用 `Text variant="footnote" tone="secondary"`。
- chevron 使用 `Icon name="chevronRight" size={18} color={theme.colors.label3}`。
- `disabled` 时 `opacity: .45`，不响应。

### 3.8 `IconTile.tsx`

按设计文档 7.3 实现。

- `size` sm/md/lg → 29/36/40。
- `tone` accent/soft/orange/blue/neutral。
- 圆角 7/10/11。
- 图标尺寸：sm 18、md 20、lg 22。
- 无交互，`accessible={false}`。

### 3.9 `Chip.tsx`

按设计文档 7.10 实现。

- `PressableScale`，`scaleTo={pressScale}`。
- `selected` 时背景 accent、文字 onAccent；neutral tone 选中时 `surface3` + label。
- `icon` 显示在文字前，尺寸 14/12。
- `size` md/sm 控制 padding 和字号。
- 无障碍：`accessibilityRole="button"`，`accessibilityState={{ selected, disabled }}`。

### 3.10 `Segmented.tsx`

按设计文档 7.11 实现。

- 泛型 `<T extends string>`。
- 容器 `onLayout` 取宽度；滑块宽度 `(width - 4) / options.length`。
- `Animated.Value` 平移；`Animated.timing` 220ms，`Easing.bezier(0.32, 0.72, 0, 1)`。
- 轨道背景 `rgba(118,118,128,0.24)`；滑块 `#636366`（从 token 取 `surface3` 或 `gray4`）。
- 文字 14/500；未选中 label2/400。
- 支持 `icon`。
- 无障碍：每个选项 `accessibilityRole="button"`，`accessibilityState={{ selected }}`。

### 3.11 `SearchField.tsx`

按设计文档 7.12 实现。

- `TextInput` 不设边框，占满剩余宽度。
- 左侧 `magnifier` 19 label2。
- 有值时右侧清除按钮：`IconButton` 太小会撑高，使用 `Pressable` + `xmark` 16，`hitSlop` 12。
- `resultCount` 显示在清除按钮右侧，`Text variant="footnote" tone="secondary"`。
- `onClear` 存在时点击清除调用；否则调用 `onChangeText('')`。
- 支持 `testID`、`autoFocus`、`returnKeyType`。

### 3.12 `Sheet.tsx`

按设计文档 7.13 实现。

- `Modal` + `Animated`；`visible` 变化时执行进出动画。
- 遮罩 `Pressable` 背景 `overlay`；点击关闭（`dismissible` 时）。
- 面板 `Animated.View`，`translateY` 从 400 到 0；340ms，easing `motion.ease`。
- 顶部 grab、标题、`ScrollView` 内容、`footer`。
- `useSafeAreaInsets().bottom` 加到 panel 底部 padding。
- `KeyboardAvoidingView`：iOS `padding`，Android `height` 或 undefined；键盘弹出时内容可滚。
- Android 返回键 `onRequestClose`。
- 下滑关闭：在 grab/标题区域用 `PanResponder`，dy > 90 或 vy > 0.8 时关闭；不强求复杂手势。
- `testID` 放在面板上。

### 3.13 `TabBar.tsx`

按设计文档 7.14 实现。

- 接受 4 个 tab（左右各两）和中心开始按钮。
- 使用 `useSafeAreaInsets().bottom` 作为底部 padding。
- 背景 `bgEl`，顶部 0.5 `sepOp` 边。
- 中心按钮 52，marginTop -24，`accent`，`play` 26/2，阴影用当前 accent。
- 运行态：背景 `warning`，黑色图标/标签，标签显示 `runningLabel`。
- 非运行态标签：`startLabel` 默认“开始”。
- 布局：`flexDirection:'row'`、`alignItems:'flex-end'`、`justifyContent:'space-around'`。
- 无障碍。

### 3.14 `Divider.tsx` / `SectionHeader.tsx` / `Badge.tsx` / `ProgressBar.tsx` / `StatTile.tsx` / `EmptyState.tsx`

按设计文档 7.15–7.20 实现。要求：

- 颜色全部来自 theme。
- `Badge` 用对应 tone 的浅底/文字。
- `ProgressBar` 宽度用百分比或 flex，`overflow:'hidden'`。
- `StatTile` 组合 `IconTile` + `Text`。
- `EmptyState` 居中，children 操作区。

### 3.15 `components/index.ts`

导出所有组件的类型和值：

```ts
export * from './Text';
export * from './PressableScale';
...
```

### 3.16 任务 2 验收

- 所有文件存在，导出名与本文一致。
- 无原始十六进制颜色（除 `rgba(118,118,128,0.24)`、`#636366` 这类从设计文档明确的常量；优先从 theme 取 `surface3`/`gray4`）。
- 无 `fontSize` 原始数字（使用 `Text` variant 或 `theme.type`）。
- 组件可以被 Gallery 组合。
- 报告：文件列表、导出 API、任何与设计文档的偏差。

## 4. 任务 3：Patterns 与 DesignGallery

### 4.1 `patterns/BodyMap.tsx`

按设计文档 8.1 实现。

- 导入路径：
  - `import bodyPaths from '../../../../frontend/src/lib/body-paths.js';`
  - `import { MUSCLES, INERT, levelsOf } from '../../../../frontend/src/lib/muscles.js';`
- 路径数据可能是 `{ male: { vb, p }, female: { vb, p } }`；先打印/检查结构，再按实际字段渲染。
- 两个 `Svg` 并排，gap 2；每个 `Svg` 的 `width` 按 `vb` 宽高比计算。
- `levels` 优先，否则 `levelsOf(load)`。
- 颜色按设计文档 8.1 的 `mix` 比例。
- `Svg` 的 `stroke` 用 `rgba(0,0,0,0.35)` 或 `theme.colors.surface`，描边宽度：全身 1，迷你 3（按 viewBox 单位）。
- 组件可选 `height`；默认 `Math.min(340, windowHeight * 0.46)`。
- 无路径数据时返回占位高度 `View`，不要崩。
- 类型：`Load = Record<string, number>`。

### 4.2 `patterns/MiniBodyMap.tsx`

按设计文档 8.2 实现。

- 导入 `loadOfRoutine`。
- 计算 `loadOfRoutine({ ex: routines.flatMap(r => r.ex ?? []) })`。
- 无负荷返回 `null`。
- 使用 `BodyMap` 的迷你模式；高度 46。
- 不接受训练状态对象，只接受 routines 数组。

### 4.3 `patterns/MediaThumb.tsx`

按设计文档 8.3 实现。

- 导入 `Image` from `expo-image`。
- 导入 `EXALIAS` from `../../../../frontend/src/lib/exercises-data.js`；`canonicalId = EXALIAS[exerciseId] ?? exerciseId`。
- `server` 为空或加载失败时中性占位。
- `onError` 设置失败状态；`exerciseId`/`server` 变化时重置。
- 圆角、尺寸可配。
- 不打包任何图片。

### 4.4 `gallery/DesignGallery.tsx`

按设计文档 8.4 实现。

- `Screen` + `Header title="设计系统" subtitle="openGym RN · 组件与 token"`。
- 顶部主题控制：两个 `Chip`（深色/浅色）+ 8 个强调色 `Chip`，使用 `useThemeController`。
- 区块标题使用 `SectionHeader`。
- 色板：每个颜色一个 44×44 圆角块 + 名称/值。
- 字体：每个 variant 一行，显示名称、字号、示例文本。
- 图标：`ICON_NAMES.map` 渲染 24px 图标 + 名称，`flexWrap`，每项宽约 72。
- Button：3 个 variant × 3 个 size，加 disabled/loading。
- IconButton：neutral/accent/danger。
- Chip：未选中/选中/icon/sm。
- Segmented：两个选项，本地 state。
- SearchField：本地 state，显示 resultCount。
- Card/ListRow/IconTile/Divider/Badge/SectionHeader：组合展示。
- ProgressBar/StatTile/EmptyState。
- BodyMap：示例 load `{ chest: 12, 'upper-back': 8, quadriceps: 16 }`；MiniBodyMap：示例 routines。
- MediaThumb：无 server 的占位 + 可选的示例 server（默认空）。
- Sheet：按钮打开，内容含标题、Chip 组、底部 Button “完成”。
- TabBar：静态预览，使用 demo tabs（首页/计划/统计/动作库）和 `onSelect` 空操作。
- 所有区块加 `testID`，例如 `gallery-theme-light`、`gallery-sheet-open`、`gallery-body-map`。
- 页面可滚动，底部留 40。

### 4.5 `patterns/index.ts`

导出 `BodyMap`、`MiniBodyMap`、`MediaThumb`。

### 4.6 任务 3 验收

- Gallery 能导入所有基础组件并渲染。
- BodyMap 在示例 load 下显示绿色肌群。
- MiniBodyMap 空数据返回 null。
- MediaThumb 无 server 时显示占位。
- 主题切换按钮能切换 dark/light。
- Sheet 打开/关闭正常。
- 报告：文件列表、示例数据、任何与设计文档的偏差。

## 5. 任务 4：主 Agent 集成

### 5.1 `design/index.ts`

```ts
export * from './tokens';
export * from './color';
export * from './themes';
export * from './ThemeProvider';
export * from './icons/Icon';
export * from './components';
export * from './patterns';
```

注意：`icons/icon-paths.tsx` 不直接导出，避免页面拿到内部节点；只导出 `IconName` 和 `ICON_NAMES`（可从 `Icon.tsx` 重新导出）。

### 5.2 `App.tsx`

- 导入 `ThemeProvider` from `./src/design`。
- 默认导出：
```tsx
<ThemeProvider mode="dark" accent="green">
  <SafeAreaProvider><AppScreen /></SafeAreaProvider>
</ThemeProvider>
```
- 在 `Panel` 联合类型增加 `{ kind: 'design' }`。
- 在“服务器”tab 底部增加 `__DEV__` 卡片：
```tsx
{__DEV__ && <Card>
  <Text style={styles.title}>开发</Text>
  <Button label="设计系统预览" secondary onPress={() => setPanel({ kind: 'design' })} />
</Card>}
```
- Modal 中新增：
```tsx
{panel.kind === 'design' && <DesignGallery onClose={closePanel} />}
```
- `DesignGallery` 需要接收 `onClose`；如果任务 3 的实现没有该 prop，主 Agent 补上或包装。
- 不改训练、历史、同步逻辑。

### 5.3 `src/ui.tsx` 颜色桥接

- 导入 `darkTheme`。
- `color` 映射：
  - background → `darkTheme.colors.bg`
  - panel → `darkTheme.colors.surface`
  - border → `darkTheme.colors.sep`
  - text → `darkTheme.colors.label`
  - muted → `darkTheme.colors.label2`
  - accent → `darkTheme.colors.accent`
  - dark → `darkTheme.colors.onAccent`
  - danger → `darkTheme.colors.danger`
- 样式调整：
  - `card`: 去掉 `borderWidth`/`borderColor`，`borderRadius: 14`。
  - `header`: 去掉 `borderBottom`。
  - `heading`: `fontSize: 30`, `fontWeight: '700'`, `letterSpacing: -0.84`。
  - `title`: `fontWeight: '600'`。
  - `text`: `fontSize: 17`, `lineHeight: 22`。
  - `input`: 背景 `surface2`，无边框，`borderRadius: 12`。
  - `button`: `secondary` 用 `surface2` 背景，去掉边框。
- 不改组件 API，避免旧页面大改。

### 5.4 `scripts/check-design-system.mjs`

- Node ESM（项目 `package.json` 没有 `"type":"module"`，使用 `.mjs`）。
- 读 `frontend/src/components/Icon.jsx`，用正则提取 `^  ([A-Za-z0-9]+):` 的图标名。
- 读 `mobile-rn/src/design/icons/icon-paths.tsx`，提取 `iconPaths` 的键；如果难以解析，改为导入构建后的 `ICON_NAMES` 不可行，则用正则匹配 `^  ([A-Za-z0-9]+):`。
- 比较：上游有、RN 没有 → 报错退出 1；RN 多出 → 警告。
- 扫描 `mobile-rn/src/screens/**`（不存在则跳过）和 `mobile-rn/App.tsx`：十六进制颜色、`fontSize:`。对 `App.tsx` 迁移期白名单，打印警告不退出；screens 存在时退出 1。
- 输出 `design:check OK` 或错误列表。
- 在 `mobile-rn/package.json` 加：
```json
"design:check": "node scripts/check-design-system.mjs"
```

### 5.5 文档与状态

- `AGENTS.md` 文档列表加入：
  - `docs/RN_UI_DESIGN_SYSTEM.md`
  - `archive/RN_UI_EXECUTION.md`
- `AGENTS.md` 代码地图在 `mobile-rn/src/` 后补充 `mobile-rn/src/design/` 的职责。
- `docs/RN_MIGRATION_STATUS.md` 的“工程验收”增加：
  - `[x] 设计系统基础。tokens、主题、图标、基础组件、身体图、动作缩略图、开发画廊和图标检查脚本。`
  - 验收后再写具体日期和 APK/截图记录；如果尚未完成，写“已实现，待验证”。

## 6. 任务 5：构建与模拟器验收

### 6.1 环境

```powershell
$env:JAVA_HOME = 'C:\Users\zjzjn\AppData\Local\RnToolchain\jdk-17.0.21+9'
$env:ANDROID_HOME = 'C:\Users\zjzjn\AppData\Local\RnToolchain\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = 'C:\Users\zjzjn\AppData\Local\RnToolchain\gradle'
$adb = 'C:\Users\zjzjn\AppData\Local\RnToolchain\android-sdk\platform-tools\adb.exe'
& $adb devices
```

必须看到 `emulator-5556 device`。

### 6.2 静态检查

```powershell
cd mobile-rn
npm.cmd run typecheck
npm.cmd run design:check
```

### 6.3 原生构建

新增了 `react-native-svg` 和 `expo-image`，必须重新 prebuild：

```powershell
npx.cmd expo prebuild --platform android --no-install
cd android
.\gradlew.bat :app:assembleDebug
```

如果 Gradle wrapper 下载超时，使用工具链自带的 Gradle 9.0.0 并复用工具链缓存：

```powershell
& 'C:\Users\zjzjn\AppData\Local\RnToolchain\gradle-9.0.0\bin\gradle.bat' :app:assembleDebug --console=plain
```

本机已验证 `GRADLE_USER_HOME=C:\Users\zjzjn\AppData\Local\RnToolchain\gradle` 可以复用此前的 Android/React Native 依赖。

如果 `android/` 已被修改过，prebuild 会覆盖；确认没有本地需要保留的原生改动（当前 `android/` 被 gitignore，属于生成物）。

### 6.4 安装与启动

```powershell
& $adb install -r .\app\build\outputs\apk\debug\app-debug.apk
& $adb reverse tcp:8081 tcp:8081
```

在 `mobile-rn/` 启动 Metro（后台）：

```powershell
npx.cmd expo start --localhost
```

启动 App：

```powershell
& $adb shell am start -n dev.opengym.rn/.MainActivity
```

### 6.5 打开设计画廊

1. 等 App 加载完成。
2. 切到“服务器”tab。
3. 滚动到底部“开发”卡片。
4. 点击“设计系统预览”。
5. 用 `uiautomator dump` 确认 `设计系统` 标题出现。

可用命令：

```powershell
& $adb shell uiautomator dump /sdcard/window.xml
& $adb pull /sdcard/window.xml .\dist\ui\window.xml
Select-String -Path .\dist\ui\window.xml -Pattern '设计系统|设计系统预览|深色|浅色'
```

### 6.6 截图与验证

创建目录 `mobile-rn/dist/ui/`（`dist/` 被 gitignore）。

```powershell
& $adb exec-out screencap -p > .\dist\ui\gallery-dark.png
```

验证项：

- [ ] 设计画廊打开，无红屏/JS 错误。
- [ ] Dark 主题：背景纯黑、卡片 `#1c1c1e`、主色 iOS 绿。
- [ ] Light 主题切换正常，文字对比可读。
- [ ] 126 个图标显示，无空图标/错位。
- [ ] Button 所有 variant/size 正常，按下有缩放。
- [ ] Chip 选中/未选中正常。
- [ ] Segmented 滑块动画正常。
- [ ] SearchField 输入/清除正常。
- [ ] Card/ListRow/IconTile 正常。
- [ ] BodyMap 绿色肌群图正常；MiniBodyMap 正常。
- [ ] MediaThumb 无服务器显示占位。
- [ ] Sheet 打开/关闭、返回键关闭正常。
- [ ] TabBar 五栏 + 中央按钮布局正常。
- [ ] `adb logcat` 无 `ReactNativeJS` 错误。

### 6.7 日志

```powershell
& $adb logcat -d -v brief | Select-String -Pattern 'ReactNativeJS|FATAL EXCEPTION|AndroidRuntime'
```

失败时保留：截图、`window.xml`、相关 logcat、复现步骤。

## 7. 任务 6：文档与迁移清单更新

验收通过后：

- 在本文末尾增加“验收结果”：
  - 日期（当前为 2026-11-17）。
  - 模拟器序列号 `emulator-5556`。
  - 分辨率/密度。
  - 通过的检查项。
  - 截图路径和日志路径（本地 `dist/ui/`，不提交）。
  - 已知问题（例如 Android 彩色阴影、字体差异）。
- `docs/RN_MIGRATION_STATUS.md` 更新为 `[x]` 并写明“已实现，模拟器已验证”。
- 如果构建了可交付 APK，记录 SHA-256；否则写明本轮只做 debug 验证。

## 8. 验收结果（2026-11-17）

- 设备：`emulator-5556`，`sdk_gphone64_x86_64`，Android 16（API 36），1080×2400，密度 420（逻辑约 412×915）。
- 构建：Debug APK `mobile-rn/android/app/build/outputs/apk/debug/app-debug.apk`，约 95 MB；`npm.cmd run typecheck`、`npm.cmd run design:check`、`expo export --platform android` 和 `gradle assembleDebug` 通过。
- 设计画廊：`design-gallery-verify.ps1` 通过。验证 dark/light 切换、色板、字体、126 个图标、按钮、图标按钮、芯片、分段、搜索、卡片与列表行、图标块、进度、统计、空状态、身体肌群图、迷你肌群图、动作缩略图占位、底部弹出层和 TabBar 静态预览。
- 旧界面冒烟：训练、历史、服务器三个 Tab 可切换；训练草稿、历史记录和服务器面板正常渲染。
- 截图：`mobile-rn/dist/ui/gallery-dark.png`、`gallery-light.png`、`gallery-body-map.png`、`gallery-sheet.png`；`dist/` 被 gitignore，只保留在本机。
- 日志：重新启动 App 并跑完整画廊脚本后，`adb logcat` 没有 `ReactNativeJS` 错误、`FATAL EXCEPTION` 或 `AndroidRuntime` 崩溃。
- 已知问题：浅色主题的正文、卡片和控件已切换，但 Android 15/16 边到边模式下状态栏仍保留深色条和浅色图标；不作为本轮验收阻塞项，后续接入原生状态栏 API 时修复。
- 未重跑 P0/P1 全量数据回归；本轮没有改动训练、同步和备份逻辑，旧页面冒烟已通过。真机验收仍待完成。

## 9. 子 Agent 通用规则

每个子 Agent 开始前：

1. 阅读 `docs/RN_UI_DESIGN_SYSTEM.md` 和本文。
2. 阅读自己任务涉及的上游文件。
3. 只修改自己名下的文件。
4. 不运行 `npm install`、Gradle、模拟器。
5. 完成后报告：
   - 创建/修改的文件。
   - 导出的 API。
   - 与文档不一致的地方及原因。
   - 未完成项（如果有）。

代码要求：

- TypeScript 严格类型；避免 `any`。
- 函数组件 + hooks。
- `StyleSheet.create`；颜色从 theme 取。
- 没有 `TODO`、`FIXME`、占位文本。
- 注释只写必要的原因，不写“这是按钮”这类废话。
- 中文 UI 文案与设计文档一致。

## 10. 总验收清单

- [ ] 任务 1 文件齐全，图标 126 个。
- [ ] 任务 2 组件齐全，导出 API 与文档一致。
- [ ] 任务 3 身体图、缩略图、Gallery 齐全。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run design:check` 通过。
- [ ] Debug APK 构建成功。
- [ ] 模拟器打开 Gallery，dark/light/sheet/body map 正常。
- [ ] 旧界面颜色和字体已切换。
- [ ] `docs/RN_MIGRATION_STATUS.md` 已更新。
- [ ] 文档中的路径与代码一致。
