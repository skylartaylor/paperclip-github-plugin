import {strict as assert} from 'node:assert';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createTestHarness} from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.ts';
import {requiresBoardAccess} from '../src/ui/board-access.ts';
import {verifyWebhook,webhookSubject} from '../src/webhook-contract.ts';
import {DeliveryQueue,createReceiver} from '../src/webhook-receiver.ts';
const secret='synthetic-webhook-secret-for-tests-only';
const sign=(raw:string)=>'sha256='+createHmac('sha256',secret).update(raw).digest('hex');
const payload=(number=1)=>JSON.stringify({repository:{full_name:'paperclipai/example-repo'},issue:{number},action:'edited'});
const upstream='http://127.0.0.1:3100/api/plugins/11111111-1111-1111-1111-111111111111/webhooks/github';
test('SDK-only board access is consistent and unknown settings fail closed',()=>{
 assert.equal(requiresBoardAccess(true,{sdkOnlySync:true}),false);
 for(const settings of [undefined,{}, {sdkOnlySync:false}])assert.equal(requiresBoardAccess(true,settings),true);
 assert.equal(requiresBoardAccess(false),false);
});
test('signature verification rejects missing, malformed and tampered payloads',()=>{
 const raw=payload();assert.equal(verifyWebhook(secret,raw,sign(raw)),true);
 for(const signature of [undefined,'sha256=no',sign(raw)+'0','SHA256='+sign(raw).slice(7)])assert.equal(verifyWebhook(secret,raw,signature),false);
 assert.equal(verifyWebhook(secret,raw+' ',sign(raw)),false);
 assert.equal(verifyWebhook('short',raw,sign(raw)),false);
 assert.throws(()=>webhookSubject('push',JSON.parse(raw)),/Unsupported/);
});
test('durable queue deduplicates delivery IDs and signed-body replays after reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ghsync-queue-'));const file=join(dir,'queue.sqlite');let q=new DeliveryQueue(file);
 try {const raw=payload();assert.equal(q.enqueue('one','issues',raw,sign(raw),100),'queued');q.close();q=new DeliveryQueue(file);
 assert.equal(q.enqueue('one','issues',raw,sign(raw),200),'duplicate');assert.equal(q.enqueue('two','issues',raw,sign(raw),200),'duplicate');
 assert.throws(()=>q.enqueue('one','issues',payload(2),sign(payload(2)),200),/collision/);assert.ok(q.next(10100));}
 finally{q.close();rmSync(dir,{recursive:true});}
});
test('coalescing preserves updates arriving during forwarding and separates CI commits',()=>{
 const q=new DeliveryQueue(':memory:');try{const raw=payload();q.enqueue('one','issues',raw,sign(raw),0);const old=q.next(10000);
 const changed=JSON.stringify({...JSON.parse(raw),action:'closed'});q.enqueue('two','issues',changed,sign(changed),11000);q.complete(old);assert.equal(q.next(21000).version,2);
 for(const [n,sha] of [[1,'a'.repeat(40)],[2,'b'.repeat(40)]]){const b=JSON.stringify({repository:{full_name:'paperclipai/example-repo'},sha});q.enqueue('ci'+n,'status',b,sign(b),0);}
 assert.equal((q.status() as any).pending,3);
 }finally{q.close();}
});
test('queue saturation does not acknowledge or deduplicate unqueued work',()=>{
 const q=new DeliveryQueue(':memory:',1);try{q.enqueue('one','issues',payload(1),sign(payload(1)),0);assert.throws(()=>q.enqueue('two','issues',payload(2),sign(payload(2)),0),/full/);q.complete(q.next(10000));assert.equal(q.enqueue('two','issues',payload(2),sign(payload(2)),0),'queued');}finally{q.close();}
});
test('failed forwards back off and retain exhausted work for operator attention',()=>{
 const q=new DeliveryQueue(':memory:',1,0);try{q.enqueue('one','issues',payload(),sign(payload()),0);for(let i=0;i<8;i++){const job=q.next(Number.MAX_SAFE_INTEGER);assert.ok(job);q.fail(job,0);}assert.equal(q.next(Number.MAX_SAFE_INTEGER),undefined);assert.equal((q.status() as any).needsAttention,1);}finally{q.close();}
});
test('receiver verifies before persistence and forwards only to fixed loopback endpoint',async()=>{
 const q=new DeliveryQueue(':memory:',2,0);let forwards=0;
 const r=createReceiver({queue:q,secret,path:'/hook',repositories:['paperclipai/example-repo'],upstream,fetcher:async(url,init)=>{forwards++;assert.equal(String(url),upstream);assert.equal(init?.body,payload());assert.equal((init?.headers as any)['x-hub-signature-256'],sign(payload()));return new Response('{}');}});
 r.server.listen(0,'127.0.0.1');await once(r.server,'listening');const address=r.server.address() as {port:number};
 const send=(raw:string,signature:string,extra:Record<string,string>={})=>fetch(`http://127.0.0.1:${address.port}/hook`,{method:'POST',headers:{'content-type':'application/json','x-github-event':'issues','x-github-delivery':'delivery-1','x-hub-signature-256':signature,...extra},body:raw});
 try{assert.equal((await send(payload(),sign(payload())+'0')).status,401);assert.equal((q.status() as any).pending,0);
 assert.equal((await send(payload(),sign(payload()))).status,202);assert.equal((await send(payload(),sign(payload()))).status,202);await r.drain();assert.equal(forwards,1);assert.equal((q.status() as any).pending,0);
 const foreign=JSON.stringify({repository:{full_name:'other/private'},issue:{number:1}});assert.equal((await send(foreign,sign(foreign))).status,403);
 assert.equal((await send(payload(),sign(payload()),{'content-type':'text/plain'})).status,415);
 assert.equal((await send('x'.repeat(2*1024*1024+1),'')).status,413);
 }finally{await new Promise<void>(resolve=>r.server.close(()=>resolve()));q.close();}
 assert.throws(()=>createReceiver({queue:q,secret,path:'/hook',repositories:[],upstream:'https://evil.example/path'}),/loopback/);
});
test('forward failure remains durable and does not leak response bodies',async()=>{
 const q=new DeliveryQueue(':memory:',1,0);try{q.enqueue('one','issues',payload(),sign(payload()));const r=createReceiver({queue:q,secret,path:'/hook',repositories:[],upstream,fetcher:async()=>new Response('synthetic private error',{status:503})});await r.drain();assert.equal((q.status() as any).pending,1);assert.equal((q.status() as any).maxAttempts,1);}finally{q.close();}
});
test('native webhook revalidates the signature and performs a targeted SDK-only issue sync',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ghsync-secret-'));const file=join(dir,'secret');writeFileSync(file,secret,{mode:0o600});
 const mod=await import(`../src/worker.ts?webhook-target-test=${Date.now()}`);
 const h=createTestHarness({manifest,config:{githubToken:'synthetic',webhooks:{enabled:true,secretFile:file}}});await mod.default.definition.setup(h.ctx);
 const actor={companyId:'company-1',actor:{type:'user' as const,userId:'operator',companyId:'company-1'}};
 await h.performAction('settings.saveRegistration',{companyId:'company-1',mappings:[{id:'pilot',repositoryUrl:'paperclipai/example-repo',paperclipProjectName:'Pilot',paperclipProjectId:'project-1',companyId:'company-1'}]},actor);
 const raw=payload();const input={endpointKey:'github',rawBody:raw,headers:{'x-github-event':'issues','x-hub-signature-256':sign(raw)},requestId:'synthetic'};
 const original=globalThis.fetch;const paths:string[]=[];
 globalThis.fetch=async(input)=>{const u=new URL(input instanceof Request?input.url:String(input));assert.equal(u.hostname,'api.github.com');paths.push(u.pathname);
 if(u.pathname.endsWith('/issues/1'))return Response.json({id:101,number:1,title:'Synthetic webhook issue',state:'open',html_url:'https://github.com/paperclipai/example-repo/issues/1',body:'Synthetic',labels:[],comments:0,user:{login:'reporter'},created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'});
 if(u.pathname.endsWith('/commits/'+'a'.repeat(40)+'/pulls'))return Response.json([{number:7}]);
 if(u.pathname.endsWith('/permission'))return Response.json({permission:'read'});
 if(u.pathname.endsWith('/comments'))return Response.json([]);
 if(u.pathname==='/graphql')return Response.json({data:{repository:{issue:{timelineItems:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
 throw Error('Unexpected path '+u.pathname);};
 try{await assert.rejects(mod.default.definition.onWebhook!({...input,rawBody:raw+' '}),/signature/);assert.equal(paths.length,0);
 await mod.default.definition.onWebhook!(input);assert.ok(paths.includes('/repos/paperclipai/example-repo/issues/1'));assert.ok(!paths.includes('/repos/paperclipai/example-repo/issues'));
 const state:any=await h.getData('settings.registration',{companyId:'company-1'});assert.equal(state.syncState.status,'success');assert.equal(state.syncState.lastRunTrigger,'webhook');assert.equal((await h.ctx.issues.list({companyId:'company-1'})).length,1);
 const links=await h.ctx.entities.list({entityType:'paperclip-github-plugin.issue-link',scopeKind:'issue',limit:10});
 const link=links[0];assert.ok(link);
 await h.ctx.entities.upsert({entityType:'paperclip-github-plugin.issue-link',scopeKind:'issue',scopeId:link.scopeId!,externalId:link.externalId!,data:{...(link.data as any),linkedPullRequestNumbers:[7]}});
 paths.length=0;
 const ci=JSON.stringify({repository:{full_name:'paperclipai/example-repo'},sha:'a'.repeat(40)});
 await mod.default.definition.onWebhook!({...input,rawBody:ci,headers:{'x-github-event':'status','x-hub-signature-256':sign(ci)}});
 assert.ok(paths.some(p=>p.endsWith('/commits/'+'a'.repeat(40)+'/pulls')));assert.ok(paths.includes('/repos/paperclipai/example-repo/issues/1'));
 const foreign=JSON.stringify({repository:{full_name:'foreign/private'},issue:{number:1}});paths.length=0;
 await assert.rejects(mod.default.definition.onWebhook!({...input,rawBody:foreign,headers:{'x-github-event':'issues','x-hub-signature-256':sign(foreign)}}),/not mapped/);assert.equal(paths.length,0);

 }finally{globalThis.fetch=original;rmSync(dir,{recursive:true});}
});
