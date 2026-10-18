import {strict as assert} from 'node:assert';
import test from 'node:test';
import {createTestHarness} from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.ts';
import {newPollState,repoState,pollTick,queueBackfill,type PollMapping,type PollState,type PollRefreshResult} from '../src/incremental-polling.ts';
const now=1_800_000_000;
const mappings:PollMapping[]=Array.from({length:16},(_,n)=>({key:`company:repo${n}`,repository:`owner/repo${n}`}));
const row=(n:number,at=now-10)=>({number:n,updated_at:new Date(at*1000).toISOString()});
function harness(state=newPollState(),map=mappings) {
 const saves:PollState[]=[];const refreshed:number[]=[];const calls:any[]=[];
 return {state,saves,refreshed,calls,options:{state,mappings:map,now,admitted:()=>true,save:async()=>{saves.push(structuredClone(state));},fetch:async(m:PollMapping,q:any)=>{calls.push({m,q});return {status:200,headers:{etag:'"synthetic"'},data:[] as unknown[]};},refresh:async(_m:PollMapping,i:{number:number},_budget?:number):Promise<void|number|PollRefreshResult>=>{refreshed.push(i.number);}}};
}
test('discovery has a shared eight-request budget and staggered stable conditional URLs',async()=>{
 const h=harness();const first=await pollTick(h.options);assert.equal(first.reads,8);assert.equal(h.calls.length,8);
 assert.ok(h.calls.every(c=>c.q.per_page===100 && !c.q.since));
 await pollTick(h.options);assert.equal(new Set(h.calls.map(c=>c.m.key)).size,16);
 h.options.now+=120;await pollTick(h.options);assert.equal(h.calls.length,24);assert.ok(h.calls.slice(16).every(c=>c.q.per_page===100 && c.q.etag==='"synthetic"')); 
});
test('unchanged conditional responses do not refresh tasks or fetch ranges',async()=>{
 const h=harness(newPollState(),mappings.slice(0,1));const repo=repoState(h.state,mappings[0].key,now);repo.etag='"known"';
 h.options.fetch=async(_m,q)=>{assert.equal(q.etag,'"known"');return {status:304,headers:{etag:'"known"'},data:[]};};
 const result=await pollTick(h.options);assert.equal(result.reads,1);assert.equal(result.refreshed,0);assert.equal(repo.ranges.length,0);assert.equal(repo.nextPollAt,now+120);
});
test('busy host and global backoff make zero network calls or task mutations',async()=>{
 const h=harness();h.options.admitted=()=>false;assert.equal((await pollTick(h.options)).paused,true);assert.equal(h.calls.length,0);
 assert.equal(h.state.repos[mappings[0].key].watermark,now-120);
 h.options.now+=3600;await pollTick(h.options);assert.equal(h.state.repos[mappings[0].key].watermark,now-120);
 h.options.admitted=()=>true;h.state.backoffUntil=h.options.now+60;await pollTick(h.options);assert.equal(h.calls.length,0);assert.equal(h.refreshed.length,0);
});
test('backfills are human-bounded and work is fair, five subjects per tick',async()=>{
 const h=harness();for(const m of mappings)queueBackfill(h.state,m.key,[1,2,3,4,5],now);
 assert.throws(()=>queueBackfill(h.state,mappings[0].key,Array.from({length:26},(_,n)=>n+1),now),/1–25/);
 assert.throws(()=>queueBackfill(h.state,mappings[0].key,[0],now),/1–25/);
 const result=await pollTick(h.options);assert.equal(result.refreshed,5);
 assert.equal(Object.values(h.state.repos).filter(r=>r.backfill.length===4).length,5);
 await pollTick(h.options);assert.equal(Object.values(h.state.repos).filter(r=>r.backfill.length===4).length,10);
});
test('work is persisted before refresh and failures survive a restart without advancing the window',async()=>{
 const h=harness(newPollState(),mappings.slice(0,1));const repo=repoState(h.state,mappings[0].key,now);
 repo.ranges=[{from:now-60,to:now}];const old=repo.watermark;
 h.options.fetch=async()=>({status:200,headers:{etag:'"s"'},data:[row(7)]});
 h.options.refresh=async()=>{assert.equal(h.saves.at(-1)!.repos[mappings[0].key].pending[0].number,7);throw new Error('synthetic failure');};
 await pollTick(h.options);assert.equal(repo.watermark,old);assert.equal(repo.pending[0].number,7);assert.equal(repo.failures,1);
 const resumed=harness(structuredClone(h.state),mappings.slice(0,1));resumed.options.now+=120;
 await pollTick(resumed.options);assert.deepEqual(resumed.refreshed,[7]);assert.equal(resumed.state.repos[mappings[0].key].watermark,now);
});
test('busy windows are split without paging a moving list; same-second overflow retains its checkpoint',async()=>{
 const h=harness(newPollState(),mappings.slice(0,1));const repo=repoState(h.state,mappings[0].key,now);repo.ranges=[{from:now-60,to:now}];
 h.options.fetch=async()=>({status:200,headers:{etag:'"s"'},data:Array.from({length:100},(_,n)=>row(n+1))});
 await pollTick(h.options);assert.equal(repo.ranges.length,2);assert.equal(repo.pending.length,0);assert.equal(h.refreshed.length,0);
 repo.ranges=[{from:now-10,to:now-10}];await pollTick(h.options);assert.match(repo.error!,/operator catch-up/);assert.equal(repo.ranges.length,1);assert.equal(repo.nextPollAt,now+3600);
});
test('rate limits pause every repository and retain the failed range',async()=>{
 const h=harness();const r=repoState(h.state,mappings[0].key,now);r.ranges=[{from:now-60,to:now}];
 h.options.fetch=async()=>{throw {status:429,response:{headers:{'retry-after':'300','x-ratelimit-reset':String(now+600)}}};};
 const result=await pollTick(h.options);assert.equal(result.reads,1);assert.equal(h.state.backoffUntil,now+600);assert.equal(r.ranges.length,1);assert.equal(result.refreshed,0);
});
test('overlapping windows dedupe metadata while same-second content edits and PR subjects are retained',async()=>{
 const h=harness(newPollState(),mappings.slice(0,1));const r=repoState(h.state,mappings[0].key,now);r.ranges=[{from:now-60,to:now}];
 h.options.fetch=async()=>({status:200,headers:{etag:'"s"'},data:[row(1)]});
 await pollTick(h.options);assert.deepEqual(h.refreshed,[1]);
 r.ranges=[{from:now-60,to:now}];
 h.options.fetch=async()=>({status:200,headers:{etag:'"s"'},data:[row(1),{...row(2),pull_request:{}}]});
 let pr=false;h.options.refresh=async(_m,i)=>{pr=(i as any).pullRequest;};await pollTick(h.options);assert.equal(pr,true);assert.equal(r.pending.length,0);
 r.ranges=[{from:now-60,to:now}];h.options.fetch=async()=>({status:200,headers:{etag:'"s"'},data:[{...row(1),title:'changed within the same second'}]});
 let changed=false;h.options.refresh=async()=>{changed=true;};await pollTick(h.options);assert.equal(changed,true);
});
test('future metadata is not cached as processed and low API budget pauses task work',async()=>{
 const h=harness(newPollState(),mappings.slice(0,1));
 h.options.fetch=async()=>({status:200,headers:{etag:'"future"'},data:[row(1,now+1)]});await pollTick(h.options);
 assert.equal(h.state.repos[mappings[0].key].etag,undefined);assert.equal(h.refreshed.length,0);
 const low=harness(newPollState(),mappings.slice(0,1));queueBackfill(low.state,mappings[0].key,[1],now);
 low.options.fetch=async()=>({status:200,headers:{etag:'"low"','x-ratelimit-remaining':'499','x-ratelimit-reset':String(now+3600)},data:[]});
 await pollTick(low.options);assert.equal(low.refreshed.length,0);assert.equal(low.state.backoffUntil,now+3600);
});
test('worker imports a queued exact issue with SDK-only defaults, no webhook secret and no agent wakeup',async()=>{
 const mod=await import(`../src/worker.ts?poll-integration=${Date.now()}`);
 const h=createTestHarness({manifest,config:{githubToken:'synthetic',hardening:{incrementalPollingEnabled:true}}});
 await mod.default.definition.setup(h.ctx);
 const actor={companyId:'company-1',actor:{type:'user' as const,userId:'operator',companyId:'company-1'}};
 await h.performAction('settings.saveRegistration',{companyId:'company-1',mappings:[{id:'one',repositoryUrl:'paperclipai/example-repo',paperclipProjectName:'Pilot',paperclipProjectId:'project-1',companyId:'company-1'}]},actor);
 await assert.rejects(h.performAction('polling.queueBackfill',{companyId:'company-1',repositoryUrl:'foreign/other',numbers:[1]},actor),/not mapped/);
 await h.performAction('polling.queueBackfill',{companyId:'company-1',repositoryUrl:'paperclipai/example-repo',numbers:[7]},actor);
 const original=globalThis.fetch;let wakes=0;const paths:string[]=[];
 h.ctx.issues.requestWakeup=async()=>{wakes++;return {queued:true,runId:null};};
 globalThis.fetch=async(input,init)=>{
  const u=new URL(input instanceof Request?input.url:String(input));assert.equal(u.hostname,'api.github.com');paths.push(u.pathname);
  assert.ok((init?.method??(input instanceof Request?input.method:'GET'))==='GET' || u.pathname==='/graphql');
  if(u.pathname.endsWith('/issues'))return Response.json([],{headers:{etag:'"synthetic"'}});
  if(u.pathname.endsWith('/issues/7'))return Response.json({id:107,number:7,title:'Synthetic imported issue',state:'open',html_url:'https://github.com/paperclipai/example-repo/issues/7',body:'Synthetic',labels:[],comments:0,user:{login:'reporter'},created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'});
  if(u.pathname.endsWith('/permission'))return Response.json({permission:'read'});
  if(u.pathname.endsWith('/comments'))return Response.json([]);
  if(u.pathname==='/graphql')return Response.json({data:{repository:{issue:{timelineItems:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
  throw new Error('Unexpected API '+u.pathname);
 };
 try {
  await mod.__testing.runIncrementalPolling(h.ctx,()=>false);assert.equal(paths.length,0);
  await mod.__testing.runIncrementalPolling(h.ctx,()=>true);
  assert.ok(paths.includes('/repos/paperclipai/example-repo/issues/7'));assert.equal(wakes,0);
  const issues=await h.ctx.issues.list({companyId:'company-1'});assert.equal(issues.length,1);assert.equal(issues[0].status,'backlog');assert.ok(!issues[0].assigneeAgentId);
  const status:any=await h.getData('polling.status',{companyId:'company-1'});const diagnostic:any=await h.getData('settings.registration',{companyId:'company-1'});assert.equal(status.repositories[0].backfill,0,JSON.stringify(diagnostic.syncState));
  const settings:any=await h.getData('settings.registration',{companyId:'company-1'});assert.equal(settings.syncState.lastRunTrigger,'poll');
 } finally {globalThis.fetch=original;}
});
test('an action cannot opt into polling by supplying a policy or an unmapped repository',async()=>{
 const mod=await import(`../src/worker.ts?poll-denied=${Date.now()}`);
 const h=createTestHarness({manifest,config:{githubToken:'synthetic'}});await mod.default.definition.setup(h.ctx);
 await assert.rejects(h.performAction('polling.queueBackfill',{companyId:'company-1',repositoryUrl:'paperclipai/example-repo',numbers:[1],hardening:{incrementalPollingEnabled:true}},{companyId:'company-1',actor:{type:'user',userId:'operator',companyId:'company-1'}}),/not mapped/);
});
test('multiple linked targets consume the shared budget before another subject starts',async()=>{
 const h=harness();for(const m of mappings)queueBackfill(h.state,m.key,[1],now);
 const budgets:number[]=[];h.options.refresh=async(_m,_i,budget?:number)=>{budgets.push(budget!);return Math.min(3,budget!);};
 const result=await pollTick(h.options);assert.equal(result.refreshed,5);assert.deepEqual(budgets,[5,2]);
});
test('partial PR work survives restart and advances the window only after its final targets',async()=>{
 const h=harness(newPollState(),mappings.slice(0,1));const r=repoState(h.state,mappings[0].key,now);
 const old=r.watermark;r.ranges=[{from:now-60,to:now}];r.pending=[{number:99,updated:now-10,pullRequest:true}];
 h.options.refresh=async()=>({workCount:5,complete:false,remaining:['issue:6']});
 const first=await pollTick(h.options);assert.equal(first.refreshed,5);assert.equal(r.watermark,old);assert.deepEqual(r.pending[0].remaining,['issue:6']);
 const resumed=harness(structuredClone(h.state),mappings.slice(0,1));
 resumed.options.refresh=async(_m,item)=>{assert.deepEqual((item as any).remaining,['issue:6']);return {workCount:1,complete:true,remaining:[]};};
 await pollTick(resumed.options);assert.equal(resumed.state.repos[mappings[0].key].watermark,now);assert.equal(resumed.state.repos[mappings[0].key].pending.length,0);
});
test('worker chunks a six-issue PR fan-out using stable scoped target identities',async()=>{
 const mod=await import(`../src/worker.ts?poll-fanout=${Date.now()}`);
 const h=createTestHarness({manifest,config:{githubToken:'synthetic',hardening:{incrementalPollingEnabled:true}}});await mod.default.definition.setup(h.ctx);
 const mapping={id:'one',repositoryUrl:'paperclipai/example-repo',paperclipProjectName:'Pilot',paperclipProjectId:'project-1',companyId:'company-1'};
 const actor={companyId:'company-1',actor:{type:'user' as const,userId:'operator',companyId:'company-1'}};
 await h.performAction('settings.saveRegistration',{companyId:'company-1',mappings:[mapping]},actor);
 const original=globalThis.fetch;const refreshed:number[]=[];
 globalThis.fetch=async input=>{
  const url=new URL(input instanceof Request?input.url:String(input));const n=Number(url.pathname.match(/\/issues\/(\d+)$/)?.[1]);
  if(n){refreshed.push(n);return Response.json({id:100+n,number:n,title:'Synthetic '+n,state:'open',html_url:'https://github.com/paperclipai/example-repo/issues/'+n,body:'Synthetic',labels:[],comments:0,user:{login:'reporter'},created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'});}
  if(url.pathname.endsWith('/permission'))return Response.json({permission:'read'});
  if(url.pathname.endsWith('/comments'))return Response.json([]);
  if(url.pathname==='/graphql')return Response.json({data:{repository:{issue:{timelineItems:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
  throw Error('Unexpected API '+url.pathname);
 };
 try {
  for(let n=1;n<=6;n++)await mod.__testing.syncMappedGitHubSubject(h.ctx,mapping,{repository:{full_name:'paperclipai/example-repo'},issue:{number:n}},'issues','poll');
  const links=await h.ctx.entities.list({entityType:'paperclip-github-plugin.issue-link',scopeKind:'issue',limit:20});assert.equal(links.length,6);
  for(const link of links)await h.ctx.entities.upsert({entityType:'paperclip-github-plugin.issue-link',scopeKind:'issue',scopeId:link.scopeId!,externalId:link.externalId!,data:{...(link.data as any),linkedPullRequestNumbers:[99]}});
  refreshed.length=0;const body={repository:{full_name:'paperclipai/example-repo'},pull_request:{number:99}};
  const first=await mod.__testing.syncMappedGitHubSubject(h.ctx,mapping,body,'pull_request','poll',5);
  assert.equal(first.workCount,5);assert.equal(first.complete,false);assert.equal(first.remaining.length,1);
  const second=await mod.__testing.syncMappedGitHubSubject(h.ctx,mapping,body,'pull_request','poll',5,first.remaining);
  assert.equal(second.workCount,1);assert.equal(second.complete,true);assert.equal(new Set(refreshed).size,6);assert.equal(refreshed.length,6);
 } finally {globalThis.fetch=original;}
});
test('an explicit poll interval and historical baseline do not create an unbounded import',async()=>{
 const h=harness(newPollState(),mappings.slice(0,1));
 h.options.fetch=async()=>({status:200,headers:{etag:'"old"','x-poll-interval':'500'},data:[row(1,now-1000)]});
 await pollTick(h.options);assert.equal(h.refreshed.length,0);h.options.now+=120;
 assert.equal((await pollTick(h.options)).reads,0);
});
test('polling rejects configurations that could automatically assign or wake agents',async()=>{
 for(const wakeupsEnabled of [true,false]) {
  const mod=await import(`../src/worker.ts?poll-routing-${wakeupsEnabled}-${Date.now()}`);
  const h=createTestHarness({manifest,config:{githubToken:'synthetic',hardening:{incrementalPollingEnabled:true,wakeupsEnabled}}});await mod.default.definition.setup(h.ctx);
  const actor={companyId:'company-1',actor:{type:'user' as const,userId:'operator',companyId:'company-1'}};
  await h.performAction('settings.saveRegistration',{companyId:'company-1',mappings:[{id:'one',repositoryUrl:'paperclipai/example-repo',paperclipProjectName:'Pilot',paperclipProjectId:'project-1',companyId:'company-1'}],...(!wakeupsEnabled?{advancedSettings:{defaultAssigneeAgentId:'worker'}}:{})},actor);
  await assert.rejects(h.performAction('polling.queueBackfill',{companyId:'company-1',repositoryUrl:'paperclipai/example-repo',numbers:[1]},actor),/disabled wakeups and no automatic agent/);
 }
});
