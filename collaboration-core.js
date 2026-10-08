// The editor includes this file inline. No credentials belong in a project JSON.
const collabEqual=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function collabMeta(p){const {rows,...meta}=p;return meta;}
function collabPatch(base,p){
 const before=new Map(base.project.rows.map(r=>[r.id,r])),after=new Map(p.rows.map(r=>[r.id,r])),changes=[];
 for(const id of new Set([...before.keys(),...after.keys()]))if(!collabEqual(before.get(id),after.get(id)))changes.push({id,expected:Object.hasOwn(base.rowVersions,id)?base.rowVersions[id]:0,row:after.get(id)||null});
 const data={changes};
 if(!collabEqual(collabMeta(base.project),collabMeta(p)))data.meta={expected:base.metaVersion,value:collabMeta(p)};
 const ids=p.rows.map(r=>r.id);if(!collabEqual(base.project.rows.map(r=>r.id),ids))data.order={expected:base.orderVersion,ids};
 return data;
}
function collabDirty(base,p){const d=collabPatch(base,p);return !!(d.changes.length||d.meta||d.order);}
function collabOrder(ids,rows){const result=ids.filter(id=>rows.has(id)),present=new Set(result);for(const [id] of rows)if(!present.has(id))result.push(id);return [...new Set(result)];}
function collabMerge(base,local,remote){
 const b=new Map(base.rows.map(r=>[r.id,r])),l=new Map(local.rows.map(r=>[r.id,r])),r=new Map(remote.rows.map(r=>[r.id,r])),merged=new Map(),conflicts=[];
 for(const id of new Set([...b.keys(),...l.keys(),...r.keys()])){
  const bv=b.get(id),lv=l.get(id),rv=r.get(id);let value;
  if(collabEqual(lv,bv))value=rv;
  else if(collabEqual(rv,bv)||collabEqual(lv,rv))value=lv;
  else{value=lv;conflicts.push({kind:'row',id,local:lv||null,remote:rv||null});}
  if(value)merged.set(id,clone(value));
 }
 const bm=collabMeta(base),lm=collabMeta(local),rm=collabMeta(remote);let meta;
 if(collabEqual(lm,bm))meta=rm;else if(collabEqual(rm,bm)||collabEqual(lm,rm))meta=lm;else{meta=lm;conflicts.push({kind:'meta',local:lm,remote:rm});}
 const bo=base.rows.map(x=>x.id),lo=local.rows.map(x=>x.id),ro=remote.rows.map(x=>x.id);let ids;
 if(collabEqual(lo,bo))ids=ro;else if(collabEqual(ro,bo)||collabEqual(lo,ro))ids=lo;else{ids=lo;conflicts.push({kind:'order',local:lo,remote:ro});}
 return {project:{...clone(meta),rows:collabOrder(ids,merged).map(id=>merged.get(id))},conflicts};
}
