// Living documentation for the RN design system. Open it from the dev card on the
// server tab; every component and token in docs/RN_UI_DESIGN_SYSTEM.md belongs here.

import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Header,
  IconButton,
  IconTile,
  ListRow,
  ProgressBar,
  Screen,
  SearchField,
  SectionHeader,
  Segmented,
  Sheet,
  StatTile,
  Stepper,
  SwitchRow,
  TabBar,
  Text,
  TextField,
} from '../components';
import { ICON_NAMES } from '../icons/Icon';
import { Icon } from '../icons/Icon';
import { ActionSheet, BodyMap, MediaThumb, MiniBodyMap } from '../patterns';
import { useTheme, useThemeController } from '../ThemeProvider';
import { palette, typography } from '../tokens';
import type { AccentName, ThemeMode } from '../themes';

const MODES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

const ACCENTS: AccentName[] = ['green', 'blue', 'orange', 'purple', 'pink', 'red', 'teal', 'yellow'];

const ACCENT_LABELS: Record<AccentName, string> = {
  green: '绿',
  blue: '蓝',
  orange: '橙',
  purple: '紫',
  pink: '粉',
  red: '红',
  teal: '青',
  yellow: '黄',
};

const BUTTON_VARIANTS = ['primary', 'secondary', 'tinted', 'ghost', 'danger'] as const;
const BUTTON_SIZES = ['md', 'sm', 'xs'] as const;
const ICON_TONES = ['accent', 'soft', 'orange', 'blue', 'neutral'] as const;
const TILE_SIZES = ['sm', 'md', 'lg'] as const;
const BADGE_TONES = ['accent', 'neutral', 'orange', 'danger'] as const;

const SAMPLE_LOAD: Record<string, number> = {
  chest: 12,
  'upper-back': 8,
  quadriceps: 16,
};

const SAMPLE_ROUTINES = [
  { ex: [{ id: '0025', sets: 4 }, { id: '0017', sets: 3 }] },
  { ex: [{ id: '3593', sets: 5 }, { id: '0032', sets: 3 }] },
];

const SAMPLE_EXERCISES = ['杠铃卧推', '杠铃深蹲', '硬拉', '引体向上', '杠铃划船', '侧平举'];

// The gallery is not paired with a server, so media thumbnails show their placeholder.
const EXAMPLE_SERVER: string | null = null;

function GallerySection({
  title,
  description,
  testID,
  children,
}: {
  title: string;
  description: string;
  testID: string;
  children: React.ReactNode;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ marginBottom: theme.space.xxl }}>
      <SectionHeader title={title} />
      <Text variant="footnote" tone="secondary" style={{ marginBottom: theme.space.sm }}>
        {description}
      </Text>
      {children}
    </View>
  );
}

function TypographyRows(): React.ReactElement {
  const theme = useTheme();
  const variants = Object.keys(typography) as Array<keyof typeof typography>;
  return (
    <>
      {variants.map(variant => {
        const token = typography[variant];
        return (
          <View key={variant} style={{ marginBottom: theme.space.sm }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.sm }}>
              <Text variant="caption" tone="secondary">
                {variant}
              </Text>
              <Text variant="caption2" tone="tertiary">
                {`${token.fontSize}/${token.lineHeight} · ${String(token.fontWeight)} · ${token.letterSpacing}`}
              </Text>
            </View>
            <Text variant={variant} numberOfLines={1} style={{ marginTop: theme.space.xxs }}>
              训练计划 Aa 0123
            </Text>
          </View>
        );
      })}
    </>
  );
}

export type DesignGalleryProps = {
  onClose?: () => void;
};

