import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { evaluateEvidenceFreshness, readEvidence, type EvidenceRecord } from './evidence.js';
import { inspectGitContext, type GitContextResult } from './git-context.js';
import { readiness, readChange, type Change, type Issue, type Task } from './index.js';

export type ResumeSection = 'summary' | 'intent' | 'design' | 'requirements' | 'tasks' | 'evidence' | 'repositories';
export interface ResumeOptions { section?: ResumeSection; limit?: number; cursor?: string; knownFingerprint?: string; budgetBytes?: number; }
export interface ResumePage<T = unknown> { changeId: string; revision: number; section: ResumeSection | 'default'; fingerprint: string; unchanged?: true; data?: T; nextCursor?: string; truncated?: boolean; }
export interface ResumeTask extends Task { dependencyEligible: boolean; }
export interface ResumeEvidence extends EvidenceRecord { freshness: Awaited<ReturnType<typeof evaluateEvidenceFreshness>>; }
export interface ResumeRepository { current: GitContextResult; conflicts: Array<{ code: string; message: string }>; }
export interface ResumeSnapshot {
  summary: { name: string; mode: Change['mode']; revision: number; progress: { completed: number; inProgress: number; pending: number; total: number }; ready: boolean; blockers: Issue[]; nextTasks: string[] };
  intent: { intent: string; outcome: string };
  design: Change['designDecisions']; requirements: Change['requirements']; tasks: ResumeTask[];
  evidence: ResumeEvidence[]; repositories: ResumeRepository;
}
const sections: ResumeSection[] = ['summary','intent','design','requirements','tasks','evidence','repositories'];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sortById = <T extends {id:string}>(items:T[]) => [...items].sort((a,b)=>a.id.localeCompare(b.id,'en'));
function cursorEncode(payload: object): string { return Buffer.from(JSON.stringify(payload)).toString('base64url'); }
function cursorDecode(cursor: string): { changeId:string; section:ResumeSection; fingerprint:string; offset:number } {
  try { const p=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); if (!p || typeof p.changeId!=='string'||!sections.includes(p.section)||typeof p.fingerprint!=='string'||!Number.isInteger(p.offset)||p.offset<0) throw 0; return p; }
  catch { throw new Error('Invalid resume cursor.'); }
}
async function snapshot(root:string, change:Change):Promise<ResumeSnapshot> {
  const blocked=readiness(change), done=new Set(change.tasks.filter(t=>t.status==='completed').map(t=>t.id));
  const tasks=sortById(change.tasks).map(t=>({...t,dependencyEligible:t.status!=='completed'&&t.dependencies.every(d=>done.has(d))}));
  const evidence=await Promise.all((await readEvidence(root,change.id)).sort((a,b)=>a.id.localeCompare(b.id,'en')).map(async e=>({...e,freshness:await evaluateEvidenceFreshness(root,change.id,e)})));
  const current=await inspectGitContext(root), conflicts:ResumeRepository['conflicts']=[];
  if (current.isRepository && current.available && current.repository.head) {
    for (const e of evidence) if (e.git.isRepository && e.git.available && e.git.repository.head && e.git.repository.head!==current.repository.head) { conflicts.push({code:'different_head',message:`Evidence ${e.id} was captured at a different Git HEAD.`}); break; }
    for (const e of evidence) if (e.git.isRepository && e.git.available && (e.git.tracked.digest!==current.tracked.digest||e.git.untracked.digest!==current.untracked.digest)) { conflicts.push({code:'dirty_worktree',message:`Current Git worktree differs from evidence ${e.id}.`}); break; }
  }
  const count=(status:Task['status'])=>change.tasks.filter(t=>t.status===status).length;
  return {summary:{name:change.name,mode:change.mode,revision:change.revision??0,progress:{completed:count('completed'),inProgress:count('in_progress'),pending:count('pending'),total:change.tasks.length},ready:blocked.ready,blockers:blocked.blockers,nextTasks:tasks.filter(t=>t.dependencyEligible).map(t=>t.id)},intent:{intent:change.intent,outcome:change.outcome},design:sortById(change.designDecisions),requirements:sortById(change.requirements),tasks,evidence,repositories:{current,conflicts}};
}
/** Read bounded change context for a fresh session. This only reads workspace artifacts and safe Git observations. */
export async function readResume(root:string, changeId:string, options:ResumeOptions={}):Promise<ResumePage> {
  const change=await readChange(root,changeId), revision=change.revision??0;
  if (!Number.isInteger(revision)) throw new Error('Change revision is required for resume reads.');
  if (options.section && !sections.includes(options.section)) throw new Error('Unsupported resume section.');
  const limit=options.limit??20; if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error('Resume page limit must be an integer from 1 to 100.');
  const full=await snapshot(root,change), section=options.section;
  const view=section ? full[section] : full;
  const fingerprint=hash({changeId,revision,view});
  if (options.knownFingerprint===fingerprint) return {changeId,revision,section:section??'default',fingerprint,unchanged:true};
  let offset=0;
  if(options.cursor){const c=cursorDecode(options.cursor); if(c.changeId!==changeId)throw new Error('Resume cursor belongs to a different change.'); if(c.section!==(section??'summary'))throw new Error('Resume cursor belongs to a different section.'); if(c.fingerprint!==fingerprint)throw new Error('Resume cursor is stale.'); offset=c.offset;}
  const budget=(options.budgetBytes??32768)-512; if(!Number.isInteger(options.budgetBytes??32768)||(options.budgetBytes??32768)<1024)throw new Error('Resume budget must be at least 1024 bytes.');
  const pageSection=section??'summary'; const value=section ? view : full;
  if(Array.isArray(value)){const data=value.slice(offset,offset+limit); const end=offset+data.length; return {changeId,revision,section:pageSection,fingerprint,data,...(end<value.length?{nextCursor:cursorEncode({changeId,section:pageSection,fingerprint,offset:end})}:{})};}
  if(section) return {changeId,revision,section,fingerprint,data:view};
  // Reserve response metadata, then truncate long text fields deterministically until the serialized result fits.
  const result:ResumePage={changeId,revision,section:'default',fingerprint,data:full};
  const fits=()=>Buffer.byteLength(JSON.stringify(result),'utf8')<=budget;
  if(!fits()) {
    const mutable=JSON.parse(JSON.stringify(full)) as ResumeSnapshot; result.data=mutable;
    for(const key of ['intent','outcome'] as const){const text=mutable.intent[key]; let lo=0,hi=text.length; while(lo<hi){const mid=Math.ceil((lo+hi)/2); mutable.intent[key]=text.slice(0,mid)+'…'; if(fits())lo=mid;else hi=mid-1;} mutable.intent[key]=text.slice(0,lo)+(lo<text.length?'…':''); if(lo<text.length)result.truncated=true;}
    if(!fits()) { mutable.requirements=[]; mutable.design=[]; mutable.evidence=[]; mutable.tasks=[]; mutable.summary.blockers=[]; mutable.summary.nextTasks=[]; result.truncated=true; }
  }
  if(!fits())throw new Error('Resume metadata exceeds the configured response budget.');
  if(result.truncated)result.nextCursor=cursorEncode({changeId,section:'summary',fingerprint,offset:0});
  return result;
}
