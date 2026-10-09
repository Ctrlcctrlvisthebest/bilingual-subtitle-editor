import assert from 'node:assert/strict';

export function sampleRow(id='row-0') {
 return {id,start:0,end:1,zh:'带上抗火药水。',en:'Bring fire resistance potions.',speaker:'Spoke',status:'待听校',note:'',audioTranscript:'Bring fire res.',youtubeTranscript:'Bring fire rose.'};
}

export function longProject() {
 return {
  version:1,editor_id:'synthetic-local',title:'四小时多语字幕容量验证',colors:{Spoke:'#000000',Mapicc:'#ff0000'},
  rows:Array.from({length:7392},(_,i)=>({
   ...sampleRow('row-'+i),start:i*2,end:i*2+1.8,
   zh:'带上抗火药水，跟我一起进下界。',en:'Bring fire resistance potions and follow me into the Nether.',
   speaker:i%2?'Mapicc':'Spoke',note:'听校 reference '.repeat(70),
   speaker_match:{score:.9,margin:.3,actor:'Spoke',method:'synthetic-test'},segmentation_source_ids:[String(i)]
  }))
 };
}

// Exact UTF-8 payload sizes with individually valid rows, including multibyte references.
export function projectAtBytes(targetBytes,rowCount=300) {
 const project={version:1,editor_id:'synthetic-local',title:'容量边界验证',colors:{Spoke:'#000000'},rows:Array.from({length:rowCount},(_,i)=>({...sampleRow('row-'+i),audioTranscript:''}))};
 const padding=targetBytes-Buffer.byteLength(JSON.stringify(project)),perRow=Math.floor(padding/rowCount);
 assert(perRow>=0,'target is smaller than the fixture');
 for(let i=0;i<rowCount;i++) {
  const bytes=perRow+(i===rowCount-1?padding%rowCount:0);
  project.rows[i].audioTranscript='字'.repeat(Math.floor(bytes/3))+'x'.repeat(bytes%3);
 }
 assert.equal(Buffer.byteLength(JSON.stringify(project)),targetBytes);
 return project;
}
