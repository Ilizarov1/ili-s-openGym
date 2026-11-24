/* One kill switch for the whole agent surface, and the fixture gate. */
import { retrievalConfigured } from './retrieval/config.js';
const OFF = /^(1|true|yes|on)$/i;

export function agentEnabled(): boolean {
  return !OFF.test(String(process.env.AGENT_RUNTIME_DISABLED || '').trim());
}

/** The fixture provider (and its fixture attachments) exist for tests and
 *  acceptance instances, not for a production deployment. */
export function fixtureAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && !/^(0|false|no|off)$/i.test(process.env.AGENT_FIXTURE_PROVIDER || '');
}

/** The instance default profile's image capability. Set AGENT_VISION=0 (or
 *  agentVision=0) when the administrator's default model cannot read images. */
export function agentVision(): boolean {
  const raw = process.env.AGENT_VISION ?? process.env.agentVision;
  if (raw === undefined || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

export function exerciseSearchVersion(): 'v1' | 'v2' {
  const version = String(process.env.EXERCISE_SEARCH_VERSION || '').trim();
  if (version === 'v1' || version === 'v2') return version;
  return retrievalConfigured() ? 'v2' : 'v1';
}

export function agentPublicConfig(): { enabled: boolean; exerciseSearchVersion: 'v1' | 'v2' } {
  return { enabled: agentEnabled(), exerciseSearchVersion: exerciseSearchVersion() };
}
