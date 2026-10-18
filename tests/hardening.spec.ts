import {strict as assert} from 'node:assert';
import test from 'node:test';
import {createTestHarness} from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.ts';
import {hardeningPolicy, assertCoordinator, assertHumanAction, requireHeadSha} from '../src/hardening-policy.ts';
const human={companyId:'company-1',actor:{type:'user' as const,userId:'operator',companyId:'company-1'}};
let serial=0;
test('host configuration schema admits every hardening policy control',()=>{
 const schema=manifest.instanceConfigSchema as {properties:{hardening:{additionalProperties:boolean;properties:Record<string,{type:string;default?:unknown}>}}};
 const hardening=schema.properties.hardening;
 assert.equal(hardening.additionalProperties,false);
 for(const [key,value] of Object.entries(hardeningPolicy(undefined))) {
  assert.ok(key in hardening.properties,`Host config validation must admit ${key}`);
  assert.equal(hardening.properties[key].default,value);
 }
 assert.equal(hardening.properties.incrementalPollingEnabled.type,'boolean');
 assert.equal(hardeningPolicy({incrementalPollingEnabled:true}).incrementalPollingEnabled,true);
});
async function setup(hardening:unknown={}) {
 const module=await import(`../src/worker.ts?hardening=${++serial}`);
 const h=createTestHarness({manifest,config:{githubToken:'synthetic-token',hardening}});
 await module.default.definition.setup(h.ctx);
 await h.performAction('settings.saveRegistration',{companyId:'company-1',mappings:[{id:'pilot',repositoryUrl:'paperclipai/example-repo',paperclipProjectName:'Pilot',paperclipProjectId:'project-1',companyId:'company-1'}]},human);
 return {h,module};
}
test('hardening defaults are paused, bounded, SDK-only and have no write coordinator',()=>{
 assert.deepEqual(hardeningPolicy(undefined),{incrementalPollingEnabled:false,scheduleEnabled:false,permissionProbesEnabled:false,wakeupsEnabled:false,sdkOnlySync:true,maxItemsPerSync:25});
 assert.throws(()=>assertCoordinator(hardeningPolicy({}), 'worker'),/coordinator/);
 assert.throws(()=>assertCoordinator(hardeningPolicy({coordinatorAgentId:'steward'}),'worker'),/coordinator/);
 assert.doesNotThrow(()=>assertCoordinator(hardeningPolicy({coordinatorAgentId:'steward'}),'steward'));
 for(const value of [undefined,'short','g'.repeat(40)]) assert.throws(()=>requireHeadSha(value),/expectedHeadSha/);
 assert.equal(requireHeadSha('A'.repeat(40)),'a'.repeat(40));
 assert.equal(hardeningPolicy({maxItemsPerSync:-1,scheduleEnabled:'true'}).maxItemsPerSync,25);
 assert.throws(()=>assertHumanAction({actor:{type:'user',userId:null,companyId:'company-1',agentId:null,runId:null},companyId:'company-1'}),/authenticated human/);
});
test('agents cannot spoof a human through UI actions, including settings and sync controls',async()=>{
 const {h}=await setup();
 const before=await h.getData('settings.registration',{companyId:'company-1'});
 for(const key of ['settings.saveRegistration','settings.validateToken','settings.ensureGitHubTokenAvailable','settings.updateBoardAccess','project.pullRequests.merge','project.pullRequests.addComment','project.pullRequests.close','sync.runNow','sync.cancel','polling.queueBackfill']) {
  await assert.rejects(h.performAction(key,{companyId:'company-1',actor:{type:'user',userId:'operator'},token:'synthetic',hardening:{coordinatorAgentId:'worker'}},{companyId:'company-1',actor:{type:'agent',agentId:'worker',runId:'run',companyId:'company-1'}}),/authenticated human/,key);
 }
 const after=await h.getData('settings.registration',{companyId:'company-1'});
 assert.deepEqual(after,before);
});
test('unconfigured worker cannot write through a declared agent tool',async()=>{
 const {h}=await setup();
 const result=await h.executeTool('add_issue_comment',{repository:'paperclipai/example-repo',issueNumber:1,body:'must not publish'},{companyId:'company-1',agentId:'worker',runId:'run'});
 assert.match(result.error??'',/coordinator/);
});
test('paused scheduler and retries make no GitHub requests',async()=>{
 const {h}=await setup();
 const original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw new Error('must not call GitHub');};
 try {for(const trigger of ['schedule','retry'] as const) await h.runJob('sync.github-issues',{trigger,scheduledAt:new Date().toISOString()}); assert.equal(requests,0);}
 finally {globalThis.fetch=original;}
});
test('SDK-only manual sync needs neither a board token nor a health request',async()=>{
 const {h}=await setup();const original=globalThis.fetch;let requests=0;
 globalThis.fetch=async(input)=>{const u=new URL(input instanceof Request?input.url:String(input));requests++;assert.equal(u.hostname,'api.github.com');if(u.pathname.endsWith('/issues'))return Response.json([]);if(u.pathname==='/graphql')return Response.json({data:{repository:{issues:{nodes:[],pageInfo:{hasNextPage:false}}}}});throw new Error(`Unexpected ${u.pathname}`);};
 try {const result=await h.performAction('sync.runNow',{companyId:'company-1'},human) as {syncState:{status:string,message?:string}};assert.equal(result.syncState.status,'success',result.syncState.message);assert.ok(requests>0);}
 finally {globalThis.fetch=original;}
});
test('item budget stops oversized repository enumeration before any import',async()=>{
 const {h}=await setup({maxItemsPerSync:2});const original=globalThis.fetch;
 globalThis.fetch=async(input)=>{const u=new URL(input instanceof Request?input.url:String(input));if(u.pathname.endsWith('/issues')) return Response.json([1,2,3].map(n=>({id:n,number:n,title:`Issue ${n}`,state:'open',html_url:`https://github.com/paperclipai/example-repo/issues/${n}`,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),labels:[],user:{login:'reporter'}})));throw new Error(`Unexpected ${u.pathname}`);};
 try {const result=await h.performAction('sync.runNow',{companyId:'company-1'},human) as {syncState:{status:string}};assert.equal(result.syncState.status,'error');assert.equal((await h.ctx.issues.list({companyId:'company-1'})).length,0);}
 finally {globalThis.fetch=original;}
});


