import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const TERMINAL = new Set(['accepted', 'blocked', 'failed', 'cancelled', 'interrupted']);
export const BUSY = new Set(['running', 'validating']);
export const DEFAULTS = { mode: 'off', execModel: '', execThinking: 'low', maxConcurrent: 4, taskTimeoutMs: 600000, panel: true };
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2)+'\n', {mode:0o600});
  fs.renameSync(tmp, file);
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if(e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path.basename(file)}: ${e.message}`); }
}
export function loadConfig(dir) {
  const c={...DEFAULTS,...readJson(path.join(dir,'config.json'),{})};
  if(!['off','auto'].includes(c.mode)) c.mode='off';
  c.maxConcurrent=Math.max(1,Math.min(8,Number(c.maxConcurrent)||4));
  delete c.maxTurns; // Ignore the legacy turn limit.
  c.taskTimeoutMs=Math.max(10000,Math.min(3600000,Number(c.taskTimeoutMs)||600000));
  return c;
}
export function saveConfig(dir, changes) {
  const c={...loadConfig(dir),...changes};
  atomicJson(path.join(dir,'config.json'),c); return c;
}
export function blankUsage() {return {input:0,output:0,cacheRead:0,cacheWrite:0,total:0};}
export function addUsage(a, b={}) {
  for(const k of ['input','output','cacheRead','cacheWrite'])a[k]+=(Number(b[k])||0);
  a.total=a.input+a.output+a.cacheRead+a.cacheWrite;return a;
}
export function usageFromEntries(entries) {
  const u=blankUsage();const seen=new Set();
  for(const e of entries) if(e.type==='message'&&e.message?.role==='assistant'&&!seen.has(e.id)) {
    seen.add(e.id);addUsage(u,e.message.usage);
  }
  return u;
}
export function usageByModel(entries) {
  const groups={},seen=new Set();
  for(const e of entries)if(e.type==='message'&&e.message?.role==='assistant'&&!seen.has(e.id)){
    seen.add(e.id);const key=`${e.message.provider||'unknown'}/${e.message.model||'unknown'}`;
    addUsage(groups[key]??=blankUsage(),e.message.usage);
  }
  return groups;
}
function text(value, name, min=1) {
  if(typeof value!=='string'||value.trim().length<min)throw new Error(`Spec requires ${name}`);
  return value.trim();
}
function textList(value,name,min=1) {
  if(!Array.isArray(value)||value.length<min)throw new Error(`Spec requires ${name}`);
  return value.map(v=>text(v,name));
}
export function validateSpec(raw) {
  if(!raw||typeof raw!=='object')throw new Error('A detailed spec is required');
  const spec={
    title:text(raw.title,'title'),goal:text(raw.goal,'goal',12),
    context:text(raw.context,'context',12),kind:raw.kind||'implementation',
    requirements:textList(raw.requirements,'requirements'),
    constraints:textList(raw.constraints,'constraints'),
    allowedPaths:textList(raw.allowedPaths,'allowedPaths'),
    acceptance:raw.acceptance,
    dependencies:raw.dependencies?textList(raw.dependencies,'dependencies',0):[],
  };
  if(!['implementation','analysis'].includes(spec.kind))throw new Error('Unknown task kind');
  for(const p of spec.allowedPaths) {
    if(path.isAbsolute(p)||p.includes('\\')||p.split('/').some(s=>s==='..'||s==='.')||/[*?]/.test(p.split('/')[0])||p==='.git'||p.startsWith('.git/'))throw new Error('allowedPaths must name bounded relative files/directories, not the whole repository');
  }
  if(!Array.isArray(spec.acceptance)||!spec.acceptance.length)throw new Error('Spec requires acceptance criteria');
  spec.acceptance=spec.acceptance.map(a=>({description:text(a.description,'acceptance description'),...(a.command?.trim()?{command:a.command.trim()}:{}),expected:text(a.expected,'expected result')}));
  if(spec.kind==='implementation'&&!spec.acceptance.some(a=>a.command))throw new Error('Implementation specs need at least one executable validation command');
  if(JSON.stringify(spec).length>60000)throw new Error('Spec too large; provide focused context');
  return spec;
}
export function allowedPath(relative, selectors) {
  if(relative.split('/').some(p=>p==='..'||p==='.')||relative.includes('\\')||path.isAbsolute(relative)||relative==='.git'||relative.startsWith('.git/'))return false;
  return selectors.some(s=>{
    if(s.endsWith('/')) return relative.startsWith(s);
    let pattern='';
    for(let i=0;i<s.length;i++){
      if(s[i]==='*'&&s[i+1]==='*'){
        i++;if(s[i+1]==='/'){i++;pattern+='(?:.*/)?';}else pattern+='.*';
      }else if(s[i]==='*')pattern+='[^/]*';
      else if(s[i]==='?')pattern+='[^/]';
      else pattern+=s[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    }
    return new RegExp('^'+pattern+'$').test(relative);
  });
}
export function run(command,args,{cwd,timeoutMs=30000,signal,shell=false}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){resolve({code:-1,stdout:'',stderr:'',timedOut:false,aborted:true});return;}
    const p=spawn(command,args,{cwd,shell,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='',timedOut=false;
    const cap=(a,b)=>(a+b).slice(-48000);
    p.stdout.on('data',b=>out=cap(out,b));p.stderr.on('data',b=>err=cap(err,b));
    const send=sig=>{try{if(process.platform==='win32')p.kill(sig);else if(p.pid)process.kill(-p.pid,sig);}catch{}};
    let killTimer;
    const kill=()=>{send('SIGTERM');killTimer??=setTimeout(()=>send('SIGKILL'),1500);killTimer.unref();};
    const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);timer.unref();
    const abort=()=>kill(); signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)kill();
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    p.on('error',e=>{cleanup();reject(e);});
    p.on('close',(code)=>{cleanup();resolve({code:code??-1,stdout:out,stderr:err,timedOut,aborted:signal?.aborted===true});});
  });
}
export async function git(args,cwd) {
  const r=await run('git',args,{cwd});if(r.code!==0)throw new Error(r.stderr.trim()||r.stdout.trim()||'Git command failed');return r.stdout.trim();
}
export function elapsed(node, now=Date.now()) {return (node.activeMs||0)+(node.activeSince?now-node.activeSince:0);}
const states={off:'关闭',idle:'待命',running:'运行',validating:'验证',queued:'排队',waiting:'等待依赖',review:'待验收',accepted:'已验收',blocked:'阻塞',failed:'失败',cancelled:'取消',interrupted:'中断'};
const marks={running:'●',validating:'◉',review:'◇',accepted:'✓',blocked:'!',failed:'×',interrupted:'!',queued:'○',waiting:'○'};
export function fmtNumber(n=0){return n>=1000000?(n/1000000).toFixed(2)+'m':n>=1000?(n/1000).toFixed(1)+'k':String(n);}
export function fmtTime(ms=0){const s=Math.floor(ms/1000);return s>=3600?`${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`:s>=60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`;}
export function treeLines(state,config,now=Date.now(),color=true) {
  const paint=(code,s)=>color?`\x1b[${code}m${s}\x1b[0m`:s;
  const jobs=Object.values(state.jobs);const u={...state.parent.usage};
  for(const j of jobs)addUsage(u,j.usage);
  const totalTime=elapsed(state.parent,now)+jobs.reduce((s,j)=>s+elapsed(j,now),0);
  const active=jobs.filter(j=>BUSY.has(j.status)).length;
  const blocked=jobs.filter(j=>['blocked','failed','interrupted'].includes(j.status)).length;
  const stats=(usage,node)=>`↑${fmtNumber(usage.input)} ↓${fmtNumber(usage.output)} 缓存${fmtNumber(usage.cacheRead+usage.cacheWrite)} · ${fmtTime(elapsed(node,now))}`;
  const mainUsage=state.parent.byModel?.[state.parent.model]||state.parent.usage;
  const mainTime=state.parent.modelTimes?.[state.parent.model]||state.parent;
  const lines=[paint('1;36',`${config.mode.toUpperCase()} · ${active} 运行 ${blocked} 阻塞 · 并发上限 ${config.maxConcurrent} · 合计 ${fmtNumber(u.total)} tokens · 累计执行 ${fmtTime(totalTime)}`),
    paint('1',`主模型 ${state.parent.model||'未选择'} [${states[state.parent.status]||state.parent.status}] · ${stats(mainUsage,mainTime)}`)];
  const visible=jobs.slice(-12);
  if(Object.keys(state.parent.byModel||{}).length>1)for(const [model,usage] of Object.entries(state.parent.byModel)){
    if(model!==state.parent.model)lines.push(`│ 历史主模型 ${model} · ${stats(usage,state.parent.modelTimes?.[model]||{})}`);
  }
  visible.forEach((j,i)=>{
    const last=i===visible.length-1,prefix=last?'└─':'├─',indent=last?'   ':'│  ';
    const c=['blocked','failed','interrupted'].includes(j.status)?'31':j.status==='accepted'?'32':BUSY.has(j.status)?'36':'33';
    const title=j.spec.title.replace(/[\r\n\x1b]/g,' ').slice(0,26);
    lines.push(`${prefix} ${paint(c,`${marks[j.status]||'○'} ${states[j.status]||j.status}`)} ${title} · ${j.model} · ${stats(j.usage,j)}`);
    if(j.reason&&['blocked','failed','interrupted','cancelled'].includes(j.status))lines.push(`${indent}${j.id}: ${j.reason.replace(/[\r\n\x1b]/g,' ').slice(0,110)}`);
  });
  if(!jobs.length)lines.push(`└─ 执行模型 ${config.execModel||'尚未选择'}  ·  尚无委派任务`);
  if(jobs.length>visible.length)lines.push(`另有 ${jobs.length-visible.length} 个历史任务，可用 /delegation status 查看。`);
  lines.push('已结算用量：↑输入 ↓输出；累计含工具/验证，并行不等于墙钟。/delegation status 查看详情。');
  return lines;
}

