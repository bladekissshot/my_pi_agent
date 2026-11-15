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
const requests=[],counts=new Map();let mainCalls=0;
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);
  if(body.model==='main'){
    mainCalls++;if(mainCalls===1)await new Promise(r=>setTimeout(r,1200));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    send('message_start',{message:{id:'main-'+mainCalls,type:'message',role:'assistant',model:'main',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
    send('content_block_start',{index:0,content_block:{type:'text',text:''}});send('content_block_delta',{index:0,delta:{type:'text_delta',text:'Report acknowledged as task data.'}});send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}});send('message_stop',{});res.end();return;
  }
  const affinity=req.headers['x-session-affinity'];requests.push({affinity,model:body.model});
  const step=counts.get(affinity)||0;counts.set(affinity,step+1);
  const blocked=JSON.stringify(body.system).includes('Deliberate blocker');
  const outOfScope=JSON.stringify(body.system).includes('Scope guard');
  const id='msg-'+requests.length;
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  send('message_start',{message:{id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:30,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
  if(step<2){
    const report=blocked||step===1;
    const name=report?'worker_report':'write';
    const input=report?{status:blocked?'blocked':'submitted',summary:blocked?'Missing a required API decision':'Ready for review',evidence:['Fixture execution']}:{path:outOfScope?'outside.txt':'hello.txt',content:'hello\n'};
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
  c.notify=originalNotify;
  const prompting=session.prompt('Local notification test.');
  const firstRequestDeadline=Date.now()+10000;
  while(mainCalls===0){if(Date.now()>firstRequestDeadline)throw new Error('Main test request did not start');await new Promise(r=>setTimeout(r,10));}
  const notifying=c.submit({...input,title:'Completion while main is busy'});
  await c.wait([notifying.id],10000);await prompting;
  assert.equal(mainCalls,2,'completion is consumed during active turn, without a late follow-up turn');
  assert(session.sessionManager.getEntries().some(e=>e.type==='custom_message'&&e.customType==='pi-delegation-result'));
  await session.prompt('/delegation off');assert(!session.getActiveToolNames().includes('delegate_task'));
  assert.equal(errors.length,0,JSON.stringify(errors));
  const result={ok:true,root,requests:requests.length,uniqueWorkerSessions:counts.size,widgetUpdates:widgets.length,setupInputs,setupConfirmations,errors,reviewTask:ja.id,blockedTasks:[jb.id,jbad.id],sessionId:session.sessionId};
  console.log(JSON.stringify(result,null,2));
}finally{
  await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
}
