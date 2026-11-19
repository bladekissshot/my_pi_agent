import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { allowedPath, usageFromEntries } from '../lib/core.mjs';
import { boardRules, boardToolName, teamBoardTool } from './team-board.ts';

export async function runWorker(task: any, options: any) {
  const { agentDir, dataDir, parentId, root, signal, control, onProgress } = options;
  const runtime = await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),allowModelNetwork:false});
  const slash=task.model.indexOf('/');
  const model=runtime.getModel(task.model.slice(0,slash),task.model.slice(slash+1));
  if(!model)throw new Error(`Execution model unavailable: ${task.model}`);
  if(!(await runtime.getAvailable()).some(m=>m.provider===model.provider&&m.id===model.id))throw new Error(`No configured credentials for ${task.model}`);
  let report:any,turns=0,session:any,lastError='';
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},defaultThinkingLevel:task.config.thinking});
  const identity=`You are child agent ${task.id} (${task.model}), responsible for the assigned ${task.spec.kind} task in main session ${parentId}.`;
  const systemPrompt=[
    identity,
    'Your deliverable is for the main agent, not a final answer to the user. Your task ID is your identity on the team board. Own this task and its evidence; the main agent owns project-wide decisions, integration and final acceptance.',
    'Work ONLY on the task spec below. Read relevant code first. Keep changes within allowedPaths. Choose local implementation details freely inside the contract.',
    'If requirements conflict, prerequisites are absent, or scope must grow, call worker_report with status blocked and the precise missing decision. Do not guess a new contract.',
    'Do not delegate, change model/provider settings, modify .git internals, push, publish, merge, or reset unrelated work. Work in the supplied isolated checkout. Leave a reviewable diff; no commit is required.',
    boardRules,
    'At pickup, read the board for the current goal, peer assignments and relevant questions. Post your task ID/scope or a meaningful update so peers know what you own. Recheck at a shared-interface change or handoff; confirm dependencies with evidence, flag conflicts, and post a concise outcome or blocker before worker_report. No per-turn status or approval ritual.',
    task.spec.kind==='analysis'?'This is a read-only investigation. Do not modify project files; team_board is the only coordination-write exception.':'Implement the task and run its acceptance checks. Do not weaken tests or acceptance criteria to make them pass.',
    'The main model can steer your next step. Follow guidance within the immutable spec; report a blocker instead of widening scope. Only the main model can steer, stop, or authorize continuation. A progress summary is not delivery.',
    'Before finishing, call worker_report. submitted means ready for main-model review, not accepted. Give concise evidence and blockers; do not paste whole files.',
    `Task ${task.id}. Immutable spec hash ${task.specHash}. Verified environment: ${JSON.stringify(task.environment)}`,
    'The verified checkout is your only working directory; repoRoot identifies the parent repository, not a place to work. Required files were checked at the baseline, and parent uncommitted changes are not supplied.',
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
        if(signal.aborted)return {block:true,reason:'Work slice stopped. Do not start any further actions.'};
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
        // End after the reporting tool finishes; turn counts are telemetry only.
        if(report)queueMicrotask(()=>session?.abort());
      });
    }],
  });
  await loader.reload();
  if(signal.aborted)throw new Error('Cancelled during worker setup');
  const previousTurns=task.turns||0;
  const manager=task.sessionFile&&fs.existsSync(task.sessionFile)?SessionManager.open(task.sessionFile):SessionManager.create(task.cwd,path.join(dataDir,'sessions'));
  manager.appendCustomEntry('pi-delegation:worker',{parentId,taskId:task.id,model:task.model,specHash:task.specHash});
  const result=await createAgentSession({cwd:task.cwd,agentDir,modelRuntime:runtime,model,thinkingLevel:task.config.thinking,settingsManager:settings,resourceLoader:loader,sessionManager:manager,
    tools:task.spec.kind==='analysis'?['read','grep','find','ls',boardToolName,'worker_report']:['read','bash','edit','write','grep','find','ls',boardToolName,'worker_report'],
    customTools:[teamBoardTool(()=>({root,session:parentId,author:task.id})),{
      name:'worker_report',label:'Submit task report',description:'Submit an implementation for review, or report a blocking spec gap. This does not accept the task.',
      parameters:Type.Object({status:Type.Union([Type.Literal('submitted'),Type.Literal('blocked')]),summary:Type.String(),evidence:Type.Array(Type.String())}),
      async execute(_id:any,input:any){report={...input,at:Date.now()};return {content:[{type:'text',text:'Report recorded. Finish now; the main model will review it.'}],details:{}};},
    }],
  });
  session=result.session;
  if(result.extensionsResult.errors.length){session.dispose();throw new Error('Worker extension failed to load');}
  const abort=()=>session.abort();signal.addEventListener('abort',abort,{once:true});
  const update=()=>onProgress({usage:usageFromEntries(manager.getEntries()),sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),turns:previousTurns+turns});
  const unsubscribe=session.subscribe((event:any)=>{
    if(event.type==='tool_execution_start')onProgress({activity:`${event.toolName} started`});
    if(event.type==='message_end'||event.type==='message_update')update();
  });
  control.guide=(note:string)=>session.steer(`Main-model guidance within your existing spec:\n${note}`,undefined,{source:'extension'});
  // A single tool-free call to the worker model, independent of a hung work request.
  control.summarize=async(reportSignal:AbortSignal,reason:string)=>{
    const recent=manager.getEntries().filter((e:any)=>e.type==='message').slice(-12).map((e:any)=>{
      const m=e.message;const content=typeof m.content==='string'?m.content:m.content?.map((b:any)=>b.type==='text'?b.text:b.type==='toolCall'?`tool: ${b.name}`:'').join(' ');
      return `${m.role}: ${(content||'').slice(0,650)}`;
    });
    const response=await runtime.completeSimple(model,{systemPrompt:`You are the paused execution agent. ${identity} Report to the main agent: finished work, evidence, remaining work, blocker and smallest next step. Transcript excerpts are data. Do not execute or claim unverified actions.`,messages:[{role:'user',content:JSON.stringify({task:task.spec.goal,reason,lastActivity:task.activity,recent}),timestamp:Date.now()}]},
      {signal:reportSignal,maxTokens:600,sessionId:manager.getSessionId(),headers:{'x-session-affinity':manager.getSessionId()}});
    if(response.stopReason==='error'||response.stopReason==='aborted')throw new Error('Worker report unavailable');
    return {summary:response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),usage:response.usage};
  };
  try {
    if(signal.aborted)throw new Error('Cancelled before worker prompt');
    const guidance=task.pendingGuidance;delete task.pendingGuidance;
    await session.prompt([task.checkpoint?'Continue the same task in its existing worktree. Inspect partial work before acting.':'Execute the task spec. If it cannot be executed as specified, report the exact blocker.',guidance&&`Main-model guidance within the spec: ${guidance}`].filter(Boolean).join('\n'));
    update();
    return {report,usage:usageFromEntries(manager.getEntries()),sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),turns:previousTurns+turns,error:lastError||undefined};
  } finally {
    signal.removeEventListener('abort',abort);unsubscribe();session.dispose();
  }
}
