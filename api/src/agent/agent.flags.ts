/* One kill switch for the whole agent surface. */
const OFF = /^(1|true|yes|on)$/i;

export function agentEnabled(): boolean {
  return !OFF.test(String(process.env.AGENT_RUNTIME_DISABLED || '').trim());
}

export function agentPublicConfig(): { enabled: boolean } {
  return { enabled: agentEnabled() };
}