export function DesignGallery({ onClose }: DesignGalleryProps): React.ReactElement {
  const theme = useTheme();
  const { mode, accent, setMode, setAccent } = useThemeController();
  const [range, setRange] = useState('week');
  const [search, setSearch] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [serverAddress, setServerAddress] = useState('');
  const [restAlerts, setRestAlerts] = useState(true);
  const [weight, setWeight] = useState('82.5');
  const [effort, setEffort] = useState('');
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [lastAction, setLastAction] = useState('未选择');

  const styles = useMemo(
    () =>
      StyleSheet.create({
        sectionRow: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: theme.space.sm,
        },
        sectionRowTop: {
          marginTop: theme.space.sm,
        },
        swatchGrid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: theme.space.sm,
        },
        swatchItem: {
          width: theme.sizes.touch + theme.space.xxxl,
          alignItems: 'center',
          gap: theme.space.xxs,
        },
        swatch: {
          width: theme.sizes.touch,
          height: theme.sizes.touch,
          borderRadius: theme.radius.lg,
          borderWidth: theme.sizes.hairline,
          borderColor: theme.colors.sep,
        },
        iconGrid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
        },
        iconItem: {
          width: theme.sizes.touch + theme.space.xxxl,
          alignItems: 'center',
          paddingVertical: theme.space.sm,
          gap: theme.space.xxs,
        },
        buttonRow: {
          marginBottom: theme.space.sm,
        },
        mediaItem: {
          alignItems: 'center',
          gap: theme.space.xs,
        },
        tabBarPreview: {
          paddingTop: theme.space.xxl,
        },
        tabBarCard: {
          overflow: 'visible',
          marginBottom: 0,
        },
        miniEmptyRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.sm,
          padding: theme.space.lg,
        },
        searchResults: {
          marginTop: theme.space.sm,
        },
        formStack: {
          gap: theme.space.md,
        },
        stepperStack: {
          gap: theme.space.sm,
        },
        sheetText: {
          marginBottom: theme.space.md,
        },
        content: {
          paddingBottom: theme.space.xxxl + theme.space.sm,
        },
      }),
    [theme],
  );

  const query = search.trim().toLowerCase();
  const searchResults = query
    ? SAMPLE_EXERCISES.filter(name => name.toLowerCase().includes(query))
    : SAMPLE_EXERCISES;

  return (
    <Screen scroll contentContainerStyle={styles.content} testID="design-gallery">
      <Header
        title="设计系统"
        subtitle="openGym RN · 组件与 token"
        right={
          onClose ? (
            <IconButton
              name="xmark"
              tone="neutral"
              accessibilityLabel="关闭设计系统"
              onPress={onClose}
              testID="gallery-close"
            />
          ) : undefined
        }
      />

      <GallerySection
        title="主题"
        description="切换深浅模式与强调色。所有组件都从这里读取语义颜色。"
        testID="gallery-theme"
      >
        <View style={styles.sectionRow}>
          {MODES.map(item => (
            <Chip
              key={item.value}
              selected={mode === item.value}
              onPress={() => setMode(item.value)}
              testID={`gallery-theme-${item.value}`}
            >
              {item.label}
            </Chip>
          ))}
        </View>
        <View style={[styles.sectionRow, styles.sectionRowTop]}>
          {ACCENTS.map(item => (
            <Chip
              key={item}
              selected={accent === item}
              onPress={() => setAccent(item)}
              testID={`gallery-accent-${item}`}
            >
              {ACCENT_LABELS[item]}
            </Chip>
          ))}
        </View>
      </GallerySection>

      <GallerySection
        title="色板"
        description="上游原始色板与当前主题的语义颜色。十六进制值只作为文档字符串展示。"
        testID="gallery-palette"
      >
        <View style={styles.swatchGrid}>
          {Object.entries(palette).map(([name, value]) => (
            <View key={name} style={styles.swatchItem}>
              <View style={[styles.swatch, { backgroundColor: value }]} />
              <Text variant="caption2" numberOfLines={1}>
                {name}
              </Text>
              <Text variant="caption2" tone="tertiary" numberOfLines={1}>
                {value}
              </Text>
            </View>
          ))}
        </View>
        <View style={[styles.swatchGrid, styles.sectionRowTop]}>
          {Object.entries(theme.colors).map(([name, value]) => (
            <View key={name} style={styles.swatchItem}>
              <View style={[styles.swatch, { backgroundColor: value }]} />
              <Text variant="caption2" numberOfLines={1}>
                {name}
              </Text>
              <Text variant="caption2" tone="tertiary" numberOfLines={1}>
                {value}
              </Text>
            </View>
          ))}
        </View>
      </GallerySection>

      <GallerySection
        title="字体"
        description="14 个语义字号；示例文字直接使用对应 variant。"
        testID="gallery-typography"
      >
        <TypographyRows />
      </GallerySection>

      <GallerySection
        title={`图标（${ICON_NAMES.length}）`}
        description="与上游 Icon.jsx 保持同名，24×24 描边。"
        testID="gallery-icons"
      >
        <View style={styles.iconGrid}>
          {ICON_NAMES.map(name => (
            <View key={name} style={styles.iconItem} testID={`gallery-icon-${name}`}>
              <Icon name={name} size={theme.sizes.icon} color={theme.colors.label2} />
              <Text variant="caption2" tone="tertiary" numberOfLines={1}>
                {name}
              </Text>
            </View>
          ))}
        </View>
      </GallerySection>

      <GallerySection
        title="按钮"
        description="5 个 variant × 3 个 size，外加禁用与加载状态。"
        testID="gallery-buttons"
      >
        {BUTTON_VARIANTS.map(variant => (
          <View key={variant} style={[styles.sectionRow, styles.buttonRow]}>
            {BUTTON_SIZES.map(size => (
              <Button
                key={`${variant}-${size}`}
                variant={variant}
                size={size}
                fullWidth={false}
                icon="play"
                testID={`gallery-button-${variant}-${size}`}
              >
                {`${variant} · ${size}`}
              </Button>
            ))}
          </View>
        ))}
        <View style={styles.sectionRow}>
          <Button variant="primary" size="sm" disabled fullWidth={false}>
            禁用
          </Button>
          <Button variant="secondary" size="sm" loading fullWidth={false}>
            加载中
          </Button>
          <Button variant="danger" size="sm" icon="trash" fullWidth={false}>
            删除
          </Button>
        </View>
      </GallerySection>

      <GallerySection
        title="图标按钮"
        description="圆形按钮提供 neutral、accent、danger 三种语气。"
        testID="gallery-icon-buttons"
      >
        <View style={styles.sectionRow}>
          <IconButton name="gear" accessibilityLabel="设置" onPress={() => {}} />
          <IconButton name="play" tone="accent" accessibilityLabel="开始" onPress={() => {}} />
          <IconButton name="trash" tone="danger" accessibilityLabel="删除" onPress={() => {}} />
          <IconButton name="share" size="sm" accessibilityLabel="分享" onPress={() => {}} />
        </View>
      </GallerySection>

      <GallerySection
        title="芯片"
        description="筛选与多选；neutral 选中态用于动作库筛选，避免耗尽强调色。"
        testID="gallery-chips"
      >
        <View style={styles.sectionRow}>
          <Chip onPress={() => {}}>全部</Chip>
          <Chip selected onPress={() => {}}>
            胸
          </Chip>
          <Chip selected tone="neutral" onPress={() => {}}>
            背
          </Chip>
          <Chip icon="plus" size="sm" onPress={() => {}}>
            添加
          </Chip>
          <Chip disabled>不可用</Chip>
        </View>
      </GallerySection>

      <GallerySection
        title="分段控件"
        description="滑块 220ms 平移；以下是本地状态演示。"
        testID="gallery-segmented"
      >
        <Segmented
          options={[
            { value: 'week', label: '本周' },
            { value: 'month', label: '本月' },
          ]}
          value={range}
          onChange={setRange}
          testID="gallery-segmented-control"
        />
      </GallerySection>

      <GallerySection
        title="搜索"
        description="输入时过滤示例动作，右侧显示结果数量。"
        testID="gallery-search"
      >
        <SearchField
          value={search}
          onChangeText={setSearch}
          placeholder="搜索动作"
          resultCount={searchResults.length}
          testID="gallery-search-field"
        />
        <View style={styles.searchResults}>
          <Text variant="footnote" tone="secondary">
            {searchResults.length ? searchResults.join(' · ') : '没有匹配的动作'}
          </Text>
        </View>
      </GallerySection>

      <GallerySection
        title="文本输入"
        description="标签 + 输入框；错误文字优先于帮助文字。默认用标签作为 accessibilityLabel。"
        testID="gallery-text-field"
      >
        <View style={styles.formStack}>
          <TextField
            autoCapitalize="none"
            autoCorrect={false}
            helper="局域网练习服务器建议使用 http，配对码一次有效。"
            keyboardType="url"
            label="服务器地址"
            onChangeText={setServerAddress}
            placeholder="http://192.168.1.10:3000"
            testID="gallery-text-field-input"
            value={serverAddress}
          />
          <TextField
            defaultValue="7X4K-92"
            error="配对码无效或已过期"
            keyboardType="number-pad"
            label="配对码"
            testID="gallery-text-field-error"
          />
        </View>
      </GallerySection>

      <GallerySection
        title="开关行"
        description="ListRow 文字 + 原生 Switch；开启为强调色，关闭为 surface3。"
        testID="gallery-switch-row"
      >
        <Card padded={false}>
          <SwitchRow
            title="组间休息提醒"
            subtitle="休息结束时发送通知"
            value={restAlerts}
            onValueChange={setRestAlerts}
          />
          <Divider inset={theme.layout.listRowPaddingX} />
          <SwitchRow
            title="自动同步"
            subtitle="不可用时显示禁用态"
            value={false}
            onValueChange={() => {}}
            disabled
          />
        </Card>
      </GallerySection>

      <GallerySection
        title="步进器"
        description="左减右加、中间可直接输入；输入过程保留原始字符串，只有按钮解析和格式化。空评分首次点 + 从 6 开始。"
        testID="gallery-stepper"
      >
        <Card>
          <View style={styles.stepperStack}>
            <Stepper
              accessibilityLabel="重量"
              value={weight}
              onChangeText={setWeight}
              step={2.5}
              min={0}
              precision={1}
              unit="kg"
            />
            <Stepper
              accessibilityLabel="次数"
              value="8"
              onChangeText={() => {}}
              step={1}
              min={1}
              max={100}
              keyboardType="number-pad"
              unit="次"
            />
            <Stepper
              accessibilityLabel="休息秒数"
              value="90"
              onChangeText={() => {}}
              step={5}
              min={0}
              keyboardType="number-pad"
              unit="秒"
            />
            <Stepper
              accessibilityLabel="评分（空）"
              emptyValue={6}
              value={effort}
              onChangeText={setEffort}
              step={0.5}
              min={0}
              max={10}
              precision={1}
              unit="RPE"
            />
          </View>
        </Card>
      </GallerySection>

      <GallerySection
        title="操作菜单"
        description="Sheet + ListRow 操作项；选择后先关闭 Sheet，再执行动作。"
        testID="gallery-action-sheet"
      >
        <Button
          variant="secondary"
          icon="more"
          onPress={() => setActionSheetOpen(true)}
          testID="gallery-action-sheet-open"
        >
          打开操作菜单
        </Button>
        <Text variant="footnote" tone="secondary" style={styles.searchResults}>
          {`最近操作：${lastAction}`}
        </Text>
      </GallerySection>

      <GallerySection
        title="卡片与列表"
        description="Card、ListRow、Divider、Badge、SectionHeader 的标准组合。"
        testID="gallery-card"
      >
        <Card>
          <Text variant="headline">今日训练</Text>
          <Text variant="footnote" tone="secondary">
            推举日 · 6 个动作 · 约 55 分钟
          </Text>
        </Card>
        <Card padded={false}>
          <ListRow
            leading={<IconTile name="dumbbell" tone="soft" />}
            title="杠铃卧推"
            subtitle="胸 · 4 组 × 8 次"
            trailing={<Badge tone="accent">主项</Badge>}
            onPress={() => {}}
            chevron
            testID="gallery-list-row"
          />
          <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
          <ListRow
            leading={<IconTile name="calendar" tone="neutral" />}
            title="明日休息"
            subtitle="恢复日"
            disabled
          />
        </Card>
        <Card>
          <SectionHeader
            title="本周概览"
            action={
              <Button variant="ghost" size="xs">
                查看全部
              </Button>
            }
          />
          <Text variant="subhead" tone="secondary">
            右侧操作使用 ghost xs 按钮。
          </Text>
        </Card>
      </GallerySection>

      <GallerySection
        title="图标块与徽标"
        description="5 种语气、3 种尺寸，以及 4 种徽标颜色。"
        testID="gallery-icon-tile"
      >
        <View style={styles.sectionRow}>
          {ICON_TONES.map(tone => (
            <IconTile key={tone} name="dumbbell" tone={tone} />
          ))}
        </View>
        <View style={[styles.sectionRow, styles.sectionRowTop]}>
          {TILE_SIZES.map(size => (
            <IconTile key={size} name="dumbbell" size={size} tone="soft" />
          ))}
        </View>
        <View style={[styles.sectionRow, styles.sectionRowTop]}>
          {BADGE_TONES.map(tone => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </View>
      </GallerySection>

      <GallerySection
        title="进度、统计与空状态"
        description="ProgressBar 宽度钳制在 0..1；StatTile 组合图标块与文字。"
        testID="gallery-progress"
      >
        <Card>
          <Text variant="headline">本周完成度</Text>
          <ProgressBar value={0.65} />
          <Text variant="footnote" tone="secondary">
            已完成 13 / 20 组
          </Text>
        </Card>
        <Card>
          <StatTile icon="dumbbell" tone="accent" label="本周训练" value="4 次" detail="目标 5 次" />
          <Divider />
          <StatTile icon="flame" tone="orange" label="连续训练" value="6 天" detail="个人最佳 9 天" />
        </Card>
        <Card padded={false}>
          <EmptyState
            icon="calendar"
            title="本周还没有训练"
            text="开始一次训练后，这里会显示你的进度。"
          >
            <Button variant="tinted" size="sm" icon="plus" fullWidth={false}>
              新建计划
            </Button>
          </EmptyState>
        </Card>
      </GallerySection>

      <GallerySection
        title="肌群图"
        description="使用上游 body-paths 与 muscles.js；示例负荷为胸 12、上背 8、股四头肌 16 组。"
        testID="gallery-body-maps"
      >
        <Card>
          <View testID="gallery-body-map">
            <BodyMap load={SAMPLE_LOAD} body="male" height={260} />
          </View>
        </Card>
        <Card padded={false}>
          <ListRow
            leading={
              <View testID="gallery-mini-body-map">
                <MiniBodyMap routines={SAMPLE_ROUTINES} />
              </View>
            }
            title="上肢推 + 下肢"
            subtitle="计划缩略肌群图"
            trailing={<Badge tone="neutral">2 个计划</Badge>}
          />
          <Divider inset={theme.layout.listRowPaddingX} />
          <View style={styles.miniEmptyRow}>
            <MiniBodyMap routines={[]} />
            <Text variant="footnote" tone="secondary">
              空计划不渲染肌群图。
            </Text>
          </View>
        </Card>
      </GallerySection>

      <GallerySection
        title="动作缩略图"
        description="静图由配对服务器提供并按 memory-disk 缓存；未配对或加载失败时显示中性占位。"
        testID="gallery-media"
      >
        <Card>
          <View style={styles.sectionRow}>
            <View style={styles.mediaItem}>
              <MediaThumb exerciseId="0025" server={EXAMPLE_SERVER} testID="gallery-media-thumb" />
              <Text variant="caption2" tone="secondary">
                默认 56
              </Text>
            </View>
            <View style={styles.mediaItem}>
              <MediaThumb
                exerciseId="2261"
                server={EXAMPLE_SERVER}
                size={72}
                radius={theme.radius.card}
              />
              <Text variant="caption2" tone="secondary">
                别名 72
              </Text>
            </View>
          </View>
        </Card>
      </GallerySection>

      <GallerySection
        title="底部弹出层"
        description="340ms 进出动画，支持下滑和 Android 返回键关闭。"
        testID="gallery-sheet-demo"
      >
        <Button
          variant="secondary"
          icon="list"
          onPress={() => setSheetOpen(true)}
          testID="gallery-sheet-open"
        >
          打开底部弹出层
        </Button>
      </GallerySection>

      <GallerySection
        title="TabBar 静态预览"
        description="四个常规 Tab 与中央开始按钮；预览不导航。"
        testID="gallery-tabbar"
      >
        <View style={styles.tabBarPreview}>
          <Card padded={false} style={styles.tabBarCard}>
            <TabBar
              tabs={[
                { key: 'home', label: '首页', icon: 'house' },
                { key: 'plan', label: '计划', icon: 'calendar' },
                { key: 'stats', label: '统计', icon: 'chart' },
                { key: 'library', label: '动作库', icon: 'list' },
              ]}
              active="plan"
              onSelect={() => {}}
              onStart={() => {}}
            />
          </Card>
        </View>
      </GallerySection>

      <Sheet
        visible={sheetOpen}
        title="筛选动作"
        onClose={() => setSheetOpen(false)}
        footer={
          <Button onPress={() => setSheetOpen(false)} testID="gallery-sheet-done" variant="primary">
            完成
          </Button>
        }
        testID="gallery-sheet"
      >
        <Text variant="body" style={styles.sheetText}>
          Sheet 用于筛选、详情与确认操作。内容区可滚动，底部操作固定。
        </Text>
        <View style={styles.sectionRow}>
          <Chip selected onPress={() => {}}>
            胸
          </Chip>
          <Chip onPress={() => {}}>背</Chip>
          <Chip onPress={() => {}}>腿</Chip>
          <Chip icon="plus" size="sm" onPress={() => {}}>
            更多
          </Chip>
        </View>
      </Sheet>

      <ActionSheet
        visible={actionSheetOpen}
        title="计划操作"
        items={[
          {
            label: '开始训练',
            icon: 'play',
            tone: 'accent',
            onPress: () => setLastAction('开始训练'),
          },
          { label: '编辑计划', icon: 'pencil', onPress: () => setLastAction('编辑计划') },
          {
            label: '删除计划',
            icon: 'trash',
            tone: 'danger',
            onPress: () => setLastAction('删除计划'),
          },
        ]}
        onClose={() => setActionSheetOpen(false)}
      />
    </Screen>
  );
}
