import {createTestHarness as raw, type TestHarnessOptions} from '@paperclipai/plugin-sdk/testing';
/** Historical behavior is explicitly enabled in legacy tests, never in production defaults. */
export function createLegacyTestHarness(options: TestHarnessOptions) {
  const h = raw({...options, config: {hardening: {scheduleEnabled:true, permissionProbesEnabled:true, wakeupsEnabled:true, sdkOnlySync:false, maxItemsPerSync:1000, coordinatorAgentId:'agent-1'}, ...options.config}});
  const action=h.performAction.bind(h), tool=h.executeTool.bind(h);
  h.performAction=(key, params={}, context) => action(key,params,{actor:{type:'user',userId:'test-operator'},...context});
  h.executeTool=(name,params,runCtx={})=>tool(name,params,{agentId:'agent-1',...runCtx});
  return h;
}
