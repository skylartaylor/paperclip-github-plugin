import assert from 'node:assert/strict';
import {createTestHarness} from '@paperclipai/plugin-sdk/testing';
import manifest from '../dist/manifest.js';
import plugin from '../dist/worker.js';
const h=createTestHarness({manifest,config:{githubToken:'synthetic-runtime-token'}});
await plugin.definition.setup(h.ctx);
const actor={companyId:'company-runtime',actor:{type:'user',userId:'synthetic-operator',companyId:'company-runtime'}};
await h.performAction('settings.saveRegistration',{companyId:'company-runtime',mappings:[{id:'runtime',repositoryUrl:'paperclipai/example-repo',paperclipProjectName:'Runtime',paperclipProjectId:'project-runtime',companyId:'company-runtime'}]},actor);
const original=globalThis.fetch;
let requests=0;
globalThis.fetch=async(input)=>{requests++;const u=new URL(input instanceof Request?input.url:String(input));assert.equal(u.hostname,'api.github.com');if(u.pathname.endsWith('/issues'))return Response.json([]);if(u.pathname==='/graphql')return Response.json({data:{repository:{issues:{nodes:[],pageInfo:{hasNextPage:false}}}}});throw new Error(`Unexpected synthetic request ${u.pathname}`);};
try {
 await assert.rejects(h.performAction('project.pullRequests.merge',{companyId:'company-runtime'},{companyId:'company-runtime',actor:{type:'agent',agentId:'worker',companyId:'company-runtime'}}),/authenticated human/);
 const denied=await h.executeTool('add_issue_comment',{repository:'paperclipai/example-repo',issueNumber:1,body:'synthetic'},{companyId:'company-runtime',agentId:'worker',runId:'runtime'});
 assert.match(denied.error??'',/coordinator/);
 await h.runJob('sync.github-issues',{trigger:'schedule'});
 assert.equal(requests,0);
 const result=await h.performAction('sync.runNow',{companyId:'company-runtime'},actor);
 assert.equal(result.syncState.status,'success',result.syncState.message);
 const state=await h.getData('settings.registration',{companyId:'company-runtime'});
 assert.equal(state.sdkOnlySync,true);assert.equal(state.hardening.scheduleEnabled,false);assert.equal(state.hardening.wakeupsEnabled,false);
 console.log(JSON.stringify({ok:true,node:process.version,manifestVersion:manifest.version,checks:['agent-ui-denied','unconfigured-writer-denied','scheduler-paused','sdk-only-sync','safe-defaults'],syntheticRequests:requests}));
}finally{globalThis.fetch=original;}
