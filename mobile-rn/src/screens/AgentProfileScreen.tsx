import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import {
  Badge, Button, Card, Divider, Header, ListRow, Screen, SectionHeader, Segmented, Text, TextField, useTheme,
} from '../design';
import type { Connection } from '../server';
import type { LocalState } from '../storage';
import { createLocalRuntime, createServerAgent } from '../agent';
import type { AgentProfilePublic } from '../agent';

type Mode = 'local' | 'server';
const LOCAL_PROVIDERS = ['fixture', 'openai', 'compatible'] as const;
const SERVER_PROVIDERS = ['fixture', 'openai'] as const;

export type AgentProfileScreenProps = {
  connection: Connection | null;
  data: LocalState;
  onClose: () => void;
};

export function AgentProfileScreen({ connection, data, onClose }: AgentProfileScreenProps) {
  const theme = useTheme();
  const local = useMemo(() => createLocalRuntime(connection, data), [connection, data]);
  const server = useMemo(() => (connection ? createServerAgent(connection) : null), [connection]);
  const [mode, setMode] = useState<Mode>('local');
  const [profiles, setProfiles] = useState<AgentProfilePublic[]>([]);
  const [editing, setEditing] = useState<AgentProfilePublic | null>(null);
  const [provider, setProvider] = useState<string>('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const modes: { value: Mode; label: string }[] = connection
    ? [{ value: 'local', label: '本机' }, { value: 'server', label: '服务器' }]
    : [{ value: 'local', label: '本机' }];
  const providers = mode === 'local' ? LOCAL_PROVIDERS : SERVER_PROVIDERS;

  const load = useCallback(async () => {
    try {
      setProfiles(mode === 'server' && server ? await server.profiles() : await local.profiles());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '加载配置失败。');
    }
  }, [local, mode, server]);

  useEffect(() => { load().catch(() => undefined); }, [load]);

  const reset = () => {
    setEditing(null);
    setProvider('openai');
    setModel('');
    setApiKey('');
    setBaseUrl('');
  };

  const edit = (profile: AgentProfilePublic) => {
    setEditing(profile);
    setProvider(profile.provider);
    setModel(profile.model);
    setApiKey('');
    setBaseUrl(mode === 'local' ? (local.store.readKv<string>(local.scope, `endpoint:${profile.id}`) || '') : '');
  };

  const save = async () => {
    if (!model.trim()) return;
    if ((provider === 'openai' || provider === 'compatible') && mode === 'local') {
      const endpoint = baseUrl.trim();
      if (provider === 'compatible' && !endpoint) {
        setError('兼容端点需要填写 URL。');
        return;
      }
    }
    setBusy(true);
    setError('');
    try {
      const input = {
        provider: provider as 'fixture' | 'openai' | 'compatible',
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(mode === 'local' && provider !== 'fixture' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      };
      if (mode === 'server' && server) {
        if (editing) await server.updateProfile(editing.id, input);
        else await server.createProfile(input);
      } else if (editing) {
        await local.updateProfile(editing.id, input);
      } else {
        await local.createProfile(input);
      }
      reset();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const remove = (profile: AgentProfilePublic) => {
    Alert.alert('删除配置？', '这会删除这台设备或账号上的模型配置。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          (async () => {
            try {
              if (mode === 'server' && server) await server.removeProfile(profile.id);
              else await local.removeProfile(profile.id);
              if (editing?.id === profile.id) reset();
              await load();
            } catch (failure) {
              Alert.alert('无法删除', failure instanceof Error ? failure.message : '请重试。');
            }
          })().catch(() => undefined);
        },
      },
    ]);
  };

  return <Screen>
    <Header title="Agent 配置" subtitle="本机密钥保存在安全存储，服务端密钥只写不读" onBack={onClose} />
    <Segmented options={modes} value={mode} onChange={value => { setMode(value); reset(); }} />

    <Card>
      <SectionHeader title="已有配置" />
      {profiles.length ? profiles.map(profile => <ListRow
        key={profile.id}
        title={`${profile.provider} · ${profile.model}`}
        subtitle={`${profile.id}${profile.keyHint ? ` · 尾号 ${profile.keyHint}` : ''}${profile.available ? '' : ' · 不可用'}`}
        trailing={profile.source === 'default'
          ? <Badge>只读</Badge>
          : <View style={{ flexDirection: 'row', gap: theme.space.xs }}>
            <Button size="xs" variant="ghost" onPress={() => edit(profile)}>编辑</Button>
            <Button size="xs" variant="ghost" onPress={() => remove(profile)}>删除</Button>
          </View>}
      />) : <Text tone="secondary" variant="footnote">还没有配置。</Text>}
      <Divider inset={0} />
    </Card>

    <Card>
      <SectionHeader title={editing ? '编辑配置' : '新增配置'} />
      <Segmented
        options={providers.map(id => ({ value: id, label: id }))}
        value={provider}
        onChange={value => { setProvider(value); if (value === 'fixture') setApiKey(''); }}
      />
      <TextField label="模型" value={model} onChangeText={setModel} placeholder={provider === 'fixture' ? 'fixture' : 'gpt-5.6'} autoCapitalize="none" />
      {mode === 'local' && provider !== 'fixture' ? <TextField label="端点 URL" value={baseUrl} onChangeText={setBaseUrl} placeholder="https://api.openai.com/v1" autoCapitalize="none" helper="局域网地址允许 http://；公网必须 https://。" /> : null}
      {provider !== 'fixture' ? <TextField label={editing ? '替换 API Key（留空保留）' : 'API Key'} value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" /> : null}
      <View style={{ flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.sm }}>
        <Button variant="primary" onPress={() => { save().catch(() => undefined); }} disabled={busy || !model.trim()}>{busy ? '保存中…' : '保存'}</Button>
        {editing ? <Button variant="secondary" onPress={reset}>取消</Button> : null}
      </View>
      {error ? <Text tone="danger" variant="footnote" style={{ marginTop: theme.space.sm }}>{error}</Text> : null}
    </Card>
  </Screen>;
}
