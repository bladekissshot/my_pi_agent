import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Coordinator,DEFAULTS,MAX_WORK_SLICE_MS,allowedPath,validateSpec,usageFromEntries,usageByModel,blankUsage,treeLines,run,git,atomicJson,elapsed} from '../lib/core.mjs';

const spec=(changes={})=>({environment:{expectedRepoRoot:path.resolve('.'),requiredFiles:['hello.txt']},title:'Update greeting',goal:'Return the greeting specified by the caller',context:'The minimal fixture contains only hello.txt and has no dependencies.',kind:'implementation',requirements:['Write hello in hello.txt'],constraints:['Do not modify unrelated files'],allowedPaths:['hello.txt'],acceptance:[{description:'Greeting content',command:"node -e \"if(require('fs').readFileSync('hello.txt','utf8')!=='hello')process.exit(1)\"",expected:'Exit 0 and exact content hello'}],...changes});
const submitted={report:{status:'submitted',summary:'Ready for review',evidence:['Changed the greeting']}};
async function fixture(t,runner,config={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delegation-test-')),cwd=path.join(dir,'repo');fs.mkdirSync(cwd);
  await git(['init','-q'],cwd);await git(['config','user.email','test@example.invalid'],cwd);await git(['config','user.name','Test'],cwd);
  fs.writeFileSync(path.join(cwd,'hello.txt'),'before\n');await git(['add','.'],cwd);await git(['commit','-qm','fixture'],cwd);
  const c=new Coordinator({dir:path.join(dir,'data'),sessionId:'test',cwd,runner,config:{...DEFAULTS,mode:'auto',execModel:'test/worker',...config}});
  t.after(async()=>{c.close();await c.wait([...c.active.keys()],2000);fs.rmSync(dir,{recursive:true,force:true});});return c;
}
function submit(c,changes={},environment={}){
  return c.submit(spec({...changes,environment:{expectedRepoRoot:c.cwd,requiredFiles:['hello.txt'],...environment}}));
}
async function done(c,id){await c.wait([id],5000);assert.equal(c.active.has(id),false,'task completed within budget');return c.state.jobs[id];}
test('spec rejects empty contracts and unbounded/escaping paths',()=>{
  for(const s of [{},spec({goal:'vague'}),spec({acceptance:[]}),spec({allowedPaths:['../x']}),spec({allowedPaths:['*']}),spec({allowedPaths:['src/../x']}),spec({allowedPaths:['.git/config']}),spec({acceptance:[{description:'manual',expected:'works'}]})])assert.throws(()=>validateSpec(s));
  assert.equal(validateSpec(spec()).title,'Update greeting');
  assert.equal(validateSpec(spec({kind:'analysis',acceptance:[{description:'explain',expected:'evidence'}]})).kind,'analysis');
});
test('environment requires an explicit absolute repository and exact, bounded prerequisite files',()=>{
  const {environment}=spec();
  for(const malformed of [undefined,{...environment,expectedRepoRoot:'.'}, {...environment,requiredFiles:undefined},
    {...environment,requiredFiles:['../hello.txt']}, {...environment,requiredFiles:['src/*.ts']},
    {...environment,requiredFiles:['C:/work/hello.txt']}, {...environment,requiredFiles:['.GIT/config']},
    {...environment,expectedBase:'main'}, {...environment,minNodeMajor:0}]){
    assert.throws(()=>validateSpec(spec({environment:malformed})),/environment/);
  }
});
test('repository mismatch and stale explicit baseline are rejected before recording a task or creating a worktree',async t=>{
  let starts=0;
  const c=await fixture(t,async()=>{starts++;return submitted;});
  const other=path.join(path.dirname(c.cwd),'another-repo');fs.mkdirSync(other);await git(['init','-q'],other);
  await assert.rejects(submit(c,{}, {expectedRepoRoot:other}),error=>{
    assert.match(error.message,/Repository mismatch/);assert.ok(error.message.includes('another-repo'));return true;
  });
  await assert.rejects(submit(c,{}, {expectedBase:'f'.repeat(40)}),/Baseline mismatch/);
  assert.deepEqual(c.state.jobs,{});
  assert.equal(fs.existsSync(path.join(c.dir,'specs')),false);
  assert.equal(fs.existsSync(c.cwd+'-pi-workers'),false);
  assert.equal(starts,0);
});
test('worker uses a canonical worktree and only starts when committed inputs and the Node requirement exist',async t=>{
  const seen=[];
  const c=await fixture(t,async j=>{seen.push(j.environment);return submitted;});
  const alias=path.join(path.dirname(c.cwd),'alias');
  fs.symlinkSync(c.cwd,alias,process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(path.join(c.cwd,'only-in-parent.txt'),'uncommitted');
  const missing=await submit(c,{}, {requiredFiles:['only-in-parent.txt']});
  await done(c,missing.id);
  assert.equal(missing.status,'blocked');assert.equal(missing.blockedBy,'environment');assert.match(missing.reason,/Parent uncommitted files are not copied/);
  const badNode=await submit(c,{}, {minNodeMajor:999});
  await done(c,badNode.id);
  assert.equal(badNode.status,'blocked');assert.equal(badNode.blockedBy,'environment');assert.match(badNode.reason,/Node.js 999\+/);
  assert.equal(seen.length,0);
  const base=await git(['rev-parse','HEAD'],c.cwd);
  const ok=await submit(c,{kind:'analysis',acceptance:[{description:'Report evidence',expected:'Records required file'}]}, {expectedRepoRoot:alias,expectedBase:base,minNodeMajor:22});
  await done(c,ok.id);
  assert.equal(ok.status,'review',ok.reason);
  assert.equal(seen.length,1);
  assert.equal(seen[0].repoRoot,fs.realpathSync.native(c.cwd));
  assert.equal(seen[0].checkout,fs.realpathSync.native(ok.cwd));
  assert.equal(seen[0].base,base);assert.match(seen[0].nodeVersion,/^v\d+/);
});
test('an explicit baseline for a queued task is checked again before any worker checkout',async t=>{
  const release=Promise.withResolvers();let calls=0;
  const c=await fixture(t,async j=>{calls++;await release.promise;fs.writeFileSync(path.join(j.cwd,'hello.txt'),'hello');return submitted;},{maxConcurrent:1});
  try{
    const first=await submit(c);
    const queued=await submit(c,{}, {expectedBase:await git(['rev-parse','HEAD'],c.cwd)});
    assert.equal(queued.status,'queued');
    await git(['commit','--allow-empty','-qm','changed while queued'],c.cwd);
    release.resolve();await done(c,first.id);await done(c,queued.id);
    assert.equal(queued.status,'blocked');assert.equal(queued.blockedBy,'environment');assert.match(queued.reason,/Baseline mismatch/);
    assert.equal(queued.worktreeReady,undefined);assert.equal(calls,1);
  }finally{release.resolve();}
});
test('path globs handle nested files, regex punctuation, and traversal',()=>{
  for(const p of ['src/a.ts','src/nested/a.ts'])assert(allowedPath(p,['src/**/*.ts']));
  assert(allowedPath('src/a[1].ts',['src/a[1].ts']));
  assert(!allowedPath('src/a1.ts',['src/a[1].ts']));
  assert(allowedPath('src/a.ts',['src/']));assert(!allowedPath('src2/a.ts',['src/']));
  for(const p of ['../secret','src/../secret','/etc/passwd','.git/config'])assert(!allowedPath(p,['**']));
});
test('usage counts once and keeps actual models separate',()=>{
  const a={id:'a',type:'message',message:{role:'assistant',provider:'p',model:'one',usage:{input:10,output:5,cacheRead:20,cacheWrite:2}}};
  const b={id:'b',type:'message',message:{role:'assistant',provider:'p',model:'two',usage:{input:1,output:2}}};
  assert.equal(usageFromEntries([a,a,b]).total,40);assert.equal(usageByModel([a,a,b])['p/one'].total,37);
});
test('disabled mode cannot submit; queue cancellation leaves active work running',async t=>{
  let release;const gate=new Promise(r=>release=r);
  const c=await fixture(t,async j=>{await gate;fs.writeFileSync(path.join(j.cwd,'hello.txt'),'hello');return submitted;},{maxConcurrent:1});
  c.configure({mode:'off'});await assert.rejects(submit(c),/off/);c.configure({mode:'auto'});
  const a=await submit(c),b=await submit(c);c.configure({mode:'off'});
  assert.equal(b.status,'cancelled');assert.equal(a.status,'running');release();assert.equal((await done(c,a.id)).status,'review');
});
test('concurrency cap, independent check, review gate and accepted dependencies',async t=>{
  let active=0,peak=0;
  // Worktree setup can take over 100ms on Windows. Keep the first worker alive
  // until both workers enter, rather than relying on two sleeps overlapping.
  const gate=Promise.withResolvers();
  const c=await fixture(t,async j=>{
    peak=Math.max(peak,++active);
    if(active===2)gate.resolve();
    await gate.promise;
    fs.writeFileSync(path.join(j.cwd,'hello.txt'),'hello');active--;return submitted;
  },{maxConcurrent:2});
  try{
    const a=await submit(c),b=await submit(c),dep=await submit(c,{dependencies:[a.id]});
    assert.equal(dep.status,'waiting');assert.throws(()=>c.review(a.id,'accept','Evidence of an unvalidated result'),/validated/);
    await done(c,a.id);await done(c,b.id);assert.equal(peak,2);assert.equal(dep.status,'waiting');
    assert.equal(a.validation[0].code,0);c.review(a.id,'accept','Reviewed fixture diff and verified exact output with the acceptance command.');
    await done(c,dep.id);assert.equal(dep.status,'review');assert.equal(a.status,'accepted');
    assert.equal(fs.readFileSync(path.join(c.cwd,'hello.txt'),'utf8'),'before\n','parent checkout untouched');
  }finally{gate.resolve();}
});
test('out-of-scope writes and failed validation become blocked',async t=>{
  const c=await fixture(t,async j=>{fs.writeFileSync(path.join(j.cwd,'other.txt'),'oops');return submitted;});
  const a=await submit(c);assert.equal((await done(c,a.id)).status,'blocked');assert.match(a.reason,/outside spec/);
  const c2=await fixture(t,async()=>submitted);const b=await submit(c2);assert.equal((await done(c2,b.id)).status,'blocked');assert.equal(b.validation[0].code,1);
});
test('acceptance command changing scope is detected after validation',async t=>{
  const c=await fixture(t,async j=>{fs.writeFileSync(path.join(j.cwd,'hello.txt'),'hello');return submitted;});
  const a=await submit(c,{acceptance:[{description:'Bad validation',command:"node -e \"require('fs').writeFileSync('unexpected.txt','')\"",expected:'0'}]});
  assert.equal((await done(c,a.id)).status,'blocked');assert.match(a.reason,/outside spec/);
});
test('worker blocker blocks dependents and never self-accepts',async t=>{
  const c=await fixture(t,async()=>({report:{status:'blocked',summary:'Missing contract decision',evidence:[]}}));
  const a=await submit(c),b=await submit(c,{dependencies:[a.id]});await done(c,a.id);assert.equal(a.status,'blocked');assert.equal(b.status,'blocked');
  assert.throws(()=>c.review(a.id,'accept','Cannot approve missing implementation'),/validated/);
});
test('abort propagates and prevents validation',async t=>{
  const c=await fixture(t,async (_,{signal})=>{await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener('abort',r,{once:true});});return submitted;});
  const a=await submit(c);c.cancel(a.id);assert.equal((await done(c,a.id)).status,'cancelled');assert.equal(a.reason,'Stopped by user');assert.equal(a.validation,undefined);
});
test('hard deadline aborts work, obtains one report and never resumes without a matching decision',async t=>{
  assert.equal(MAX_WORK_SLICE_MS,1800000);
  let slices=0,reports=0,firstCwd;const notices=[];
  const c=await fixture(t,async(j,{signal,control})=>{
    if(++slices===1){
      firstCwd=j.cwd;fs.writeFileSync(path.join(j.cwd,'hello.txt'),'partial');
      control.summarize=async()=>{reports++;return {summary:'Partial file written; final assertion pending'};};
      await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return submitted; // late delivery cannot win
    }
    assert.equal(firstCwd,j.cwd);assert.equal(fs.readFileSync(path.join(j.cwd,'hello.txt'),'utf8'),'partial');
    fs.writeFileSync(path.join(j.cwd,'hello.txt'),'hello');return submitted;
  },{maxConcurrent:1});
  c.handoffAfterMs=1200;c.notify=j=>notices.push(j.status);
  const j=await submit(c);await done(c,j.id);
  assert.equal(j.status,'paused');assert.equal(j.checkpoint.source,'worker');assert.equal(reports,1);assert.deepEqual(notices,['paused']);
  await assert.rejects(c.steer(j.id,'continue','finish','stale'),/checkpointId/);
  await assert.rejects(c.steer(j.id,'guide','bypass'),/checkpointId/);
  assert.equal(slices,1);assert.equal(j.validation,undefined);
  await c.steer(j.id,'continue','Finish only the assertion',j.checkpoint.id);await done(c,j.id);
  assert.equal(j.status,'review',j.reason);assert.equal(slices,2);assert.equal(j.validation[0].code,0);assert.deepEqual(notices,['paused','review']);
});
test('failed report yields runtime fallback, stop does not restart work or permit self-acceptance',async t=>{
  const ready=Promise.withResolvers();let reports=0;
  const c=await fixture(t,async(_j,{signal,control,onProgress})=>{
    control.summarize=async()=>{reports++;throw new Error('provider offline');};onProgress({activity:'read started'});ready.resolve();
    await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return submitted;
  });
  const j=await submit(c);await ready.promise;await c.steer(j.id,'summary');await done(c,j.id);
  assert.equal(reports,1);assert.equal(j.status,'paused');assert.equal(j.checkpoint.source,'runtime');assert.match(j.checkpoint.summary,/read started/);
  await assert.rejects(c.steer(j.id,'stop'),/checkpointId/);await c.steer(j.id,'stop','Blocked by missing input',j.checkpoint.id);
  assert.equal(j.status,'cancelled');assert.equal(j.reason,'Stopped by main agent: Blocked by missing input');await assert.rejects(c.steer(j.id,'continue','restart',j.checkpoint.id),/paused/);
});
test('restart freezes elapsed time at last checkpoint; session configuration survives',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delegation-recovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now();atomicJson(path.join(dir,'runs','s.json'),{updatedAt:now-100000,config:{...DEFAULTS,mode:'auto'},sessionId:'s',parent:{model:'p/a',status:'running',usage:blankUsage(),activeSince:now-101000,activeMs:100},jobs:{a:{id:'a',status:'running',activeSince:now-102000,activeMs:300}}});
  const c=new Coordinator({dir,sessionId:'s',cwd:dir,runner:async()=>submitted});
  assert.equal(c.state.jobs.a.status,'interrupted');assert.equal(elapsed(c.state.jobs.a),2300);assert.equal(elapsed(c.state.parent),1100);assert.equal(c.config.mode,'auto');c.close();
});
test('panel reflects blocked, review, model, settled tokens and time',()=>{
  const state={parent:{model:'main/a',status:'idle',usage:{...blankUsage(),input:10,total:10}},jobs:{a:{id:'a',model:'exec/b',status:'blocked',spec:{title:'API'},usage:blankUsage(),activeMs:2000,reason:'Missing spec'}}};
  const lines=treeLines(state,DEFAULTS,Date.now(),false).join('\n');for(const text of ['main/a','exec/b','1 阻塞','Missing spec','2s','已结算'])assert(lines.includes(text));
});
test('command timeout terminates work and returns a bounded result',async()=>{
  const result=await run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50});assert.equal(result.timedOut,true);assert.notEqual(result.code,0);
});
