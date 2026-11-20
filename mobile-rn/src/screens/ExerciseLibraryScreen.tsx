import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { isFav } from '../../../frontend/src/lib/favourites.js';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Header,
  IconButton,
  IconTile,
  ListRow,
  MediaThumb,
  Screen,
  SearchField,
  SectionHeader,
  Sheet,
  TextField,
  useTheme,
} from '../design';
import {
  BODY_PARTS,
  CATALOGUE_COUNT,
  EQUIPMENT,
  SEARCH_LIMIT,
  TARGET_MUSCLES,
  bodyPartName,
  catalogueExercise,
  equipmentName,
  targetMuscleName,
} from '../catalogue';
import { createFuseSuggestionIndex } from '../fuseSuggestionIndex';
import { createLibrarySearch } from '../librarySearch';
import type { LibraryExercise } from '../librarySearch';
import type { Connection } from '../server';
import type { CustomExercise, Profile, RoutineExercise } from '../training';
import { ExerciseDetailScreen } from './ExerciseDetailScreen';

export type ExerciseLibraryScreenProps = {
  profile: Profile;
  server: string | null;
  connection?: Connection | null;
  onPick: (exercise: RoutineExercise) => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void;
  onFavorite: (id: string, favourite: boolean) => void;
  /** Shown as a back button when the library is used as a full-screen picker. */
  onBack?: () => void;
  /** Rows open details and only the plus or detail button replaces the workout exercise. */
  replacing?: boolean;
  /** Lets the host close the detail layer before the picker itself. */
  registerClose?: (close: (() => void) | null) => void;
};

type CatalogueExercise = {
  id: string;
  name: string;
  bodyPart: string;
  equipment: string;
  cardio: boolean;
};

type Row =
  | { kind: 'custom'; exercise: CustomExercise }
  | { kind: 'catalogue'; exercise: CatalogueExercise };

function rowOf(item: LibraryExercise): Row | null {
  if (item.custom) {
    return item.customExercise ? { kind: 'custom', exercise: item.customExercise } : null;
  }
  return {
    kind: 'catalogue',
    exercise: {
      id: item.id,
      name: item.name,
      bodyPart: item.bodyPart,
      equipment: item.equipment,
      cardio: item.cardio,
    },
  };
}

function subtitleOf(bodyPart?: string, equipment?: string) {
  const parts: string[] = [];
  if (bodyPart) parts.push(bodyPartName(bodyPart));
  if (equipment) parts.push(equipmentName(equipment));
  return parts.length > 0 ? parts.join(' · ') : '自建动作';
}

function customName(exercise: CustomExercise) {
  return exercise.n ?? exercise.name ?? exercise.id;
}

