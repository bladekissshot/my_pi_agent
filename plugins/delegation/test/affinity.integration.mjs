import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { loadSdk, repositoryRoot } from './sdk-loader.mjs';
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = await loadSdk();

const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-header-test-'));
const extension=path.join(repositoryRoot,'integrations/pi-agent/session-affinity.ts');
const captures=[];
const server=http.createServer(async(req,res)=>{
  for await (const _ of req) { /* Drain test payload without storing it. */ }
  captures.push({url:req.url,affinity:req.headers['x-session-affinity'],legacy:req.headers['x-session-id']});
  // A deliberate non-retryable response is sufficient to inspect the real outgoing HTTP headers.
  res.writeHead(400,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{message:'Local header capture completed',type:'invalid_request_error',code:400,status:'INVALID_ARGUMENT'}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const source=JSON.parse(await fs.readFile(path.join(repositoryRoot,'examples/models.example.json'),'utf8'));
source.providers.company={...source.providers.modelhub,models:source.providers.modelhub.models.filter(m=>m.id==='gpt-6.1-sol')};
const providers={};
for(const [provider,p] of Object.entries(source.providers)) {
  providers[provider]={baseUrl:origin,api:p.api,apiKey:'local-test-dummy',authHeader:true,models:p.models.map(m=>({
    ...m,baseUrl:m.api==='google-generative-ai'?origin+'/v1beta':m.api==='openai-responses'||(!m.api&&p.api==='openai-responses')?origin+'/v1':origin,
    headers:{'X-Session-Affinity':'stale-test-value'},
  }))};
}
await fs.writeFile(path.join(root,'models.json'),JSON.stringify({providers}));
await fs.writeFile(path.join(root,'auth.json'),'{}');
const runtime=await ModelRuntime.create({modelsPath:path.join(root,'models.json'),authPath:path.join(root,'auth.json'),modelsStorePath:path.join(root,'model-store.json'),allowModelNetwork:false});
const sessions=[];
const results=[];
async function makeSession() {
  const settings=SettingsManager.inMemory({defaultProvider:'modelhub',defaultModel:'gpt-6.1-sol',defaultThinkingLevel:'high'});
  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,additionalExtensionPaths:[extension],noExtensions:true,disabledBuiltinExtensions:['mcp'],noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,systemPrompt:'Local header test.'});
  await loader.reload();
  const {session,extensionsResult}=await createAgentSession({cwd:root,agentDir:root,settingsManager:settings,resourceLoader:loader,modelRuntime:runtime,model:runtime.getModel('modelhub','gpt-6.1-sol'),sessionManager:SessionManager.inMemory(root),tools:[]});
  assert.equal(extensionsResult.errors.length,0);
  assert(extensionsResult.extensions.some(e=>e.path===extension),'installed extension was loaded');
  sessions.push(session);
  return session;
}
async function request(session,provider,id) {
  await session.setModel(runtime.getModel(provider,id));
  const before=captures.length;
  await session.prompt('Only test request headers.');
  assert.equal(captures.length,before+1,`${provider}/${id}: expected one HTTP request`);
  const capture=captures.at(-1);
  assert.equal(capture.affinity,session.sessionId,`${provider}/${id}: current session id`);
  if(provider==='company') assert.equal(capture.legacy,session.sessionId,'legacy company header retained');
  results.push({provider,model:id,api:runtime.getModel(provider,id).api,headerMatchesSession:true});
}
try {
  const a=await makeSession();
  for(const [provider,p] of Object.entries(providers)) for(const model of p.models) await request(a,provider,model.id);
  await request(a,'modelhub','gpt-6.1-sol');
  const b=await makeSession();
  assert.notEqual(a.sessionId,b.sessionId,'new session has a new id');
  await request(b,'modelhub','gpt-6.1-sol');
  await request(a,'modelhub','gemini-4-argon');
  console.log(JSON.stringify({ok:true,requests:results.length,sameSessionStable:true,newSessionDifferent:true,interleavedSessionsIsolated:true,results},null,2));

} finally {
  for(const s of sessions)s.dispose();
  await new Promise(resolve=>server.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
