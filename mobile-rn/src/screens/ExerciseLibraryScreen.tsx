import { useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
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
  bodyPartName,
  countCatalogue,
  equipmentName,
  searchCatalogue,
} from '../catalogue';
import type { CustomExercise, Profile, RoutineExercise } from '../training';

export type ExerciseLibraryScreenProps = {
  profile: Profile;
  server: string | null;
  onPick: (exercise: RoutineExercise) => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void;
  /** Shown as a back button when the library is used as a full-screen picker. */
  onBack?: () => void;
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
  onPick,
  onCustom,
  onBack,
}: ExerciseLibraryScreenProps) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [bodyPart, setBodyPart] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<string | null>(null);
  const [limit, setLimit] = useState(SEARCH_LIMIT);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editing, setEditing] = useState<CustomExercise | null>(null);
  const [customNameValue, setCustomNameValue] = useState('');

  const term = query.trim().toLowerCase();

  // A new search or filter starts the list over at the first page.
  useEffect(() => {
    setLimit(SEARCH_LIMIT);
  }, [query, bodyPart, equipment]);

  const catalogue = useMemo(
    () => searchCatalogue(query, bodyPart ?? undefined, equipment ?? undefined, limit) as CatalogueExercise[],
    [query, bodyPart, equipment, limit],
  );

  const customRows = useMemo(
    () => (profile.customEx ?? [])
      .filter((exercise): exercise is CustomExercise => !!exercise && typeof exercise.id === 'string')
      .filter(exercise => {
        if (bodyPart && exercise.bp !== bodyPart) return false;
        if (equipment && exercise.eq !== equipment) return false;
        if (!term) return true;
        const name = customName(exercise).toLowerCase();
        return name.includes(term) || exercise.id.toLowerCase().includes(term);
      }),
    [profile.customEx, bodyPart, equipment, term],
  );

  const rows = useMemo<Row[]>(
    () => [
      ...customRows.map(exercise => ({ kind: 'custom' as const, exercise })),
      ...catalogue.map(exercise => ({ kind: 'catalogue' as const, exercise })),
    ],
    [catalogue, customRows],
  );

  const narrowed = term !== '' || bodyPart !== null || equipment !== null;
  const activeFilters = (bodyPart ? 1 : 0) + (equipment ? 1 : 0);
  const total = useMemo(
    () => countCatalogue(query, bodyPart ?? undefined, equipment ?? undefined) + customRows.length,
    [query, bodyPart, equipment, customRows],
  );
  const subtitle = `${CATALOGUE_COUNT} 个动画动作 + ${(profile.customEx ?? []).filter(Boolean).length} 个自建`;

  const clearFilters = () => {
    setQuery('');
    setBodyPart(null);
    setEquipment(null);
  };

  // The filter sheet clears the chips only; the search text lives outside it.
  const clearFilterChips = () => {
    setBodyPart(null);
    setEquipment(null);
  };

  const pickCatalogue = (exercise: CatalogueExercise) => {
    onPick({ id: exercise.id, mode: exercise.cardio ? 'cardio' : 'reps' });
  };

  const pickCustom = (exercise: CustomExercise) => {
    onPick({ id: exercise.id, mode: exercise.bp === 'cardio' ? 'cardio' : 'reps' });
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
    if (item.kind === 'custom') {
      const custom = item.exercise;
      const name = customName(custom);
      return (
        <Card padded={false}>
          <ListRow
            accessibilityLabel={`选择 ${name}`}
            leading={<MediaThumb exerciseId={custom.id} server={null} size={44} radius={theme.radius.lg} />}
            onPress={() => pickCustom(custom)}
            subtitle={subtitleOf(custom.bp, custom.eq)}
            testID={`library-ex-${custom.id}`}
            title={name}
            trailing={(
              <IconButton
                accessibilityLabel={`编辑 ${name}`}
                name="pencil"
                onPress={() => startEdit(custom)}
                size="sm"
              />
            )}
          />
        </Card>
      );
    }

    const exercise = item.exercise;
    return (
      <Card padded={false}>
        <ListRow
          accessibilityLabel={`选择 ${exercise.name}`}
          leading={<MediaThumb exerciseId={exercise.id} server={server} size={44} radius={theme.radius.lg} />}
          onPress={() => pickCatalogue(exercise)}
          subtitle={subtitleOf(exercise.bodyPart, exercise.equipment)}
          testID={`library-ex-${exercise.id}`}
          title={exercise.name}
          trailing={(
            <IconButton
              accessibilityLabel={`选择 ${exercise.name}`}
              name="plus"
              onPress={() => pickCatalogue(exercise)}
              size="sm"
            />
          )}
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
            name="slider"
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

  return (
    <Screen scroll={false} testID="library-screen">
      <FlatList
        contentContainerStyle={{ padding: theme.layout.pagePadding, paddingBottom: 28 }}
        data={rows}
        initialNumToRender={12}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={item => `${item.kind}-${item.exercise.id}`}
        ListEmptyComponent={(
          <EmptyState
            icon="magnifier"
            text="换个关键词，或者清除筛选后再试。"
            title="没有匹配的动作"
          >
            {narrowed ? (
              <Button onPress={clearFilters} variant="secondary">
                清除筛选
              </Button>
            ) : null}
          </EmptyState>
        )}
        ListFooterComponent={catalogue.length >= limit ? (
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
}
