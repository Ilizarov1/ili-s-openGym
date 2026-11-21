import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import {
  Badge, Button, Card, Divider, Header, ListRow, Screen, SectionHeader, Segmented, Text, TextField, useTheme,
} from '../design';
import type { Connection } from '../server';
import type { LocalState } from '../storage';
import { createId, createLocalRuntime, createServerAgent } from '../agent';
import type { AgentMemory, AgentProfilePublic, AgentProposal, AgentRunRow, AgentSessionSummary } from '../agent';

type Mode = 'local' | 'server';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const MEMORY_CATEGORIES = ['preference', 'goal', 'constraint', 'note'] as const;

const parseMemoryValue = (text: string): unknown => {
  const value = text.trim();
  if (!/^[[{]/.test(value)) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};

export type AgentScreenProps = {
  connection: Connection | null;
  data: LocalState;
  onClose: () => void;
  onOpenProfiles: () => void;
};

function labelOf(profile: AgentProfilePublic): string {
  const label = 'label' in profile && profile.label ? String(profile.label) : `${profile.provider} · ${profile.model}`;
  return profile.available ? label : `${label} (不可用)`;
}

export function AgentScreen({ connection, data, onClose, onOpenProfiles }: AgentScreenProps) {
  const theme = useTheme();
  const local = useMemo(() => createLocalRuntime(connection, data), [connection, data]);
  const server = useMemo(() => (connection ? createServerAgent(connection) : null), [connection]);
  const [mode, setMode] = useState<Mode>('local');
  const [profiles, setProfiles] = useState<AgentProfilePublic[]>([]);
  const [profileId, setProfileId] = useState('');
  const [sessionId, setSessionId] = useState(`ses_${randomUUID()}`);
  const [prompt, setPrompt] = useState('');
  const [run, setRun] = useState<AgentRunRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [memoryCategory, setMemoryCategory] = useState('preference');
  const [memoryValue, setMemoryValue] = useState('');
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [serverEnabled, setServerEnabled] = useState(true);
  const [handledProposal, setHandledProposal] = useState<{ id: string; status: 'consumed' | 'rejected' } | null>(null);
  // Reused only while the submission it names is still open (or its response
  // was lost); a terminal run or a new conversation closes the window.
  const requestRef = useRef<{ key: string; id: string }>({ key: '', id: '' });
  const requestKey = (input: Record<string, unknown>, profile: string, session: string) =>
    JSON.stringify({ mode, profileId: profile, sessionId: session, input });

  const modes: { value: Mode; label: string }[] = connection
    ? [{ value: 'local', label: '本机' }, { value: 'server', label: '服务器' }]
    : [{ value: 'local', label: '本机' }];

  const loadProfiles = useCallback(async () => {
    try {
      const list = mode === 'server' && server ? await server.profiles() : await local.profiles();
      setProfiles(list);
      setProfileId(current => list.some(profile => profile.id === current && profile.available)
        ? current
        : (list.find(profile => profile.available)?.id || ''));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '加载配置失败。');
    }
  }, [local, mode, server]);

  const loadLists = useCallback(async () => {
    try {
      if (mode === 'server' && server) {
        setSessions(await server.sessions());
        setMemories(await server.memories());
      } else {
        setSessions(local.sessions());
        setMemories(local.memories());
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '加载记录失败。');
    }
  }, [local, mode, server]);

  useEffect(() => { loadProfiles().catch(() => undefined); }, [loadProfiles]);
  useEffect(() => { loadLists().catch(() => undefined); }, [loadLists]);
  useEffect(() => {
    if (!server) {
      setServerEnabled(true);
      return;
    }
    server.status().then(next => setServerEnabled(next.enabled)).catch(() => undefined);
  }, [server]);

  const refreshRun = useCallback(async (runId: string): Promise<AgentRunRow | null> => {
    if (!runId) return null;
    try {
      const next = mode === 'server' && server ? await server.getRun(runId) : local.get(runId);
      setRun(next);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取运行失败。');
      return null;
    }
  }, [local, mode, server]);

  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) return undefined;
    const runId = run.runId;
    const timer = setInterval(() => { refreshRun(runId).catch(() => undefined); }, 2000);
    return () => clearInterval(timer);
  }, [run, refreshRun]);

  useEffect(() => {
    if (run?.status === 'completed') loadLists().catch(() => undefined);
  }, [run?.status, loadLists]);

  useEffect(() => {
    if (run && TERMINAL.has(run.status)) requestRef.current = { key: '', id: '' };
  }, [run]);

  const start = async (fixtureCase?: string) => {
    if (!prompt.trim() || !profileId) return;
    setBusy(true);
    setError('');
    try {
      const text = prompt.trim();
      const input = { prompt: text, ...(fixtureCase ? { fixtureCase } : {}) };
      const key = requestKey(input, profileId, sessionId);
      let requestId = requestRef.current.key === key ? requestRef.current.id : '';
      if (!requestId) {
        requestId = createId('req', randomUUID);
        requestRef.current = { key, id: requestId };
      }
      if (mode === 'server' && server) {
        const started = await server.startRun({ requestId, profileId, sessionId, input });
        await refreshRun(started.runId);
      } else {
        const started = await local.start({ requestId, profileId, sessionId, input });
        setRun(started);
      }
      await loadLists();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '启动失败。');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    try {
      const next = mode === 'server' && server ? await server.cancelRun(run.runId) : local.cancel(run.runId);
      setRun(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '取消失败。');
    }
  };

  const confirm = async (proposal: AgentProposal) => {
    try {
      const answer = mode === 'server' && server
        ? await server.confirmProposal(proposal.proposalId)
        : local.confirmProposal(proposal.proposalId);
      setHandledProposal({ id: proposal.proposalId, status: 'consumed' });
      Alert.alert('已应用', JSON.stringify(answer.result ?? null));
      await refreshRun(run?.runId || '');
    } catch (failure) {
      Alert.alert('无法应用', failure instanceof Error ? failure.message : '请重试。');
    }
  };

  const reject = async (proposal: AgentProposal) => {
    try {
      if (mode === 'server' && server) await server.rejectProposal(proposal.proposalId);
      else local.rejectProposal(proposal.proposalId);
      setHandledProposal({ id: proposal.proposalId, status: 'rejected' });
      Alert.alert('已拒绝');
      await refreshRun(run?.runId || '');
    } catch (failure) {
      Alert.alert('无法拒绝', failure instanceof Error ? failure.message : '请重试。');
    }
  };

  const proposal = (run?.result as { proposal?: AgentProposal } | undefined)?.proposal;
  const result = run?.result as { text?: string; structured?: unknown } | undefined;
  const resultText = result?.text || (result?.structured ? JSON.stringify(result.structured, null, 2) : '');

  return <Screen>
    <Header title="Agent" subtitle="本机或服务端执行" onBack={onClose} right={<Button size="sm" variant="tinted" onPress={onOpenProfiles}>配置</Button>} />
    <Segmented options={modes} value={mode} onChange={value => {
      setMode(value);
      setRun(null);
      setEditingMemoryId(null);
      setMemoryValue('');
      requestRef.current = { key: '', id: '' };
    }} />
    {mode === 'server' && !serverEnabled
      ? <Text tone="danger" variant="footnote">服务器 Agent 已在此实例禁用；本机执行仍可使用。</Text>
      : null}
    <Card>
      <Text variant="headline">选择模型配置</Text>
      {profiles.length ? profiles.map(profile => <ListRow
        key={profile.id}
        title={labelOf(profile)}
        subtitle={`${profile.provider} · ${profile.model}`}
        trailing={profile.id === profileId ? <Badge>已选</Badge> : null}
        onPress={profile.available ? () => setProfileId(profile.id) : undefined}
        disabled={!profile.available}
      />) : <Text tone="secondary" variant="footnote">还没有可用配置。</Text>}
    </Card>
    <Card>
      <TextField label="任务输入" value={prompt} onChangeText={setPrompt} placeholder="问点什么，或描述要准备的改动。" multiline />
      <View style={{ flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.sm }}>
        <Button variant="primary" onPress={() => { start().catch(() => undefined); }} disabled={busy || !prompt.trim() || !profileId || (mode === 'server' && !serverEnabled)}>{busy ? '启动中…' : '开始'}</Button>
        {profiles.find(profile => profile.id === profileId)?.provider === 'fixture'
          ? <View style={{ flexDirection: 'row', gap: theme.space.xs }}>
            <Button variant="secondary" onPress={() => { start('proposal').catch(() => undefined); }} disabled={busy || !prompt.trim() || (mode === 'server' && !serverEnabled)}>测试提案</Button>
            <Button variant="secondary" onPress={() => { start('late').catch(() => undefined); }} disabled={busy || !prompt.trim() || (mode === 'server' && !serverEnabled)}>延迟</Button>
          </View>
          : null}
        <Button variant="secondary" onPress={() => { setSessionId(`ses_${randomUUID()}`); setRun(null); requestRef.current = { key: '', id: '' }; }} disabled={busy}>新会话</Button>
        {run && !TERMINAL.has(run.status) ? <Button variant="secondary" onPress={() => { cancel().catch(() => undefined); }}>取消</Button> : null}
      </View>
      {error ? <Text tone="danger" variant="footnote" style={{ marginTop: theme.space.sm }}>{error}</Text> : null}
    </Card>

    {run ? <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="headline">运行</Text>
        <Badge tone={run.status === 'completed' ? 'accent' : run.status === 'failed' || run.status === 'cancelled' ? 'danger' : 'neutral'}>{run.status}</Badge>
      </View>
      <Text tone="secondary" variant="footnote">{run.runId}</Text>
      {resultText ? <Text variant="body" style={{ marginTop: theme.space.sm }}>{resultText}</Text> : null}
      {run.error ? <Text tone="danger" variant="footnote">{run.error.code}: {run.error.message}</Text> : null}
      {proposal ? <View style={{ marginTop: theme.space.sm }}>
        <SectionHeader title="待确认改动" />
        <Text tone="secondary" variant="footnote">{JSON.stringify(proposal.changes)}</Text>
        <View style={{ flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.sm }}>
          <Button size="sm" variant="primary" disabled={proposal.status !== 'pending' || handledProposal?.id === proposal.proposalId} onPress={() => { confirm(proposal).catch(() => undefined); }}>{handledProposal?.id === proposal.proposalId ? (handledProposal.status === 'rejected' ? '已拒绝' : '已应用') : '确认'}</Button>
          <Button size="sm" variant="secondary" disabled={proposal.status !== 'pending' || handledProposal?.id === proposal.proposalId} onPress={() => { reject(proposal).catch(() => undefined); }}>拒绝</Button>
        </View>
      </View> : null}
    </Card> : null}

    <Card>
      <SectionHeader title="会话" />
      {sessions.length ? sessions.map(session => <ListRow
        key={session.id}
        title={session.title || session.id}
        subtitle={`${session.messageCount} 条消息`}
        trailing={<Button size="xs" variant="ghost" onPress={() => { (async () => {
          try {
            const detail = mode === 'server' && server ? await server.session(session.id) : local.session(session.id);
            setSessionId(session.id);
            setPrompt((detail?.messages || []).map(message => `${message.role}: ${message.content}`).join('\n'));
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : '读取会话失败。');
          }
        })().catch(() => undefined); }}>载入</Button>}
      />) : <Text tone="secondary" variant="footnote">还没有会话。</Text>}
      <Divider inset={0} />
    </Card>

    <Card>
      <SectionHeader title="长期记忆" />
      <Segmented
        options={MEMORY_CATEGORIES.map(id => ({ value: id, label: id }))}
        value={memoryCategory}
        onChange={value => setMemoryCategory(value)}
      />
      <TextField label="内容" value={memoryValue} onChangeText={setMemoryValue} />
      <View style={{ flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.sm }}>
        <Button size="sm" variant="tinted" disabled={!memoryValue.trim()} onPress={() => { (async () => {
          try {
            const body = { category: memoryCategory, value: parseMemoryValue(memoryValue), source: 'user' };
            if (mode === 'server' && server) {
              if (editingMemoryId) await server.updateMemory(editingMemoryId, body);
              else await server.saveMemory(body);
            } else if (editingMemoryId) {
              local.updateMemory(editingMemoryId, body);
            } else {
              local.saveMemory(body);
            }
            setMemoryValue('');
            setEditingMemoryId(null);
            await loadLists();
          } catch (failure) {
            Alert.alert('无法保存', failure instanceof Error ? failure.message : '请重试。');
          }
        })().catch(() => undefined); }}>{editingMemoryId ? '更新记忆' : '保存记忆'}</Button>
        {editingMemoryId ? <Button size="sm" variant="secondary" onPress={() => {
          setEditingMemoryId(null);
          setMemoryValue('');
        }}>取消</Button> : null}
      </View>
      {memories.length ? memories.map(memory => <ListRow
        key={memory.id}
        title={memory.category}
        subtitle={typeof memory.value === 'string' ? memory.value : JSON.stringify(memory.value)}
        trailing={<View style={{ flexDirection: 'row', gap: theme.space.xs }}>
          <Button size="xs" variant="ghost" onPress={() => {
            setEditingMemoryId(memory.id);
            setMemoryCategory(memory.category);
            setMemoryValue(typeof memory.value === 'string' ? memory.value : JSON.stringify(memory.value));
          }}>编辑</Button>
          <Button size="xs" variant="ghost" onPress={() => { (async () => {
            try {
              if (mode === 'server' && server) await server.deleteMemory(memory.id);
              else local.deleteMemory(memory.id);
              if (editingMemoryId === memory.id) {
                setEditingMemoryId(null);
                setMemoryValue('');
              }
              await loadLists();
            } catch (failure) {
              Alert.alert('无法删除', failure instanceof Error ? failure.message : '请重试。');
            }
          })().catch(() => undefined); }}>删除</Button>
        </View>}
      />) : <Text tone="secondary" variant="footnote">还没有记忆。</Text>}
    </Card>
  </Screen>;
}
