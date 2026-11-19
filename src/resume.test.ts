import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendEvidence, readEvidence } from './evidence.js';
import { readResume } from './resume.js';

const exec=promisify(execFile);
async function git(root:string,...args:string[]){await exec('git',args,{cwd:root,windowsHide:true});}
async function setup(){
  const root=await mkdtemp(path.join(os.tmpdir(),'notchlet-resume-'));
  await git(root,'init','-b','main'); await git(root,'config','user.email','test@example.invalid'); await git(root,'config','user.name','Test');
  await writeFile(path.join(root,'tracked.txt'),'initial'); await git(root,'add','tracked.txt'); await git(root,'commit','-m','initial');
  const dir=path.join(root,'.notchlet','changes','resume-test'); await mkdir(dir,{recursive:true});
   const change={schemaVersion:1,id:'resume-test',name:'Resume test',createdAt:'2026-01-01T00:00:00Z',mode:'quick',intent:'Implement resume',outcome:'Provide resumable state',capabilityImpact:'none',capabilityRationale:'No durable capability changed.',requirements:[{id:'R1',title:'Requirement',description:'A requirement'}],checks:[{id:'C1',description:'test'}],tasks:[{id:'T1',title:'First',status:'completed',dependencies:[],requirementIds:['R1']},{id:'T2',title:'Second',status:'pending',dependencies:['T1'],requirementIds:['R1']},{id:'T3',title:'Third',status:'pending',dependencies:['T2'],requirementIds:['R1']}],artifacts:{'proposal.md':'proposal.md'},revision:7};
  await writeFile(path.join(dir,'tasks.json'),JSON.stringify(change)); await writeFile(path.join(dir,'proposal.md'),'proposal'); return {root,dir};
}
test('reconstructs fresh-session context with blockers, progress, eligible dependencies and evidence freshness',async()=>{
 const {root}=await setup(); try {
  await appendEvidence(root,'resume-test',{kind:'check',outcome:'passed',summary:'Unit checks completed',requirementIds:['R1'],taskIds:['T1'],provenance:'recorded'});
  const page=await readResume(root,'resume-test'); const data=page.data as any;
  assert.equal(page.revision,7); assert.equal(data.summary.progress.completed,1); assert.deepEqual(data.summary.nextTasks,['T2']);
  assert.equal(data.summary.ready,true); assert.equal(data.evidence[0].freshness.status,'fresh',JSON.stringify(data.evidence[0].freshness)); assert.equal(data.evidence[0].freshness.independentlyVerified,false);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('reports changed HEAD and dirty local worktree conflicts',async()=>{
 const {root}=await setup(); try {
  await appendEvidence(root,'resume-test',{kind:'note',outcome:'informational',summary:'Captured',requirementIds:[],taskIds:[],provenance:'recorded'});
  await writeFile(path.join(root,'tracked.txt'),'changed'); await git(root,'add','tracked.txt'); await git(root,'commit','-m','second');
  await writeFile(path.join(root,'untracked.txt'),'dirty');
  const conflicts=(await readResume(root,'resume-test',{section:'repositories'}).then(x=>(x.data as any).conflicts));
  assert(conflicts.some((x:any)=>x.code==='different_head')); assert(conflicts.some((x:any)=>x.code==='dirty_worktree'));
 } finally {await rm(root,{recursive:true,force:true});}
});
test('evidence freshness distinguishes stale and unknown observations',async()=>{
 const {root}=await setup(); try {
  await appendEvidence(root,'resume-test',{kind:'note',outcome:'informational',summary:'Captured',requirementIds:[],taskIds:[],provenance:'recorded'});
  const dir=path.join(root,'.notchlet','changes','resume-test'), change=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir,'tasks.json'),'utf8')); change.revision++; await writeFile(path.join(dir,'tasks.json'),JSON.stringify(change));
  const e=(await readResume(root,'resume-test',{section:'evidence'}).then(x=>x.data as any[]))[0]; assert.equal(e.freshness.status,'stale');
  change.revision--; await writeFile(path.join(dir,'tasks.json'),JSON.stringify(change));
  const evidencePath=path.join(dir,'evidence.jsonl'), raw=JSON.parse((await (await import('node:fs/promises')).readFile(evidencePath,'utf8')).trim()); raw.git.tracked.truncated=true; await writeFile(evidencePath,JSON.stringify(raw)+'\n');
  const unknown=(await readResume(root,'resume-test',{section:'evidence'}).then(x=>x.data as any[]))[0]; assert.equal(unknown.freshness.status,'unknown');
 } finally {await rm(root,{recursive:true,force:true});}
});
test('supports targeted paging, unchanged fingerprint, and rejects stale or cross-change cursors',async()=>{
 const {root}=await setup(); try {
  const first=await readResume(root,'resume-test',{section:'tasks',limit:1}); assert(first.nextCursor);
  const second=await readResume(root,'resume-test',{section:'tasks',limit:1,cursor:first.nextCursor}); assert.equal((second.data as any[])[0].id,'T2');
  assert.equal((await readResume(root,'resume-test',{section:'tasks',knownFingerprint:first.fingerprint})).unchanged,true);
  await assert.rejects(()=>readResume(root,'another-change',{section:'tasks',cursor:first.nextCursor}));
  const c=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'.notchlet','changes','resume-test','tasks.json'),'utf8')); c.revision++; await writeFile(path.join(root,'.notchlet','changes','resume-test','tasks.json'),JSON.stringify(c));
  await assert.rejects(()=>readResume(root,'resume-test',{section:'tasks',cursor:first.nextCursor}),/stale/i);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('keeps default serialization bounded for large change text',async()=>{
 const {root}=await setup(); try {
  const file=path.join(root,'.notchlet','changes','resume-test','tasks.json'), c=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8')); c.intent='x'.repeat(100_000); await writeFile(file,JSON.stringify(c));
  const result=await readResume(root,'resume-test'); assert(Buffer.byteLength(JSON.stringify(result))<=32768); assert.equal(result.truncated,true); assert(result.nextCursor);
 } finally {await rm(root,{recursive:true,force:true});}
});
