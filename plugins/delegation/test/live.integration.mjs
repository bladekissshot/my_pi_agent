import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadSdk, repositoryRoot } from './sdk-loader.mjs';
import {git,atomicJson,DEFAULTS} from '../lib/core.mjs';
if(process.env.PI_LIVE_TEST!=='1'||!process.env.PI_MAIN_MODEL||!process.env.PI_EXEC_MODEL)throw new Error('Live tests make paid requests. Set PI_LIVE_TEST=1, PI_MAIN_MODEL=provider/model and PI_EXEC_MODEL=provider/model.');
const sourceAgentDir=process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.pi/agent');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delegation-live-'));
const agentDir=path.join(root,'agent');fs.mkdirSync(agentDir,{mode:0o700});
for(const file of ['models.json','auth.json']){fs.copyFileSync(path.join(sourceAgentDir,file),path.join(agentDir,file));fs.chmodSync(path.join(agentDir,file),0o600);}
process.env.PI_CODING_AGENT_DIR=agentDir;
const {createAgentSession,DefaultResourceLoader,ModelRuntime,SettingsManager,SessionManager}=await loadSdk();
atomicJson(path.join(agentDir,'pi-delegation','config.json'),{...DEFAULTS,execModel:process.env.PI_EXEC_MODEL,execThinking:'low',taskTimeoutMs:180000,maxConcurrent:3});
const cwd=path.join(root,'repo');fs.mkdirSync(cwd);await git(['init','-q'],cwd);await git(['config','user.email','test@example.invalid'],cwd);await git(['config','user.name','Test'],cwd);
fs.writeFileSync(path.join(cwd,'README.md'),'Minimal delegation validation fixture. No dependencies.\n');await git(['add','.'],cwd);await git(['commit','-qm','fixture'],cwd);
const runtime=await ModelRuntime.create({modelsPath:path.join(agentDir,'models.json'),authPath:path.join(agentDir,'auth.json'),allowModelNetwork:false});
const settings=SettingsManager.inMemory({});
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:true,additionalExtensionPaths:[repositoryRoot],disabledBuiltinExtensions:['mcp','codemode'],noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true});
await loader.reload();const {session,extensionsResult}=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model:runtime.getModel(...process.env.PI_MAIN_MODEL.split(/\/(.*)/s).slice(0,2)),settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(agentDir,'parent-sessions'))});
const errors=[];
try{
  assert.equal(extensionsResult.errors.length,0,JSON.stringify(extensionsResult.errors));
  await session.bindExtensions({mode:'rpc',uiContext:{...session.extensionRunner.getUIContext(),setWidget:()=>{},setStatus:()=>{},notify:(msg,kind)=>{if(kind==='error')errors.push(msg);}},onError:e=>errors.push(e.message)});
  await session.prompt('/delegation auto');
  const c=globalThis[Symbol.for('pi-delegation/controllers/v1')].get(session.sessionId);
  c.notify=j=>console.log(JSON.stringify({completed:j.id,status:j.status,tokens:j.usage.total,reason:j.reason}));
  const input=letter=>({environment:{expectedRepoRoot:cwd,requiredFiles:['README.md']},title:'Live fixture '+letter,goal:`Create greeting-${letter}.txt containing exactly hello ${letter} followed by one newline.`,context:'This is an isolated test repository containing only README.md. No application dependencies. You only need to write one text file and validate it.',kind:'implementation',requirements:[`File greeting-${letter}.txt must contain exactly hello ${letter} followed by one newline.`],constraints:['Do not change README.md or any other file. Do not commit.'],allowedPaths:[`greeting-${letter}.txt`],acceptance:[{description:'Exact greeting bytes',command:`node -e "if(require('fs').readFileSync('greeting-${letter}.txt','utf8')!=='hello ${letter}\\n')process.exit(1)"`,expected:'Exit zero'}]});
  const a=await c.submit(input('A')),b=await c.submit(input('B'));
  const blocked=await c.submit({environment:{expectedRepoRoot:cwd,requiredFiles:[]},title:'Missing API contract',goal:'Determine the authoritative API response schema from CONTRACT.md.',context:'CONTRACT.md is the sole permitted source of truth. If it is absent, no schema is authorized and you must report blocked with the missing input.',kind:'analysis',requirements:['Read CONTRACT.md if present and extract the schema. Report blocked if absent.'],constraints:['Do not invent a schema or infer it from README.md. Read only.'],allowedPaths:['CONTRACT.md'],acceptance:[{description:'Authoritative evidence',expected:'Cite CONTRACT.md or report its absence as a blocker.'}]});
  console.log(JSON.stringify({root,ids:[a.id,b.id,blocked.id],parallel:c.active.size}));
  while(c.active.size){await c.wait([a.id,b.id,blocked.id],25000);console.log(JSON.stringify(Object.values(c.state.jobs).map(j=>({id:j.id,status:j.status,tokens:j.usage.total}))));}
  assert.equal(a.status,'review',a.reason);assert.equal(b.status,'review',b.reason);assert.equal(blocked.status,'blocked',blocked.reason);
  for(const [job,letter] of [[a,'A'],[b,'B']]){
    assert.equal(fs.readFileSync(path.join(job.cwd,`greeting-${letter}.txt`),'utf8'),`hello ${letter}\n`);assert.equal(job.validation[0].code,0);assert(job.usage.total>0);
    c.review(job.id,'accept','Reviewed the isolated fixture diff and independently verified exact greeting bytes. This disposable fixture requires no integration.');
  }
  assert.equal(fs.existsSync(path.join(cwd,'greeting-A.txt')),false);assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('LIVE INTEGRATION PASSED');
}finally{
  await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();
  fs.rmSync(root,{recursive:true,force:true});
}
