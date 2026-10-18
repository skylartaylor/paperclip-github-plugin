import {strict as assert} from 'node:assert';
import test from 'node:test';
import {createTestHarness} from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.ts';
const sha='a'.repeat(40),other='b'.repeat(40);
let serial=0;
async function scenario(options:{expected?:string,head?:string,ciHead?:string,review?:string,unresolved?:boolean,race?:boolean}={}) {
 const worker=await import(`../src/worker.ts?merge-hardening=${++serial}`) as typeof import('../src/worker.ts');
 const h=createTestHarness({manifest,config:{githubToken:'synthetic-token'}});
 await worker.default.definition.setup(h.ctx);
 const actor={companyId:'company-1',actor:{type:'user' as const,userId:'operator',companyId:'company-1'}};
 await h.performAction('settings.saveRegistration',{companyId:'company-1',mappings:[{id:'pilot',repositoryUrl:'paperclipai/example-repo',paperclipProjectName:'Pilot',paperclipProjectId:'project-1',companyId:'company-1'}]},actor);
 // Pretend the dashboard loaded an old green review and resolved thread state.
 const repo={url:'https://github.com/paperclipai/example-repo',owner:'paperclipai',repo:'example-repo'};
 worker.__testing.cacheGitHubPullRequestReviewSummary(repo,42,{approvals:1,changesRequested:0});
 worker.__testing.cacheGitHubPullRequestReviewThreadSummary(repo,42,{unresolvedReviewThreads:0,copilotUnresolvedReviewThreads:0});
 let mergeRequests=0;const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(input instanceof Request?input.url:String(input));const method=init?.method??'GET';
  if(u.pathname.endsWith('/pulls/42')&&method==='GET') return Response.json({number:42,title:'Synthetic change',state:'open',merged:false,mergeable:true,base:{ref:'main'},head:{ref:'feature/test',sha:options.head??sha}});
  if(u.pathname.endsWith('/pulls/42/reviews')) return Response.json([{state:options.review??'APPROVED',user:{login:'reviewer'}}]);
  if(u.pathname==='/repos/paperclipai/example-repo')return Response.json({default_branch:'main'});
  if(u.pathname==='/graphql') {
   const raw=String(init?.body??'');
   if(raw.includes('GitHubPullRequestReviewThreadsDetailed'))return Response.json({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:options.unresolved?[{id:'thread',isResolved:false,isOutdated:false,comments:{totalCount:1,nodes:[{id:'comment',body:'Fix this',author:{login:'reviewer'}}]}}]:[]}}}}});
   if(raw.includes('GitHubPullRequestCiContexts'))return Response.json({data:{repository:{pullRequest:{headRefOid:options.ciHead??sha,statusCheckRollup:{contexts:{pageInfo:{hasNextPage:false},nodes:[{__typename:'CheckRun',status:'COMPLETED',conclusion:'SUCCESS'}]}}}}}});
  }
  if(u.pathname.endsWith('/pulls/42/merge')){
   mergeRequests++;assert.deepEqual(JSON.parse(String(init?.body)),{sha,merge_method:'squash'});
   if(options.race)return Response.json({message:'Head branch was modified'},{status:409});
   return Response.json({merged:true,sha:'c'.repeat(40)});
  }
  throw new Error(`Unexpected synthetic request ${method} ${u.pathname}`);
 };
 let result:unknown,error:unknown;
 try {result=await h.performAction('project.pullRequests.merge',{companyId:'company-1',projectId:'project-1',pullRequestNumber:42,expectedHeadSha:options.expected},actor);}
 catch(e){error=e;}finally{globalThis.fetch=original;}
 return {result,error,mergeRequests};
}
test('merge rejects missing approval head before GitHub reads or writes',async()=>{const x=await scenario();assert.match(String(x.error),/expectedHeadSha/);assert.equal(x.mergeRequests,0);});
test('merge rejects changed head',async()=>{const x=await scenario({expected:sha,head:other});assert.match(String(x.error),/head changed/);assert.equal(x.mergeRequests,0);});
test('merge rejects CI for a different head',async()=>{const x=await scenario({expected:sha,ciHead:other});assert.match(String(x.error),/CI evidence/);assert.equal(x.mergeRequests,0);});
test('merge ignores cached approval and rejects fresh changes requested',async()=>{const x=await scenario({expected:sha,review:'CHANGES_REQUESTED'});assert.match(String(x.error),/not mergeable/);assert.equal(x.mergeRequests,0);});
test('merge ignores cached resolved threads and rejects a fresh unresolved thread',async()=>{const x=await scenario({expected:sha,unresolved:true});assert.match(String(x.error),/not mergeable/);assert.equal(x.mergeRequests,0);});
test('merge sends the exact approved head and squash method',async()=>{const x=await scenario({expected:sha});assert.equal(x.error,undefined);assert.equal(x.mergeRequests,1);assert.equal((x.result as {status:string}).status,'merged');});
test('merge propagates a GitHub race rejection without retrying a newer head',async()=>{const x=await scenario({expected:sha,race:true});assert.ok(x.error);assert.equal(x.mergeRequests,1);});
