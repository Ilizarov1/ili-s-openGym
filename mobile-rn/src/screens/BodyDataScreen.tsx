import { useState } from 'react';
import { Header, Screen, Segmented, Text, useTheme } from '../design';
import type { ProfileChange } from '../profileChanges';
import type { Connection } from '../server';
import type { LocalState, PhotoUpload } from '../storage';
import { unitOf, type Profile, type Unit, type Workout } from '../training';
import { MeasurementSection } from '../body/MeasurementSection';
import { PhotoSection } from '../body/PhotoSection';
import { WeightSection } from '../body/WeightSection';

export type BodyHistoryItem = { workout: Workout; unit: Unit; pending: boolean };

export type BodyDataScreenProps = {
  profile: Profile;
  history: BodyHistoryItem[];
  connection: Connection | null;
  onClose: () => void;
  onCommit: (changes: ProfileChange[]) => void;
  onChangeLocal: (update: (data: LocalState) => LocalState) => void;
  /**
   * Optional mirror of `LocalState.photoUploads`. Pass `workspace.data.photoUploads` so a
   * pending badge survives closing and reopening the screen; without it the screen still
   * works, but a badge only appears for an upload started in this visit.
   */
  photoUploads?: PhotoUpload[];
};

type BodyTab = 'weight' | 'measurements' | 'photos';

const tabs = [
  { value: 'weight' as const, label: '体重' },
  { value: 'measurements' as const, label: '围度' },
  { value: 'photos' as const, label: '照片' },
];

/** 「进度与身体数据」的入口：顶部分段切换体重、围度和照片。 */
export function BodyDataScreen({
  profile,
  history,
  connection,
  onClose,
  onCommit,
  onChangeLocal,
  photoUploads = [],
}: BodyDataScreenProps) {
  const theme = useTheme();
  const [tab, setTab] = useState<BodyTab>('weight');
  const unit = unitOf(profile);

  return (
    <Screen testID="body-data-screen">
      <Header
        onBack={onClose}
        subtitle={`体重、围度与进度照片 · ${history.length} 次训练 · ${unit}`}
        title="身体数据"
      />
      <Segmented
        onChange={value => setTab(value)}
        options={tabs}
        style={{ marginBottom: theme.space.lg }}
        value={tab}
      />
      {tab === 'weight' ? <WeightSection onCommit={onCommit} profile={profile} /> : null}
      {tab === 'measurements' ? <MeasurementSection onCommit={onCommit} profile={profile} /> : null}
      {tab === 'photos' ? (
        <PhotoSection
          connection={connection}
          onChangeLocal={onChangeLocal}
          onCommit={onCommit}
          profile={profile}
          uploads={photoUploads}
        />
      ) : null}
      <Text tone="secondary" style={{ marginTop: theme.space.xl }} variant="caption">
        身体数据与训练记录一样保存在当前工作区；配对账号会在下一次同步时合并到账号。
      </Text>
    </Screen>
  );
}
