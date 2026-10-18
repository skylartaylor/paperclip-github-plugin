import type { PluginPerformActionContext } from '@paperclipai/plugin-sdk';

export interface HardeningPolicy {
  incrementalPollingEnabled: boolean;
  scheduleEnabled: boolean;
  permissionProbesEnabled: boolean;
  wakeupsEnabled: boolean;
  sdkOnlySync: boolean;
  maxItemsPerSync: number;
  coordinatorAgentId?: string;
}

/** Only operator-owned plugin config controls authority; action params never do. */
export function hardeningPolicy(value: unknown): HardeningPolicy {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const limit = typeof v.maxItemsPerSync === 'number' ? v.maxItemsPerSync : 25;
  return {
    incrementalPollingEnabled: v.incrementalPollingEnabled === true,
    scheduleEnabled: v.scheduleEnabled === true,
    permissionProbesEnabled: v.permissionProbesEnabled === true,
    wakeupsEnabled: v.wakeupsEnabled === true,
    sdkOnlySync: v.sdkOnlySync !== false,
    maxItemsPerSync: Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000 ? limit : 25,
    ...(typeof v.coordinatorAgentId === 'string' && v.coordinatorAgentId.trim()
      ? { coordinatorAgentId: v.coordinatorAgentId.trim() } : {})
  };
}

export function assertHumanAction(context?: PluginPerformActionContext | null): void {
  if (context?.actor.type !== 'user' || !context.actor.userId?.trim()) {
    throw new Error('This GitHub Sync action requires an authenticated human. Agents must use their authorized plugin tools.');
  }
}

export function assertCoordinator(policy: HardeningPolicy, agentId: string): void {
  if (!policy.coordinatorAgentId || policy.coordinatorAgentId !== agentId) {
    throw new Error('GitHub writes are restricted to the configured coordinator agent.');
  }
}

export function requireHeadSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('A full expectedHeadSha from the reviewed pull request is required. Refresh the pull request before merging.');
  }
  return value.toLowerCase();
}