export class Coordinator {
  constructor({dir,sessionId,cwd,runner,changed=()=>{},notify=()=>{},config}) {
    this.dir=dir;this.cwd=cwd;this.runner=runner;this.changed=changed;this.notify=notify;
    this.config=config||loadConfig(dir);this.file=path.join(dir,'runs',sessionId+'.json');
    this.state=readJson(this.file,{version:1,sessionId,cwd,createdAt:Date.now(),parent:{model:'',status:'idle',usage:blankUsage(),activeMs:0},jobs:{}});
    this.config={...this.config,...this.state.config};
    this.active=new Map();this.closed=false;
    for(const j of Object.values(this.state.jobs))if(BUSY.has(j.status)||['queued','waiting'].includes(j.status)){
      j.activeMs=elapsed(j,this.state.updatedAt||j.activeSince||Date.now());delete j.activeSince;j.status='interrupted';j.reason='宿主已重启；任务未自动重放，请检查工作树后重新派发。';
    }
    if(this.state.parent.activeSince){this.state.parent.activeMs=elapsed(this.state.parent,this.state.updatedAt||this.state.parent.activeSince);delete this.state.parent.activeSince;}
    for(const item of Object.values(this.state.parent.modelTimes||{}))if(item.activeSince){item.activeMs=elapsed(item,this.state.updatedAt||item.activeSince);delete item.activeSince;}
    this.state.parent.status='idle';this.persist();
  }
  persist(){this.state.updatedAt=Date.now();this.state.config=this.config;atomicJson(this.file,this.state);this.changed();}
  updateParent(model,usage,status,byModel){
    const parent=this.state.parent,now=Date.now();
    parent.modelTimes??={};
    const old=parent.modelTimes[parent.model];
    if(old?.activeSince){old.activeMs=elapsed(old,now);delete old.activeSince;}
    if((status||parent.status)==='running'){
      parent.modelTimes[model]??={activeMs:0};parent.modelTimes[model].activeSince=now;
    }
    if(byModel)parent.byModel=byModel;
    Object.assign(this.state.parent,{model,usage});
    if(status==='running'&&!this.state.parent.activeSince)this.state.parent.activeSince=Date.now();
    if(status&&status!=='running'&&this.state.parent.activeSince){this.state.parent.activeMs=elapsed(this.state.parent);delete this.state.parent.activeSince;}
    if(status)this.state.parent.status=status;
    this.persist();
  }
  configure(changes){
    this.config={...this.config,...changes};
    if(changes.mode==='off')for(const j of Object.values(this.state.jobs))if(['queued','waiting'].includes(j.status)){j.status='cancelled';j.reason='委派已关闭，未启动任务已取消。';}
    this.persist();this.pump();
  }
  submit(raw,model=this.config.execModel){
    if(this.closed||this.config.mode!=='auto')throw new Error('Delegation is off. The user must enable it with /delegation auto.');
    if(!model)throw new Error('Choose an execution model with /delegation exec provider/model.');
    const spec=validateSpec(raw);
    for(const dep of spec.dependencies)if(!this.state.jobs[dep])throw new Error(`Unknown dependency ${dep}`);
    const id='t-'+crypto.randomUUID().slice(0,8);
    const task={id,model,spec,specHash:crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'),status:'queued',usage:blankUsage(),activeMs:0,createdAt:Date.now(),config:{thinking:this.config.execThinking,timeoutMs:this.config.taskTimeoutMs}};
    this.state.jobs[id]=task;
    atomicJson(path.join(this.dir,'specs',this.state.sessionId,id+'.json'),{id,hash:task.specHash,spec});
    this.persist();this.pump();return task;
  }
  pump(){
    if(this.closed||this.config.mode!=='auto')return;
    for(const j of Object.values(this.state.jobs)){
      if(!['queued','waiting'].includes(j.status))continue;
      const deps=j.spec.dependencies.map(id=>this.state.jobs[id]);
      if(deps.some(d=>['blocked','failed','cancelled','interrupted'].includes(d.status))){j.status='blocked';j.reason='前置任务阻塞，需要主模型处理。';this.persist();continue;}
      if(deps.some(d=>d.status!=='accepted')){j.status='waiting';j.reason='等待前置任务验收。';this.persist();continue;}
      if(this.active.size>=this.config.maxConcurrent)break;
      const controller=new AbortController();this.active.set(j.id,{controller});
      j.status='running';delete j.reason;j.activeSince=Date.now();
      this.persist();this.execute(j,controller).catch(e=>{j.status='failed';j.reason=e.message;this.finish(j);});
    }
  }
  async execute(j,controller){
    const signal=controller.signal;
    let validationTimeout;
    try{
      const root=await git(['rev-parse','--show-toplevel'],this.cwd);
      j.base=await git(['rev-parse','HEAD'],root);
      j.branch=`pi-delegation/${j.id}`;
      j.cwd=path.join(path.dirname(root),path.basename(root)+'-pi-workers',j.id);
      fs.mkdirSync(path.dirname(j.cwd),{recursive:true});
      if(signal.aborted)throw new Error('Cancelled before worker start');
      await git(['worktree','add','-b',j.branch,j.cwd,j.base],root);
      if(signal.aborted)throw new Error('Cancelled before worker start');
      const result=await this.runner(j,{signal,onProgress:(patch)=>{if(!this.closed){Object.assign(j,patch);this.persist();}}});
      Object.assign(j,result);if(signal.aborted)throw new Error(String(signal.reason||'Cancelled'));
      if(result.report?.status==='blocked'){j.status='blocked';j.reason=result.report.summary;return;}
      if(result.report?.status!=='submitted'){j.status='blocked';j.reason=result.error||'执行模型未提交结构化结果，请主模型检查。';return;}
      j.status='validating';this.persist();
      validationTimeout=setTimeout(()=>controller.abort('Validation time budget exceeded'),j.config.timeoutMs);validationTimeout.unref();
      await this.checkScope(j);
      j.validation=[];
      for(const check of j.spec.acceptance){
        if(!check.command){j.validation.push({...check,manual:true});continue;}
        const r=await run(check.command,[],{cwd:j.cwd,shell:true,timeoutMs:Math.min(j.config.timeoutMs,120000),signal});
        j.validation.push({...check,...r});this.persist();
        if(r.code!==0||r.timedOut||r.aborted)throw new Error('Validation failed: '+check.description);
      }
      await this.checkScope(j);
      j.status='review';j.reason='执行检查已完成，等待主模型审查 diff、集成与验收。';
    }catch(e){j.status=signal.aborted?'cancelled':'blocked';j.reason=String(signal.reason||e.message);}
    finally{clearTimeout(validationTimeout);this.finish(j);}
  }
  async checkScope(j){
    const diff=await run('git',['diff','--name-only','-z',j.base],{cwd:j.cwd});
    const extra=await run('git',['ls-files','--others','--exclude-standard','-z'],{cwd:j.cwd});
    if(diff.code||extra.code)throw new Error('Could not inspect worker diff');
    j.changedFiles=[...new Set((diff.stdout+extra.stdout).split('\0').filter(Boolean))];
    const outside=j.changedFiles.filter(p=>!allowedPath(p,j.spec.allowedPaths));
    if(outside.length)throw new Error('Changes outside spec: '+outside.join(', '));
    if(j.spec.kind==='analysis'&&j.changedFiles.length)throw new Error('Analysis worker changed tracked/untracked files');
  }
  finish(j){
    if(j.activeSince){j.activeMs=elapsed(j);delete j.activeSince;}j.finishedAt=Date.now();
    this.active.delete(j.id);if(this.closed)return;this.persist();
    if(!this.closed)this.notify(j);
    this.pump();
  }
  review(id,decision,evidence){
    const j=this.state.jobs[id];if(!j)throw new Error('Unknown task');
    if(decision==='accept'){
      if(j.status!=='review')throw new Error('Only a submitted, validated task can be accepted');
      if(typeof evidence!=='string'||evidence.trim().length<20)throw new Error('Record concrete diff/integration/acceptance evidence');
      j.status='accepted';j.reason='主模型已验收';j.reviewEvidence=evidence;
    }else if(decision==='block'){
      if(BUSY.has(j.status))throw new Error('Stop running tasks before blocking');
      j.status='blocked';j.reason=text(evidence,'block reason');
    }else throw new Error('Unknown review decision');
    this.persist();this.pump();return j;
  }
  cancel(id){
    const j=this.state.jobs[id];if(!j)throw new Error('Unknown task');
    if(this.active.has(id))this.active.get(id).controller.abort('Stopped by user');
    else if(['queued','waiting'].includes(j.status)){j.status='cancelled';j.reason='用户取消';this.persist();this.pump();}
  }
  async wait(ids,timeoutMs=25000){
    const end=Date.now()+Math.min(30000,Math.max(0,timeoutMs));
    while(Date.now()<end&&ids.some(id=>{const j=this.state.jobs[id];return j&&['running','validating','queued','waiting'].includes(j.status);}))await new Promise(r=>setTimeout(r,200));
    return ids.map(id=>this.state.jobs[id]).filter(Boolean);
  }
  close(){
    if(this.closed)return;this.closed=true;
    for(const a of this.active.values())a.controller.abort('Host session closed');
    for(const j of Object.values(this.state.jobs))if(BUSY.has(j.status)||['queued','waiting'].includes(j.status)){
      j.activeMs=elapsed(j);delete j.activeSince;j.status='interrupted';j.reason='宿主会话已关闭；请检查工作树后重新派发。';
    }
    this.updateParent(this.state.parent.model,this.state.parent.usage,'idle');
  }
}
