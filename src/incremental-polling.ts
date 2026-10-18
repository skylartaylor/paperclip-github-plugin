/** Bounded metadata discovery and durable exact-item work; never enumerates an old backlog. */
import {createHash} from 'node:crypto';
export type PollItem = {number:number; updated:number; pullRequest:boolean; revision?:string; remaining?:string[]};
export type PollRefreshResult = {workCount:number; complete:boolean; remaining:string[]};
type Range = {from:number; to:number};
export type RepoPollState = {
  watermark:number; nextPollAt:number; etag?:string; ranges:Range[]; pending:PollItem[];
  seen:string[]; backfill:number[]; failures:number; error?:string;
};
export type PollState = {version:1; cursor:number; workCursor:number; backoffUntil:number; repos:Record<string,RepoPollState>};
export type PollMapping = {key:string; repository:string};
type Response = {status:number; headers:Record<string,string|undefined>; data:unknown[]};
export const newPollState = ():PollState => ({version:1,cursor:0,workCursor:0,backoffUntil:0,repos:{}});
export function readPollState(value:unknown):PollState {
  if (!value || typeof value!=='object' || (value as PollState).version!==1) return newPollState();
  const state=value as PollState;
  if (!state.repos || !Number.isSafeInteger(state.cursor) || !Number.isSafeInteger(state.workCursor)) throw new Error('Invalid polling checkpoint; operator repair required');
  return state;
}
export function repoState(state:PollState,key:string,now:number):RepoPollState {
  return state.repos[key] ??= {watermark:now-120,nextPollAt:0,ranges:[],pending:[],seen:[],backfill:[],failures:0};
}
export function queueBackfill(state:PollState,key:string,numbers:unknown,now:number):number {
  if (!Array.isArray(numbers) || numbers.length<1 || numbers.length>25 || numbers.some(n=>!Number.isSafeInteger(n)||n<1)) throw new Error('Backfill requires 1–25 positive issue numbers');
  const repo=repoState(state,key,now);
  const combined=[...new Set([...repo.backfill,...numbers as number[]])];
  if (combined.length>25) throw new Error('Repository backfill queue is limited to 25 issues');
  repo.backfill=combined;return combined.length;
}
function finishRange(repo:RepoPollState):void {
  const range=repo.ranges.shift();
  if (range) repo.watermark=Math.max(repo.watermark,range.to);
}
function fingerprint(item:PollItem):string {return `${item.pullRequest?'pr':'issue'}:${item.number}:${item.revision??item.updated}`;}
function metadata(values:unknown[]):PollItem[] {
  if(!Array.isArray(values) || values.length>100) throw new Error('Oversized GitHub metadata page');
  return values.map(value=>{
    const item=value as {number:number;updated_at:string;pull_request?:unknown};
    const updated=Math.floor(Date.parse(item.updated_at)/1000);
    if(!Number.isSafeInteger(item.number)||item.number<1||!Number.isFinite(updated)) throw new Error('Malformed GitHub polling metadata');
    return {number:item.number,updated,pullRequest:Boolean(item.pull_request),revision:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
  });
}
function remember(repo:RepoPollState,item:PollItem):void {repo.seen=[...repo.seen.filter(s=>s!==fingerprint(item)),fingerprint(item)].slice(-2000);}
function rateBudget(state:PollState,headers:Record<string,string|undefined>,now:number):void {
  if(headers['x-ratelimit-remaining']!==undefined && Number(headers['x-ratelimit-remaining'])<500) state.backoffUntil=Math.max(now+60,Number(headers['x-ratelimit-reset'])||now+3600);
}
function errorBackoff(state:PollState,repo:RepoPollState,error:unknown,now:number):void {
  const err=error as {status?:number;response?:{headers?:Record<string,string|undefined>}};
  const headers=err?.response?.headers??{};
  const retry=Number(headers['retry-after']);const reset=Number(headers['x-ratelimit-reset']);
  if (err?.status===403 || err?.status===429) {
    state.backoffUntil=Math.max(now+60,Number.isFinite(retry)?now+retry:0,Number.isFinite(reset)?reset:0);
    repo.error='GitHub rejected a poll; paused for rate limit or permission review';
  } else repo.error='Polling work failed; retained for retry';
  repo.failures++;repo.nextPollAt=now+Math.min(3600,60*2**Math.min(repo.failures-1,6));
}
export async function pollTick(options:{
  state:PollState; mappings:PollMapping[]; now:number; admitted:()=>boolean;
  save:()=>Promise<void>;
  fetch:(mapping:PollMapping,query:{since?:string;sort:'updated';direction:'asc'|'desc';per_page:number;etag?:string})=>Promise<Response>;
  refresh:(mapping:PollMapping,item:PollItem,remainingBudget:number)=>Promise<void|number|PollRefreshResult>;
}):Promise<{reads:number; refreshed:number; paused:boolean}> {
  const {state,mappings,now,save}=options;
  const stats={reads:0,refreshed:0,paused:false};
  // Establish the observation boundary even while CPU admission is paused, so
  // changes made during a long busy period remain eligible when work resumes.
  for(const mapping of mappings) repoState(state,mapping.key,now);
  if(mappings.length) await save();
  if (!mappings.length || now<state.backoffUntil || !options.admitted()) return {...stats,paused:true};
  for(let i=0;i<Math.min(8,mappings.length);i++) {
    if (!options.admitted() || now<state.backoffUntil) {stats.paused=true;break;}
    const mapping=mappings[state.cursor++%mappings.length];
    const repo=repoState(state,mapping.key,now);
    await save();
    if (repo.pending.length || now<repo.nextPollAt) continue;
    try {
      if (!repo.ranges.length) {
        // A stable request URL makes unchanged repositories cheap conditional reads.
        stats.reads++;
        const response=await options.fetch(mapping,{sort:'updated',direction:'desc',per_page:100,etag:repo.etag});
        rateBudget(state,response.headers,now);
        repo.nextPollAt=now+Math.max(120,Number(response.headers['x-poll-interval'])||0);
        if(response.status===304) {repo.watermark=Math.max(repo.watermark,now-120);repo.error=undefined;repo.failures=0;await save();continue;}
        if(response.status!==200) throw new Error('Unexpected polling status');
        repo.etag=response.headers.etag;
        repo.ranges=[{from:Math.max(0,repo.watermark-120),to:now}];
        const items=metadata(response.data);
        // If the request crosses a clock second, don't cache an unprocessed future item.
        if(items.some(item=>item.updated>now)) repo.etag=undefined;
        const range=repo.ranges[0];
        // The common case is complete in one conditional page. Dense windows use
        // ascending time partitions on later ticks, without moving-list pagination.
        if(items.length<100 || items.some(item=>item.updated<range.from)) {
          repo.pending=items.filter(item=>item.updated>=range.from && item.updated<=range.to && !repo.seen.includes(fingerprint(item)));
          if(!repo.pending.length) finishRange(repo);
        }
        // Respect an explicit GitHub poll interval even when a dense window needs work.
        repo.nextPollAt=now+Math.max(120,Number(response.headers['x-poll-interval'])||0);
        await save();continue;
      }
      const range=repo.ranges[0];stats.reads++;
      const response=await options.fetch(mapping,{sort:'updated',direction:'asc',per_page:100,since:new Date(Math.max(0,range.from-1)*1000).toISOString()});
      if(response.status!==200) throw new Error('Unexpected polling status');
      rateBudget(state,response.headers,now);
      const items=metadata(response.data).filter(item=>item.updated>=range.from && item.updated<=range.to);
      // Split busy time windows rather than paging a moving list or skipping the overflow.
      if (items.length===100) {
        if(range.from===range.to) {
          repo.error='100 or more changes in one second; checkpoint retained for operator catch-up';repo.nextPollAt=now+3600;
        } else {
          const middle=Math.floor((range.from+range.to)/2);
          repo.ranges.splice(0,1,{from:range.from,to:middle},{from:middle+1,to:range.to});
          repo.nextPollAt=now;
        }
      } else {
        repo.pending=items.filter(item=>!repo.seen.includes(fingerprint(item)));
        if(!repo.pending.length) finishRange(repo);
        repo.error=undefined;repo.failures=0;
      }
      await save();
    } catch(error) {errorBackoff(state,repo,error,now);await save();}
  }
  // Separate round-robin cursor prevents a busy repository starving the others.
  for(let i=0;i<mappings.length && stats.refreshed<5;i++) {
    if(!options.admitted() || now<state.backoffUntil) {stats.paused=true;break;}
    const mapping=mappings[state.workCursor++%mappings.length];const repo=repoState(state,mapping.key,now);
    if(repo.nextPollAt>now && repo.failures>0) continue;
    const item=repo.pending[0] ?? (repo.backfill.length?{number:repo.backfill[0],updated:0,pullRequest:false}:undefined);
    if(!item) continue;
    try {
      // Persist before the operation. A crash afterwards safely repeats an idempotent sync.
      await save();const refreshed=await options.refresh(mapping,item,5-stats.refreshed);
      const result=typeof refreshed==='object'?refreshed:{workCount:refreshed??1,complete:true,remaining:[]};
      stats.refreshed+=Math.max(1,result.workCount);
      if(!result.complete) {
        if(!repo.pending.length || !result.remaining.length) throw new Error('Invalid polling continuation');
        repo.pending[0]={...item,remaining:result.remaining};
        repo.failures=0;repo.error=undefined;await save();continue;
      }
      if(repo.pending.length) {repo.pending.shift();remember(repo,item);if(!repo.pending.length) finishRange(repo);}
      else repo.backfill.shift();
      repo.failures=0;repo.error=undefined;await save();
    } catch(error) {errorBackoff(state,repo,error,now);await save();}
  }
  await save();return stats;
}
