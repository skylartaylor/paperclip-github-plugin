import React,{useState} from 'react';
import {usePluginAction,usePluginData} from '@paperclipai/plugin-sdk/ui';
type Directory={labels:Array<{id:string;name:string;companyId:string}>;pairings:Array<{name:string;labelId:string}>;githubLabels:string[]};
export function LabelPairings({companyId}:{companyId:string}):React.JSX.Element {
 const directory=usePluginData<Directory>('labels.directory',{companyId});
 const save=usePluginAction('labels.savePairing');
 const [pending,setPending]=useState(false),[error,setError]=useState(''),[extra,setExtra]=useState(''),[names,setNames]=useState<string[]>([]);
 async function choose(name:string,labelId:string) {
  setPending(true);setError('');
  try {await save({companyId,name,labelId});await directory.refresh();}
  catch(e){setError(e instanceof Error?e.message:'Could not save label pairing');}
  finally {setPending(false);}
 }
 const data=directory.data;
 const rows=[...new Set([...(data?.githubLabels??[]),...names])].sort((a,b)=>a.localeCompare(b));
 return <section className="ghsync__section">
  <div className="ghsync__section-heading"><div><h2>GitHub label pairings</h2><p>Labels match by name and missing labels are created automatically. Choose an override to use a different Paperclip label. Pairings apply across this company’s connected repositories; they never rename labels on GitHub. Pairings take effect when each issue is next refreshed.</p></div></div>
  {directory.error?<p role="alert">Label management is unavailable. Refresh to try again.</p>:null}
  {!data&&!directory.error?<p>Loading labels…</p>:null}
  {error?<p role="alert">{error}</p>:null}
  {data?<><div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}><input aria-label="GitHub label name" value={extra} maxLength={100} onChange={e=>setExtra(e.currentTarget.value)} placeholder="Add a GitHub label name"/><button type="button" className="ghsync__button" disabled={!extra.trim()||pending} onClick={()=>{setNames(n=>[...n,extra.trim().toLowerCase()]);setExtra('');}}>Add pairing</button><button type="button" className="ghsync__button" onClick={()=>void directory.refresh()}>Refresh labels</button></div>
  {!rows.length?<p>Labels will appear here as issues sync. You can also add a name above.</p>:<div style={{overflowX:'auto'}}><table style={{width:'100%',textAlign:'left'}}><thead><tr><th>GitHub label</th><th>Paperclip label</th></tr></thead><tbody>{rows.map(name=><tr key={name}><td>{name}</td><td><select aria-label={`Paperclip label for ${name}`} value={data.pairings.find(p=>p.name===name.toLowerCase())?.labelId??''} disabled={pending} onChange={e=>void choose(name,e.currentTarget.value)}><option value="">Automatic: match name or create</option>{data.pairings.filter(p=>p.name===name.toLowerCase()&&!data.labels.some(l=>l.id===p.labelId)).map(p=><option key={p.labelId} value={p.labelId}>Missing label: choose a replacement</option>)}{data.labels.map(label=><option key={label.id} value={label.id}>{label.name}</option>)}</select></td></tr>)}</tbody></table></div>}</>:null}
 </section>;
}
