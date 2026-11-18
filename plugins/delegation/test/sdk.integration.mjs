import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { loadSdk, repositoryRoot } from './sdk-loader.mjs';
import {git,atomicJson,DEFAULTS} from '../lib/core.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delegation-sdk-'));
const agentDir=path.join(root,'agent');fs.mkdirSync(agentDir);process.env.PI_CODING_AGENT_DIR=agentDir;
const {createAgentSession,DefaultResourceLoader,ModelRuntime,SettingsManager,SessionManager}=await loadSdk();
const requests=[],counts=new Map();let mainCalls=0,checkpointDelivered=false,delayNextMain=false;
const steerRequests=[],releaseFirst=Promise.withResolvers(),releaseSecond=Promise.withResolvers();let reportTools,reportCalls=0,investigationPrompt;
async function until(check){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for fixture');await new Promise(r=>setTimeout(r,10));}}
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);
  if(body.model==='main'){
    mainCalls++;if(JSON.stringify(body.messages).includes('Read completed; bounded follow-up remains.'))checkpointDelivered=true;
    if(delayNextMain){delayNextMain=false;await new Promise(r=>setTimeout(r,1200));}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    send('message_start',{message:{id:'main-'+mainCalls,type:'message',role:'assistant',model:'main',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
    send('content_block_start',{index:0,content_block:{type:'text',text:''}});send('content_block_delta',{index:0,delta:{type:'text_delta',text:'Report acknowledged as task data.'}});send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}});send('message_stop',{});res.end();return;
  }
  const affinity=req.headers['x-session-affinity'];requests.push({affinity,model:body.model});
  const step=counts.get(affinity)||0;counts.set(affinity,step+1);
  const blocked=JSON.stringify(body.system).includes('Deliberate blocker');
  const outOfScope=JSON.stringify(body.system).includes('Scope guard');
  const boardWorker=JSON.stringify(body.system).includes('Board handoff fixture');
  const longWorker=JSON.stringify(body.system).includes('Long investigation fixture');
  if(longWorker&&step===0)investigationPrompt=JSON.stringify(body.system);
  const reportStep=longWorker?51:boardWorker?2:1;
  const sawGoal=JSON.stringify(body.messages).includes('Deliver fixture milestone');
  if(JSON.stringify(body.system).includes('Unresponsive worker')||JSON.stringify(body.messages).includes('unresponsive-fixture-goal')){
    await new Promise(r=>res.once('close',r));return;
  }
  const id='msg-'+requests.length;
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  send('message_start',{message:{id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:30,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
  if(JSON.stringify(body.system).includes('You are the paused execution agent')){
    reportCalls++;reportTools=body.tools||[];
    send('content_block_start',{index:0,content_block:{type:'text',text:''}});send('content_block_delta',{index:0,delta:{type:'text_delta',text:'Read completed; bounded follow-up remains.'}});send('content_block_stop',{index:0});
    send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}});
  }else if(JSON.stringify(body.system).includes('Steer fixture')){
    steerRequests.push({affinity,messages:JSON.stringify(body.messages),tools:body.tools.map(t=>t.name)});
    const index=steerRequests.length;
    if(index===1)await releaseFirst.promise;
    if(index===2){await releaseSecond.promise;if(res.destroyed)return;}
    const name=index===1?'read':'worker_report',input=index===1?{path:'hello.txt'}:{status:'submitted',summary:'Follow-up done',evidence:['Read hello.txt']};
    send('content_block_start',{index:0,content_block:{type:'tool_use',id:'steer-'+index,name,input:{}}});send('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}});send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:8}});
  }else if(step<=reportStep){
    const report=blocked||step===reportStep;
    const name=report?'worker_report':longWorker?'read':boardWorker?'team_board':'write';
    const input=longWorker&&!report?{path:'hello.txt'}:boardWorker&&!report?(step===0?{action:'read'}:{action:'post',kind:'confirm',text:sawGoal?'main: confirmed fixture milestone against hello.txt':'goal was not visible'}):report?{status:blocked?'blocked':'submitted',summary:blocked?'Missing a required API decision':'Ready for review',evidence:['Fixture execution']}:{path:outOfScope?'outside.txt':'hello.txt',content:'hello\n'};
    send('content_block_start',{index:0,content_block:{type:'tool_use',id:'call-'+requests.length,name,input:{}}});
    send('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}});
    send('content_block_stop',{index:0});
    send('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:15}});
  }else{
    send('content_block_start',{index:0,content_block:{type:'text',text:''}});
    send('content_block_delta',{index:0,delta:{type:'text_delta',text:'Reported.'}});send('content_block_stop',{index:0});
    send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}});
  }
  send('message_stop',{});res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
