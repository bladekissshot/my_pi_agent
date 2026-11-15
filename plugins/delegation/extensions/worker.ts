import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { allowedPath, usageFromEntries } from '../lib/core.mjs';

export async function runWorker(task: any, options: any) {
  const { agentDir, dataDir, parentId, signal, onProgress } = options;
  const runtime = await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),allowModelNetwork:false});
  const slash=task.model.indexOf('/');
  const model=runtime.getModel(task.model.slice(0,slash),task.model.slice(slash+1));
  if(!model)throw new Error(`Execution model unavailable: ${task.model}`);
  if(!(await runtime.getAvailable()).some(m=>m.provider===model.provider&&m.id===model.id))throw new Error(`No configured credentials for ${task.model}`);
  let report:any,turns=0,session:any,lastError='';
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},defaultThinkingLevel:task.config.thinking});
  const systemPrompt=[
    'You are the execution model in a two-role delegation workflow. The main model owns planning, contract changes, complex debugging, and acceptance.',
    'Work ONLY on the task spec below. Read relevant code first. Keep changes within allowedPaths. Choose local implementation details freely inside the contract.',
    'If requirements conflict, prerequisites are absent, or scope must grow, call worker_report with status blocked and the precise missing decision. Do not guess a new contract.',
    'Do not delegate, change model/provider settings, modify .git internals, push, publish, merge, or reset unrelated work. Work in the supplied isolated checkout. Leave a reviewable diff; no commit is required.',
    task.spec.kind==='analysis'?'This is a read-only investigation. Do not modify files.':'Implement the task and run its acceptance checks. Do not weaken tests or acceptance criteria to make them pass.',
    'Before finishing, call worker_report. submitted means ready for main-model review, not accepted. Give concise evidence and blockers; do not paste whole files.',
    `Task ${task.id}. Base commit ${task.base}. Immutable spec hash ${task.specHash}.`,
    JSON.stringify(task.spec,null,2),
  ].join('\n\n');
  const loader=new DefaultResourceLoader({
    cwd:task.cwd,agentDir,settingsManager:settings,noExtensions:true,disabledBuiltinExtensions:['mcp','codemode'],noSkills:true,noPromptTemplates:true,noContextFiles:false,noThemes:true,systemPrompt,
    extensionFactories:[(pi:any)=>{
      pi.on('before_provider_headers',(event:any,ctx:any)=>{
        for(const k of Object.keys(event.headers))if(k.toLowerCase()==='x-session-affinity')delete event.headers[k];
        event.headers['x-session-affinity']=ctx.sessionManager.getSessionId();
      });
      pi.on('tool_call',(event:any)=>{
        if(report&&event.toolName!=='worker_report')return {block:true,reason:'Report already submitted. Finish the turn.'};
        if(['edit','write'].includes(event.toolName)) {
          if(task.spec.kind==='analysis')return {block:true,reason:'Read-only task'};
          const target=path.resolve(task.cwd,event.input.path||'');
          const relative=path.relative(task.cwd,target).split(path.sep).join('/');
          if(!allowedPath(relative,task.spec.allowedPaths))return {block:true,reason:'File is outside the task spec. Report the missing scope instead.'};
          let p=path.dirname(target);
          while(!fs.existsSync(p)&&p!==path.dirname(p))p=path.dirname(p);
          const real=path.relative(fs.realpathSync(task.cwd),fs.realpathSync(p));
          if(real.startsWith('..')||path.isAbsolute(real))return {block:true,reason:'Symlink escapes the task worktree'};
          if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())return {block:true,reason:'Write through symlink is not allowed'};
        }
      });
      pi.on('message_end',(event:any)=>{
        if(event.message?.role==='assistant') {
          turns++;
          if(event.message.stopReason==='error')lastError=event.message.errorMessage||'Provider error';
        }
      });
      pi.on('turn_end',()=>{
        // Finish the last permitted tool turn before stopping. A submitted report needs no extra model call.
        if(report||turns>=task.config.maxTurns)queueMicrotask(()=>session?.abort());
      });
    }],
  });
  await loader.reload();
  if(signal.aborted)throw new Error('Cancelled during worker setup');
  const manager=SessionManager.create(task.cwd,path.join(dataDir,'sessions'));
  manager.appendCustomEntry('pi-delegation:worker',{parentId,taskId:task.id,model:task.model,specHash:task.specHash});
  const result=await createAgentSession({cwd:task.cwd,agentDir,modelRuntime:runtime,model,thinkingLevel:task.config.thinking,settingsManager:settings,resourceLoader:loader,sessionManager:manager,
    tools:task.spec.kind==='analysis'?['read','grep','find','ls','worker_report']:['read','bash','edit','write','grep','find','ls','worker_report'],
    customTools:[{
      name:'worker_report',label:'Submit task report',description:'Submit an implementation for review, or report a blocking spec gap. This does not accept the task.',
      parameters:Type.Object({status:Type.Union([Type.Literal('submitted'),Type.Literal('blocked')]),summary:Type.String(),evidence:Type.Array(Type.String())}),
      async execute(_id:any,input:any){report={...input,at:Date.now()};return {content:[{type:'text',text:'Report recorded. Finish now; the main model will review it.'}],details:{}};},
    }],
  });
  session=result.session;
  if(result.extensionsResult.errors.length){session.dispose();throw new Error('Worker extension failed to load');}
  const abort=()=>session.abort();signal.addEventListener('abort',abort,{once:true});
  const update=()=>onProgress({usage:usageFromEntries(manager.getEntries()),sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),turns});
  const unsubscribe=session.subscribe((event:any)=>{if(event.type==='message_end'||event.type==='message_update')update();});
  try {
    if(signal.aborted)throw new Error('Cancelled before worker prompt');
    await session.prompt('Execute the task spec. If it cannot be executed as specified, report the exact blocker.');
    update();
    return {report,usage:usageFromEntries(manager.getEntries()),sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),turns,error:lastError||(!report&&turns>=task.config.maxTurns?'Turn budget reached; main-model intervention required.':undefined)};
  } finally {
    signal.removeEventListener('abort',abort);unsubscribe();session.dispose();
  }
}