export function ExerciseLibraryScreen({
  profile,
  server,
  connection = null,
  onPick,
  onCustom,
  onFavorite,
  onBack,
  replacing = false,
  registerClose,
}: ExerciseLibraryScreenProps) {
  const theme = useTheme();
  const submittedRef = useRef(false);
  const [query, setQuery] = useState('');
  const [bodyPart, setBodyPart] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<string | null>(null);
  const [targetMuscle, setTargetMuscle] = useState<string | null>(null);
  const [oneLimb, setOneLimb] = useState(false);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [limit, setLimit] = useState(SEARCH_LIMIT);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editing, setEditing] = useState<CustomExercise | null>(null);
  const [customNameValue, setCustomNameValue] = useState('');
  const [detail, setDetail] = useState<{ id: string; custom: boolean } | null>(null);

  const term = query.trim();
  const favouriteCount = Array.isArray(profile.favEx) ? profile.favEx.length : 0;
  const workspaceKey = connection ? `${connection.server}|${connection.user.id}` : 'practice';

  // A new search, filter or workspace starts the visible selection fresh; media
  // from the previous account/server must never stay on screen.
  useEffect(() => {
    setLimit(SEARCH_LIMIT);
    setDetail(null);
  }, [query, bodyPart, equipment, targetMuscle, oneLimb, favouritesOnly]);

  useEffect(() => {
    setDetail(null);
    setFiltersOpen(false);
    setEditing(null);
    setCustomNameValue('');
    setQuery('');
    setBodyPart(null);
    setEquipment(null);
    setTargetMuscle(null);
    setOneLimb(false);
    setFavouritesOnly(false);
  }, [workspaceKey]);

  // The picker sits in an app-level Modal, whose back handling must close the
  // detail layer first instead of dismissing the whole picker.
  useEffect(() => {
    if (!registerClose || !replacing || !detail) return;
    registerClose(() => setDetail(null));
    return () => registerClose(null);
  }, [detail, registerClose, replacing]);

  const librarySearch = useMemo(
    () => createLibrarySearch(profile, createFuseSuggestionIndex),
    [profile],
  );
  const result = useMemo(
    () => librarySearch.search(query, {
      bodyPart,
      equipment,
      targetMuscle,
      oneLimb,
      favouritesOnly,
    }, limit),
    [librarySearch, query, bodyPart, equipment, targetMuscle, oneLimb, favouritesOnly, limit],
  );

  const rows = useMemo<Row[]>(
    () => result.items.map(rowOf).filter((row): row is Row => row !== null),
    [result.items],
  );
  const suggestionRows = useMemo<Row[]>(
    () => result.suggestions.map(rowOf).filter((row): row is Row => row !== null),
    [result.suggestions],
  );

  const narrowed = term !== '' || bodyPart !== null || equipment !== null
    || targetMuscle !== null || oneLimb || favouritesOnly;
  const activeFilters = (bodyPart ? 1 : 0) + (equipment ? 1 : 0)
    + (targetMuscle ? 1 : 0) + (oneLimb ? 1 : 0) + (favouritesOnly ? 1 : 0);
  const total = result.total;
  const subtitle = `${CATALOGUE_COUNT} 个动画动作 + ${(profile.customEx ?? []).filter(Boolean).length} 个自建`;
  const noFavourites = favouritesOnly && favouriteCount === 0;

  const clearFilters = () => {
    setQuery('');
    setBodyPart(null);
    setEquipment(null);
    setTargetMuscle(null);
    setOneLimb(false);
    setFavouritesOnly(false);
  };

  // The filter sheet clears the chips only; the search text lives outside it.
  const clearFilterChips = () => {
    setBodyPart(null);
    setEquipment(null);
    setTargetMuscle(null);
    setOneLimb(false);
    setFavouritesOnly(false);
  };

  const pickCatalogue = (exercise: CatalogueExercise) => {
    onPick({ id: exercise.id, mode: exercise.cardio ? 'cardio' : 'reps' });
  };

  const pickCustom = (exercise: CustomExercise) => {
    onPick({ id: exercise.id, mode: exercise.bp === 'cardio' ? 'cardio' : 'reps' });
  };

  // The row plus and the detail button share one submission per picker session.
  const submitPick = (id: string, custom: boolean) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const customExercise = custom
      ? (profile.customEx ?? []).find(exercise => exercise?.id === id)
      : undefined;
    const cardio = custom ? customExercise?.bp === 'cardio' : catalogueExercise(id)?.bp === 'cardio';
    onPick({ id, mode: cardio ? 'cardio' : 'reps' });
  };

  const startEdit = (exercise?: CustomExercise) => {
    setEditing(exercise ?? { id: '', bp: 'full body', eq: 'other' });
    setCustomNameValue(exercise ? customName(exercise) : '');
  };

  const closeEdit = () => {
    setEditing(null);
    setCustomNameValue('');
  };

  const saveCustom = () => {
    if (!editing) return;
    const name = customNameValue.trim();
    if (!name) return;
    onCustom({ ...editing, id: editing.id || `custom-${randomUUID()}`, n: name }, !editing.id);
    closeEdit();
  };

  function rowView(item: Row) {
    const exercise = item.exercise;
    const name = item.kind === 'custom' ? customName(item.exercise) : item.exercise.name;
    const favourite = isFav(profile, exercise.id) as boolean;
    const actions = (
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
        <IconButton
          accessibilityLabel={favourite ? `取消收藏 ${name}` : `收藏 ${name}`}
          name={favourite ? 'starFill' : 'star'}
          onPress={() => onFavorite(exercise.id, !favourite)}
          size="sm"
          testID={`library-fav-${exercise.id}`}
          tone={favourite ? 'accent' : 'neutral'}
        />
        {replacing ? (
          <IconButton
            accessibilityLabel={`选择替换动作 ${name}`}
            name="plus"
            onPress={() => submitPick(exercise.id, item.kind === 'custom')}
            size="sm"
          />
        ) : (
          <>
            <IconButton
              accessibilityLabel={`查看详情 ${name}`}
              name="info"
              onPress={() => setDetail({ id: exercise.id, custom: item.kind === 'custom' })}
              size="sm"
              testID={`library-detail-${exercise.id}`}
            />
            {item.kind === 'custom' ? (
              <IconButton
                accessibilityLabel={`编辑 ${name}`}
                name="pencil"
                onPress={() => startEdit(item.exercise)}
                size="sm"
              />
            ) : (
              <IconButton
                accessibilityLabel={`选择 ${name}`}
                name="plus"
                onPress={() => pickCatalogue(item.exercise)}
                size="sm"
              />
            )}
          </>
        )}
      </View>
    );

    if (item.kind === 'custom') {
      const custom = item.exercise;
      return (
        <Card padded={false}>
          <ListRow
            {...(replacing
              ? {
                accessibilityLabel: `查看详情 ${name}`,
                onPressBody: () => setDetail({ id: custom.id, custom: true }),
              }
              : {
                accessibilityLabel: `选择 ${name}`,
                onPress: () => pickCustom(custom),
              })}
            leading={<MediaThumb exerciseId={custom.id} server={null} size={44} radius={theme.radius.lg} />}
            subtitle={subtitleOf(custom.bp, custom.eq)}
            testID={`library-ex-${custom.id}`}
            title={name}
            trailing={actions}
          />
        </Card>
      );
    }

    const builtin = item.exercise;
    return (
      <Card padded={false}>
        <ListRow
          {...(replacing
            ? {
              accessibilityLabel: `查看详情 ${name}`,
              onPressBody: () => setDetail({ id: builtin.id, custom: false }),
            }
            : {
              accessibilityLabel: `选择 ${name}`,
              onPress: () => pickCatalogue(builtin),
            })}
          leading={<MediaThumb exerciseId={builtin.id} server={server} size={44} radius={theme.radius.lg} />}
          subtitle={subtitleOf(builtin.bodyPart, builtin.equipment)}
          testID={`library-ex-${builtin.id}`}
          title={name}
          trailing={actions}
        />
      </Card>
    );
  }

  const listHeader = (
    <View>
      <Header
        onBack={onBack}
        title="动作库"
        subtitle={subtitle}
        right={(
          <IconButton
            accessibilityLabel={activeFilters > 0 ? `筛选（已选 ${activeFilters} 项）` : '筛选'}
            name="funnel"
            onPress={() => setFiltersOpen(true)}
            tone={activeFilters > 0 ? 'accent' : 'neutral'}
          />
        )}
      />

      <SearchField
        onChangeText={setQuery}
        placeholder="搜索动作"
        resultCount={narrowed ? total : undefined}
        testID="library-search"
        value={query}
      />

      <ScrollView
        contentContainerStyle={{ gap: theme.space.sm, paddingRight: theme.space.lg }}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: theme.space.md, marginBottom: theme.space.md }}
      >
        <Chip
          onPress={() => setBodyPart(null)}
          selected={bodyPart === null}
          tone="neutral"
        >
          全部
        </Chip>
        <Chip
          icon={favouritesOnly ? 'starFill' : 'star'}
          onPress={() => setFavouritesOnly(value => !value)}
          selected={favouritesOnly}
          testID="library-favourites-only"
          tone="neutral"
        >
          仅收藏
        </Chip>
        {BODY_PARTS.map(part => (
          <Chip
            key={part}
            onPress={() => setBodyPart(bodyPart === part ? null : part)}
            selected={bodyPart === part}
            tone="neutral"
          >
            {bodyPartName(part)}
          </Chip>
        ))}
        {equipment ? (
          <Chip icon="xmark" onPress={() => setEquipment(null)} selected tone="neutral">
            {equipmentName(equipment)}
          </Chip>
        ) : null}
        {targetMuscle ? (
          <Chip
            icon="xmark"
            onPress={() => setTargetMuscle(null)}
            selected
            testID="library-target-active"
            tone="neutral"
          >
            {targetMuscleName(targetMuscle)}
          </Chip>
        ) : null}
        {oneLimb ? (
          <Chip
            icon="xmark"
            onPress={() => setOneLimb(false)}
            selected
            testID="library-one-limb-active"
            tone="neutral"
          >
            仅单侧
          </Chip>
        ) : null}
      </ScrollView>

      <Card padded={false}>
        <ListRow
          chevron
          leading={<IconTile name="plusCircle" size="md" tone="soft" />}
          onPress={() => startEdit()}
          subtitle="名称 + 部位，稍后还能改"
          testID="library-custom"
          title="创建自定义动作"
        />
      </Card>
    </View>
  );

  if (detail && !replacing) {
    const customExercise = detail.custom
      ? (profile.customEx ?? []).find(exercise => exercise?.id === detail.id)
      : undefined;
    const cardio = detail.custom
      ? customExercise?.bp === 'cardio'
      : catalogueExercise(detail.id)?.bp === 'cardio';
    return (
      <ExerciseDetailScreen
        key={`${detail.custom ? 'custom' : 'catalogue'}-${detail.id}`}
        connection={connection}
        custom={detail.custom}
        exerciseId={detail.id}
        onBack={() => setDetail(null)}
        onFavorite={onFavorite}
        onPick={() => {
          onPick({ id: detail.id, mode: cardio ? 'cardio' : 'reps' });
          setDetail(null);
        }}
        profile={profile}
        server={server}
      />
    );
  }

  const library = (
    <Screen scroll={false} testID="library-screen">
      <FlatList
        contentContainerStyle={{ padding: theme.layout.pagePadding, paddingBottom: theme.layout.listBottomPadding }}
        data={rows}
        initialNumToRender={12}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={item => `${item.kind}-${item.exercise.id}`}
        ListEmptyComponent={(
          <View>
            <EmptyState
              icon={noFavourites ? 'star' : 'magnifier'}
              text={noFavourites
                ? '点动作右侧的星标收藏动作，之后可以在这里快速找到。'
                : '换个关键词，或者清除筛选后再试。'}
              title={noFavourites ? '还没有收藏的动作' : '没有匹配的动作'}
            >
              {narrowed ? (
                <Button onPress={clearFilters} variant="secondary">
                  清除筛选
                </Button>
              ) : null}
            </EmptyState>
            {suggestionRows.length > 0 ? (
              <View style={{ gap: theme.space.sm, marginTop: theme.space.lg }}>
                <SectionHeader title="你可能在找" />
                {suggestionRows.map(row => (
                  <View key={`${row.kind}-${row.exercise.id}`}>{rowView(row)}</View>
                ))}
              </View>
            ) : null}
          </View>
        )}
        ListFooterComponent={result.items.length < result.total ? (
          <Button
            onPress={() => setLimit(value => value + SEARCH_LIMIT)}
            variant="secondary"
          >
            显示更多
          </Button>
        ) : null}
        ListHeaderComponent={listHeader}
        renderItem={({ item }) => rowView(item)}
        style={{ flex: 1 }}
        windowSize={7}
      />

      <Sheet
        footer={(
          <Button onPress={() => setFiltersOpen(false)} variant="primary">
            完成
          </Button>
        )}
        onClose={() => setFiltersOpen(false)}
        testID="library-filters"
        title="筛选"
        visible={filtersOpen}
      >
        <View style={{ gap: theme.space.lg }}>
          <View>
            <SectionHeader
              action={favouritesOnly ? (
                <Button onPress={() => setFavouritesOnly(false)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="收藏"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip
                icon={favouritesOnly ? 'starFill' : 'star'}
                onPress={() => setFavouritesOnly(value => !value)}
                selected={favouritesOnly}
                size="sm"
                testID="library-filters-favourites"
                tone="neutral"
              >
                仅收藏
              </Chip>
            </View>
          </View>

          <View>
            <SectionHeader
              action={bodyPart ? (
                <Button onPress={() => setBodyPart(null)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="部位"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip onPress={() => setBodyPart(null)} selected={bodyPart === null} size="sm" tone="neutral">
                全部
              </Chip>
              {BODY_PARTS.map(part => (
                <Chip
                  key={part}
                  onPress={() => setBodyPart(bodyPart === part ? null : part)}
                  selected={bodyPart === part}
                  size="sm"
                  tone="neutral"
                >
                  {bodyPartName(part)}
                </Chip>
              ))}
            </View>
          </View>

          <View>
            <SectionHeader
              action={targetMuscle ? (
                <Button onPress={() => setTargetMuscle(null)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="目标肌群"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip onPress={() => setTargetMuscle(null)} selected={targetMuscle === null} size="sm" tone="neutral">
                全部
              </Chip>
              {TARGET_MUSCLES.map(value => (
                <Chip
                  key={value}
                  onPress={() => setTargetMuscle(targetMuscle === value ? null : value)}
                  selected={targetMuscle === value}
                  size="sm"
                  testID={`library-filters-target-${value}`}
                  tone="neutral"
                >
                  {targetMuscleName(value)}
                </Chip>
              ))}
            </View>
          </View>

          <View>
            <SectionHeader
              action={oneLimb ? (
                <Button onPress={() => setOneLimb(false)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="单侧"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip
                onPress={() => setOneLimb(value => !value)}
                selected={oneLimb}
                size="sm"
                testID="library-filters-one-limb"
                tone="neutral"
              >
                仅单侧
              </Chip>
            </View>
          </View>

          <View>
            <SectionHeader
              action={equipment ? (
                <Button onPress={() => setEquipment(null)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="器械"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip onPress={() => setEquipment(null)} selected={equipment === null} size="sm" tone="neutral">
                全部
              </Chip>
              {EQUIPMENT.map(value => (
                <Chip
                  key={value}
                  onPress={() => setEquipment(equipment === value ? null : value)}
                  selected={equipment === value}
                  size="sm"
                  tone="neutral"
                >
                  {equipmentName(value)}
                </Chip>
              ))}
            </View>
          </View>

          {activeFilters > 0 ? (
            <Button onPress={clearFilterChips} variant="ghost">
              清除筛选
            </Button>
          ) : null}
        </View>
      </Sheet>

      <Sheet
        footer={(
          <View style={{ gap: theme.space.sm }}>
            <Button disabled={!customNameValue.trim()} onPress={saveCustom} variant="primary">
              保存
            </Button>
            <Button onPress={closeEdit} variant="secondary">
              取消
            </Button>
          </View>
        )}
        onClose={closeEdit}
        testID="library-custom-sheet"
        title={editing?.id ? '编辑自定义动作' : '新建自定义动作'}
        visible={editing !== null}
      >
        <TextField
          autoFocus
          label="动作名称"
          maxLength={80}
          onChangeText={setCustomNameValue}
          placeholder="例如：杠铃深蹲"
          value={customNameValue}
        />
        <View style={{ height: theme.space.md }} />
      </Sheet>
    </Screen>
  );

  if (!replacing) return library;

  return (
    <View style={{ flex: 1 }}>
      <View
        accessibilityElementsHidden={detail !== null}
        importantForAccessibility={detail ? 'no-hide-descendants' : 'auto'}
        pointerEvents={detail ? 'none' : 'auto'}
        style={{ flex: 1 }}
      >
        {library}
      </View>
      {detail ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.bg }]}>
          <ExerciseDetailScreen
            key={`${detail.custom ? 'custom' : 'catalogue'}-${detail.id}`}
            connection={connection}
            custom={detail.custom}
            exerciseId={detail.id}
            onBack={() => setDetail(null)}
            onFavorite={onFavorite}
            onPick={() => {
              submitPick(detail.id, detail.custom);
              setDetail(null);
            }}
            pickLabel="选择此动作替换"
            profile={profile}
            server={server}
          />
        </View>
      ) : null}
    </View>
  );
}
