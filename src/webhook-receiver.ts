import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {verifyWebhook, webhookSubject} from './webhook-contract.ts';

export class DeliveryQueue {
  readonly db: DatabaseSync;
  constructor(path: string, readonly limit=100, readonly delayMs=10_000) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, received INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(key TEXT PRIMARY KEY, body TEXT NOT NULL, event TEXT NOT NULL, signature TEXT NOT NULL, delivery TEXT NOT NULL, version INTEGER NOT NULL, first_seen INTEGER NOT NULL, due INTEGER, attempts INTEGER NOT NULL DEFAULT 0);`);
  }
  enqueue(id:string, event:string, body:string, signature:string, now=Date.now()): 'queued'|'duplicate' {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error('Invalid delivery ID');
    const subject=webhookSubject(event,JSON.parse(body));
    const payload=JSON.parse(body);
    const sha=payload.sha??payload.check_run?.head_sha??payload.check_suite?.head_sha;
    const key=`${subject.repository}:${subject.issueNumber ? `issue:${subject.issueNumber}` : subject.pullRequestNumber ? `pr:${subject.pullRequestNumber}` : event==='ping' ? 'ping' : `ci:${typeof sha==='string'&&/^[a-f0-9]{40}$/i.test(sha)?sha:'unknown'}`}`;
    const digest=createHash('sha256').update(event).update('\0').update(body).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM deliveries WHERE received < ?').run(now-7*86400_000);
      const seen=this.db.prepare('SELECT digest FROM deliveries WHERE id=?').get(id);
      if (seen && seen.digest !== digest) throw new Error('Delivery ID collision');
      if (seen || this.db.prepare('SELECT id FROM deliveries WHERE digest=?').get(digest)) {this.db.exec('COMMIT');return 'duplicate';}
      if (Number(this.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n)>=100_000) throw new Error('Delivery history full');
      const old=this.db.prepare('SELECT * FROM jobs WHERE key=?').get(key);
      if (!old && Number(this.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n)>=this.limit) throw new Error('Queue full');
      const due=Math.min(Number(old?.first_seen??now)+30_000,now+this.delayMs);
      this.db.prepare(`INSERT INTO jobs(key,body,event,signature,delivery,version,first_seen,due) VALUES(?,?,?,?,?,1,?,?)
        ON CONFLICT(key) DO UPDATE SET body=excluded.body,event=excluded.event,signature=excluded.signature,delivery=excluded.delivery,version=jobs.version+1,due=excluded.due,attempts=0`).run(key,body,event,signature,id,now,due);
      this.db.prepare('INSERT INTO deliveries VALUES(?,?,?)').run(id,digest,now);
      this.db.exec('COMMIT');return 'queued';
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  next(now=Date.now()): any {return this.db.prepare('SELECT * FROM jobs WHERE due IS NOT NULL AND due<=? ORDER BY due LIMIT 1').get(now);}
  complete(job:any):void {this.db.prepare('DELETE FROM jobs WHERE key=? AND version=?').run(job.key,job.version);}
  fail(job:any,now=Date.now()):void {
    const attempts=job.attempts+1;
    this.db.prepare('UPDATE jobs SET attempts=?,due=? WHERE key=? AND version=?').run(attempts,attempts>=8?null:now+Math.min(3600,60*2**job.attempts)*1000,job.key,job.version);
  }
  status():unknown {return this.db.prepare('SELECT count(*) AS pending, sum(CASE WHEN due IS NULL THEN 1 ELSE 0 END) AS needsAttention, max(attempts) AS maxAttempts FROM jobs').get();}
  close():void {this.db.close();}
}

export function createReceiver(options:{queue:DeliveryQueue; secret:string; path:string; repositories:string[]; upstream:string; fetcher?:typeof fetch; maxBytes?:number}) {
  const upstream=new URL(options.upstream);
  if (upstream.username || upstream.password || upstream.search || upstream.hash || upstream.protocol!=='http:' || upstream.hostname!=='127.0.0.1' || upstream.port!=='3100' || !/^\/api\/plugins\/[a-f0-9-]+\/webhooks\/github$/.test(upstream.pathname)) throw new Error('Invalid loopback upstream');
  if (options.secret.length<32) throw new Error('Webhook secret must contain at least 32 characters');
  const repositories=new Set(options.repositories.map(r=>r.toLowerCase()));
  let accepting=0, busy=false;
  const server=createServer(async(req,res)=>{
    const send=(status:number)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({accepted:status===202}));};
    if(req.method!=='POST'||req.url!==options.path){send(404);return;}
    if(accepting>=8){send(503);req.resume();return;}
    accepting++;
    try {
      if(req.headers['content-type']?.split(';')[0]!=='application/json'){send(415);req.resume();return;}
      const max=options.maxBytes??2*1024*1024;
      if(Number(req.headers['content-length'])>max){send(413);req.resume();return;}
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>max){send(413);req.resume();return;}chunks.push(chunk);}
      const raw=Buffer.concat(chunks);
      if(!verifyWebhook(options.secret,raw,req.headers['x-hub-signature-256'])){send(401);return;}
      const body=new TextDecoder('utf-8',{fatal:true}).decode(raw);
      const event=String(req.headers['x-github-event']??'');
      const subject=webhookSubject(event,JSON.parse(body));
      if(!repositories.has(subject.repository)){send(403);return;}
      options.queue.enqueue(String(req.headers['x-github-delivery']??''),event,body,String(req.headers['x-hub-signature-256']));
      send(202);
    }catch(error){send(error instanceof Error && /full/.test(error.message)?503:400);}
    finally{accepting--;}
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;server.maxConnections=16;
  server.setTimeout(10_000,socket=>socket.destroy());
  async function drain():Promise<void> {
    if(busy)return;const job=options.queue.next();if(!job)return;busy=true;
    try {
      const response=await (options.fetcher??fetch)(upstream,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(60_000),headers:{'content-type':'application/json','x-github-event':job.event,'x-github-delivery':job.delivery,'x-hub-signature-256':job.signature},body:job.body});
      await response.body?.cancel();
      if(!response.ok)throw new Error('Upstream rejected delivery');
      options.queue.complete(job);
      console.info(JSON.stringify({operation:'webhook.forward',ok:true}));
    }catch{options.queue.fail(job);console.warn(JSON.stringify({operation:'webhook.forward',ok:false,queue:options.queue.status()}));}
    finally{busy=false;}
  }
  return {server,drain,isBusy:()=>busy};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=JSON.parse(readFileSync(process.env.PAPERCLIP_WEBHOOK_CONFIG!, 'utf8'));
  const secret=readFileSync(process.env.PAPERCLIP_WEBHOOK_SECRET_FILE!, 'utf8').trim();
  const queue=new DeliveryQueue(config.database);
  const {server,drain,isBusy}=createReceiver({...config,queue,secret});
  server.listen(config.port??3102,'127.0.0.1');
  const timer=setInterval(()=>void drain(),1000);
  process.on('SIGTERM',()=>{clearInterval(timer);server.close(()=>{const finish=()=>{if(isBusy())setTimeout(finish,100);else{queue.close();process.exit(0);}};finish();});});
}