atomicJson(path.join(agentDir,'models.json'),{providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}`,api:'anthropic-messages',apiKey:'local-test-only',models:['worker','main'].map(id=>({id,name:id,reasoning:false,input:['text'],contextWindow:32000,maxTokens:2000}))}}});
atomicJson(path.join(agentDir,'auth.json'),{});
// Simulate an existing installation; its obsolete turn limit must not stop the worker.
atomicJson(path.join(agentDir,'pi-delegation','config.json'),{...DEFAULTS,execModel:'fixture/worker',execThinking:'off',maxTurns:6});
const cwd=path.join(root,'repo');fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'hello.txt'),'before\n');
const remote=path.join(root,'remote.git');fs.mkdirSync(remote);await git(['init','--bare','-q'],remote);
const runtime=await ModelRuntime.create({modelsPath:path.join(agentDir,'models.json'),authPath:path.join(agentDir,'auth.json'),allowModelNetwork:false});
const settings=SettingsManager.inMemory({});
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:true,additionalExtensionPaths:[repositoryRoot],disabledBuiltinExtensions:['mcp','codemode'],noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true});
await loader.reload();
const {session,extensionsResult}=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model:runtime.getModel('fixture','main'),settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(agentDir,'parent-sessions'))});
const widgets=[],errors=[];
try{
  assert.equal(extensionsResult.errors.length,0,JSON.stringify(extensionsResult.errors));
  let cancelUrl=true,confirmBaseline=false,setupInputs=0,setupConfirmations=0;
  const ui={...session.extensionRunner.getUIContext(),setWidget:(key,lines)=>widgets.push({key,lines}),setStatus:()=>{},notify:(msg,kind)=>{if(kind==='error')errors.push(msg);},
    input:async title=>{setupInputs++;return cancelUrl?undefined:title.includes('地址')?remote:title.includes('邮箱')?'test@example.invalid':'Test';},
    confirm:async()=>{setupConfirmations++;return confirmBaseline;},
  };
  await session.bindExtensions({mode:'rpc',uiContext:ui,onError:e=>errors.push(e.message)});
  assert(widgets.some(w=>w.key==='Delegation · 任务树'));assert(!session.getActiveToolNames().includes('delegate_task'));
  await session.prompt('/delegation auto');assert(!session.getActiveToolNames().includes('delegate_task'));assert(!fs.existsSync(path.join(cwd,'.git')));
  cancelUrl=false;
  await session.prompt('/delegation auto');assert(!session.getActiveToolNames().includes('delegate_task'));assert(!fs.existsSync(path.join(cwd,'.git')));
  confirmBaseline=true;
  await session.prompt('/delegation auto');assert(session.getActiveToolNames().includes('delegate_task'));
  assert(setupInputs>=3);assert.equal(setupConfirmations,2);
  assert.equal(await git(['show','HEAD:hello.txt'],cwd),'before');
  assert.equal(await git(['ls-remote',remote],cwd),'','setup did not publish');
  assert.equal(requests.length+mainCalls,0,'setup did not call a model');
  const c=globalThis[Symbol.for('pi-delegation/controllers/v1')].get(session.sessionId);assert(c);
  const notices=[],originalNotify=c.notify;c.notify=j=>notices.push(j.id);
  const input={title:'SDK fixture',goal:'Return exactly hello from the fixture file',context:'A committed minimal Git fixture contains hello.txt. Change just this file.',kind:'implementation',requirements:['Write hello in hello.txt'],constraints:['No changes beyond hello.txt'],allowedPaths:['hello.txt'],acceptance:[{description:'Greeting',command:"node -e \"if(require('fs').readFileSync('hello.txt','utf8').trim()!=='hello')process.exit(1)\"",expected:'Exit zero'}]};
  const tool=session.extensionRunner.getToolDefinition('delegate_task');
  const ctx=session.extensionRunner.createToolContext('test',undefined);
  const board=session.extensionRunner.getToolDefinition('team_board');
  assert(session.getActiveToolNames().includes('team_board'));
  const subdir=path.join(cwd,'nested');fs.mkdirSync(subdir);
  const post=await board.execute('goal',{action:'post',kind:'goal',text:'Deliver fixture milestone'},undefined,undefined,{...ctx,cwd:subdir});
  assert.match(post.content[0].text,/\/main \| goal \| Deliver fixture milestone/);
  assert(fs.existsSync(path.join(cwd,'TeamBoard.MD')));assert(!fs.existsSync(path.join(subdir,'TeamBoard.MD')));
  const unprepared=path.join(root,'unprepared');fs.mkdirSync(unprepared);
  const setupResult=await tool.execute('needs-setup',input,undefined,undefined,{...ctx,cwd:unprepared,hasUI:false});
  assert.equal(setupResult.isError,true);assert.equal(setupResult.details.setupRequired,true);
  assert.equal(Object.keys(c.state.jobs).length,0,'setup guidance does not create a blocked task');
  assert(!fs.existsSync(path.join(unprepared,'.git')));
  const a=await tool.execute('a',input,undefined,undefined,ctx);
  const b=await tool.execute('b',{...input,title:'Deliberate blocker'},undefined,undefined,ctx);
  await c.wait([a.details.taskId,b.details.taskId],15000);
  const ja=c.state.jobs[a.details.taskId],jb=c.state.jobs[b.details.taskId];
  assert.equal(ja.status,'review',ja.reason);assert.equal(jb.status,'blocked',jb.reason);
  assert.equal(ja.validation[0].code,0);assert(ja.usage.total>0);
  assert.notEqual(ja.sessionId,jb.sessionId);assert.notEqual(ja.sessionId,session.sessionId);
  assert.equal(requests.filter(r=>r.affinity===ja.sessionId).length,2);assert(requests.every(r=>r.affinity));
  assert.equal(notices.length,2);assert.equal(fs.readFileSync(path.join(cwd,'hello.txt'),'utf8'),'before\n');
  const bad=await tool.execute('bad',{...input,title:'Scope guard'},undefined,undefined,ctx);await c.wait([bad.details.taskId],10000);
  const jbad=c.state.jobs[bad.details.taskId];assert.equal(jbad.status,'blocked');assert(!fs.existsSync(path.join(jbad.cwd,'outside.txt')));
  c.configure({taskTimeoutMs:150}); // A short validation budget must not interrupt execution.
  const long=await tool.execute('long',{...input,title:'Long investigation fixture',kind:'analysis',acceptance:[{description:'Read only',expected:'Submit findings'}]},undefined,undefined,ctx);
  const [investigation]=await c.wait([long.details.taskId],25000);
  assert.equal(investigation.status,'review',investigation.reason);
  // Count real requests, not SDK message_end events (which can include a synthetic abort at shutdown).
  assert.equal(counts.get(investigation.sessionId),52,'all 51 tool rounds plus submission, with no extra model call');
  for(const field of [investigation.id,session.sessionId,investigation.model,investigation.spec.kind])assert(investigationPrompt.includes(field),`worker prompt must identify ${field}`);
  c.configure({taskTimeoutMs:DEFAULTS.taskTimeoutMs});
  c.handoffAfterMs=2500;c.reportGraceMs=450;
  const silent=c.submit({...input,title:'Unresponsive worker',goal:'Finish the unresponsive-fixture-goal'});
  await c.wait([silent.id],10000);
  assert.equal(silent.status,'paused',silent.reason);assert.equal(silent.checkpoint.source,'runtime');
  assert.equal(requests.filter(r=>r.affinity===silent.sessionId).length,2,'one work request and exactly one unsuccessful report request');
  assert.equal(await git(['diff','--exit-code',silent.base,'--','hello.txt'],silent.cwd),'');assert.equal(silent.validation,undefined);
  await c.steer(silent.id,'stop','',silent.checkpoint.id);
  c.handoffAfterMs=30*60_000;c.reportGraceMs=30_000;
  const handoff=await tool.execute('handoff',{...input,title:'Board handoff fixture',kind:'analysis',acceptance:[{description:'No code changes',expected:'confirm shared goal'}]},undefined,undefined,ctx);
  const [peer]=await c.wait([handoff.details.taskId],10000);
  assert.equal(peer.status,'review',peer.reason);assert.deepEqual(peer.changedFiles,[]);
  assert(!fs.existsSync(path.join(peer.cwd,'TeamBoard.MD')));
  const response=await board.execute('review-board',{action:'read'},undefined,undefined,ctx);
  assert(response.content[0].text.includes(`${session.sessionId}/${peer.id} | confirm | main: confirmed fixture milestone against hello.txt`));
  const steer=session.extensionRunner.getToolDefinition('delegate_steer');assert(session.getActiveToolNames().includes('delegate_steer'));
  const controlled=await tool.execute('controlled',{...input,title:'Steer fixture',kind:'analysis',acceptance:[{description:'Read only',expected:'No code changes'}]},undefined,undefined,ctx);
  const taskId=controlled.details.taskId,j=c.state.jobs[taskId];
  const command=(action,instruction,checkpointId)=>steer.execute(action,{taskId,action,instruction,checkpointId},undefined,undefined,ctx);
  await until(()=>steerRequests.length>=1);await command('guide','Check the fixture API first');releaseFirst.resolve();
  await until(()=>steerRequests.length>=2);assert(steerRequests[1].messages.includes('Check the fixture API first'));
  c.notify=job=>{if(job.status==='paused')originalNotify(job);else notices.push(job.id);};
  await command('summary','Summarize the remaining work');const [paused]=await c.wait([taskId],10000);releaseSecond.resolve();
  assert.equal(paused.status,'paused',paused.reason);assert.equal(reportCalls,1);assert.deepEqual(reportTools,[]);assert.equal(j.checkpoint.source,'worker',JSON.stringify(j.checkpoint));
  assert.match(j.checkpoint.summary,/bounded follow-up/);assert.equal(j.reportUsage.output,5);
  await until(()=>checkpointDelivered);await session.waitForIdle();
  assert(session.sessionManager.getEntries().some(e=>e.type==='custom_message'&&e.customType==='pi-delegation-checkpoint'&&e.details.checkpointId===j.checkpoint.id));
  await command('continue','Only deliver the fixture evidence',j.checkpoint.id);await c.wait([taskId],10000);
  assert.equal(j.status,'review',j.reason);assert.equal(steerRequests.length,3);assert(steerRequests[2].messages.includes('Only deliver the fixture evidence'));
  assert.equal(steerRequests[2].affinity,steerRequests[0].affinity);assert(steerRequests.every(r=>!r.tools.includes('delegate_steer')));
  c.notify=originalNotify;
  const previousMain=mainCalls;delayNextMain=true;
  const prompting=session.prompt('Local notification test.');
  await until(()=>mainCalls>previousMain);
  const notifying=c.submit({...input,title:'Completion while main is busy'});
  await c.wait([notifying.id],10000);await prompting;
  assert.equal(mainCalls-previousMain,2,'completion is consumed during active turn, without a late follow-up turn');
  assert(session.sessionManager.getEntries().some(e=>e.type==='custom_message'&&e.customType==='pi-delegation-result'));
  await session.prompt('/delegation off');assert(!session.getActiveToolNames().includes('delegate_task'));
  assert(!session.getActiveToolNames().includes('team_board'));assert(!session.getActiveToolNames().includes('delegate_steer'));
  assert.equal(errors.length,0,JSON.stringify(errors));
  const result={ok:true,root,requests:requests.length,uniqueWorkerSessions:counts.size,widgetUpdates:widgets.length,setupInputs,setupConfirmations,errors,reviewTask:ja.id,blockedTasks:[jb.id,jbad.id],sessionId:session.sessionId};
  console.log(JSON.stringify(result,null,2));
}finally{
  releaseFirst.resolve();releaseSecond.resolve();
  await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
}