test('disabled wakeups do not queue an agent run',async()=>{
 const {h,module}=await setup();let wakes=0;
 h.ctx.issues.requestWakeup=async()=>{wakes++;return {queued:true,runId:null};};
 const queued=await module.__testing.wakePaperclipIssueAssignee(h.ctx,{companyId:'company-1',assigneeAgentId:'worker',paperclipIssueId:'issue-1',reason:'synthetic',mutation:'import'});
 assert.equal(queued,false);assert.equal(wakes,0);
});
test('permission audit does not send intentionally invalid writes in a default pilot',async()=>{
 const {h}=await setup();const original=globalThis.fetch;let writes=0;
 globalThis.fetch=async(input,init)=>{if((init?.method??'GET')!=='GET')writes++;return Response.json({default_branch:'main'});};
 try {await h.getData('settings.tokenPermissionAudit',{companyId:'company-1'});assert.equal(writes,0);}finally{globalThis.fetch=original;}
});

test('polling pilot preserves imported backlog despite linked PR execution signals',async()=>{
 const {module}=await setup({incrementalPollingEnabled:true});
 const input={currentStatus:'backlog' as const,snapshot:{state:'open',linkedPullRequests:[{lifecycleState:'open'}]},effectiveGate:{condition:'waiting'},wasImportedThisRun:true,defaultImportedStatus:'backlog' as const};
 const resolve=module.__testing.resolvePaperclipIssueStatus;
 assert.equal(resolve(input as any),'in_progress');
 assert.equal(resolve({...input,preserveImportedBacklog:true} as any),'backlog');
 assert.equal(resolve({...input,snapshot:{...input.snapshot,state:'closed'},preserveImportedBacklog:true} as any),'done');
});

test('SDK-only labeled imports preserve GitHub metadata without direct API or partial native-label changes',async()=>{
 const {h,module}=await setup();let requests=0,updates=0;
 const original=globalThis.fetch;globalThis.fetch=async()=>{requests++;throw Error('No direct API');};
 const update=h.ctx.issues.update;h.ctx.issues.update=async(...args)=>{updates++;return update(...args);};
 const issue={id:1,number:1,title:'Synthetic labeled issue',state:'open',htmlUrl:'https://github.com/paperclipai/example-repo/issues/1',body:'Synthetic body',labels:[{name:'enhancement',color:'00ff00'}],commentsCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 try {
  const result=await module.__testing.createPaperclipIssue(h.ctx,{id:'pilot',companyId:'company-1',paperclipProjectId:'project-1',paperclipProjectName:'Pilot',repositoryUrl:'https://github.com/paperclipai/example-repo'},{defaultStatus:'backlog'},issue as any,new Map(),undefined);
  assert.deepEqual(result.unresolvedGitHubLabels,[]);
  const records=await h.ctx.entities.list({entityType:'paperclip-github-plugin.issue-link'});
  assert.ok(records.some((r:any)=>r.data?.labels?.some((l:any)=>l.name==='enhancement')));
  const native=await h.ctx.issues.get(result.id,'company-1');
  updates=0;
  assert.equal(await module.__testing.synchronizePaperclipIssueLabels(h.ctx,'company-1',native!,issue as any,new Map(),undefined),false);
  assert.equal(updates,0);assert.equal(requests,0);
 } finally {globalThis.fetch=original;}
});

test('native label sync creates missing labels and honors human-only company-scoped pairings',async()=>{
 const {h,module}=await setup();const labels=[{id:'native-bug',companyId:'company-1',name:'Defect',color:'#ff0000'}];let created=0;
 const native=h.ctx.issues as any;
 native.listLabels=async(companyId:string)=>labels.filter(l=>l.companyId===companyId);
 native.ensureLabel=async(input:any)=>{created++;const label={id:`native-${created}`,...input};labels.push(label);return label;};
 await h.performAction('labels.savePairing',{companyId:'company-1',name:'BUG',labelId:'native-bug'},human);
 await assert.rejects(h.performAction('labels.savePairing',{companyId:'company-1',name:'bug',labelId:'other-company'},human),/existing label in this company/);
 await assert.rejects(h.performAction('labels.savePairing',{companyId:'company-1',name:'bug',labelId:''},{companyId:'company-1',actor:{type:'agent',agentId:'worker',runId:'run',companyId:'company-1'}}),/authenticated human/);
 const issue={id:12,number:12,title:'Synthetic paired labels',state:'open',htmlUrl:'https://github.com/paperclipai/example-repo/issues/12',body:'Synthetic body',labels:[{name:'bug',color:'ff0000'},{name:'enhancement',color:'00ff00'}],commentsCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 const result=await module.__testing.createPaperclipIssue(h.ctx,{id:'pilot',companyId:'company-1',paperclipProjectId:'project-1',paperclipProjectName:'Pilot',repositoryUrl:'https://github.com/paperclipai/example-repo'},{defaultStatus:'backlog'},issue as any,new Map(),undefined);
 assert.deepEqual(result.unresolvedGitHubLabels,[]);assert.equal(created,1);
 const saved=await h.ctx.issues.get(result.id,'company-1');
 assert.deepEqual(saved?.labelIds?.sort(),['native-1','native-bug']);
 assert.equal(await module.__testing.synchronizePaperclipIssueLabels(h.ctx,'company-1',saved!,issue as any,new Map(),undefined),false);
 assert.equal(created,1);
 const directory=await h.getData('labels.directory',{companyId:'company-1'}) as any;
 assert.ok(directory.githubLabels.includes('enhancement'));assert.deepEqual(directory.pairings,[{name:'bug',labelId:'native-bug'}]);
 const other=await h.getData('labels.directory',{companyId:'company-2'}) as any;assert.equal(other.pairings.length,0);
 await h.performAction('labels.savePairing',{companyId:'company-1',name:'bug',labelId:''},human);
 assert.deepEqual((await h.getData('labels.directory',{companyId:'company-1'}) as any).pairings,[]);
});
