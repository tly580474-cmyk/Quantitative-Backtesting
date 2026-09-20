import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { PiAgentProvider } from './piAgentProvider.js';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = vi.fn();
  return { ...actual, spawn, default: { ...actual, spawn } };
});
it('maps Pi events, excludes thinking, preserves failures and resumes exact sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(),'pi-provider-'));
  const child = Object.assign(new EventEmitter(), { stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as never);
  const events: unknown[] = [];
  const session = vi.fn(async()=>{}), decision = vi.fn(async()=>{}), telemetry = vi.fn();
  const provider = new PiAgentProvider({ enabled:true, piPath:process.execPath,workingDirectory:directory,agentDirectory:directory });
  const id = '12345678-1234-1234-1234-123456789012';
  try {
    const run = await provider.start({runId:'r1',prompt:'研究',maxTurns:5,resumeSessionId:id},
      {event:async event=>{events.push(event);},session,reportDecision:decision,telemetry});
    for (const event of [
      {type:'session',id}, {type:'turn_start'},
      {type:'tool_execution_start',toolCallId:'t1',toolName:'bash',args:{command:'node server/scripts/researchData.mjs query'}},
      {type:'tool_execution_end',toolCallId:'t1',toolName:'bash',isError:true,result:{content:[{type:'text',text:'INVALID_ARGUMENT: missing SQL'}]}},
      {type:'message_end',message:{role:'assistant',model:'test',usage:{input:1,output:2},content:[{type:'thinking',thinking:'private-chain'},
        {type:'text',text:'# 结果\n```agent-report\n{"generate":true,"reason":"报告"}\n```'}]}},
      {type:'agent_end',messages:[{content:'private-chain'}]},
    ]) child.stdout.write(JSON.stringify(event)+'\n');
    child.emit('close',0);
    expect(await run.completion).toMatchObject({status:'completed'});
    expect(JSON.stringify(events)).not.toContain('private-chain');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({type:'assistant_final',publicContent:'# 结果'}),expect.objectContaining({type:'error',toolFailure:expect.objectContaining({category:'invalid_argument'})})]));
    expect(decision).toHaveBeenCalledWith(true);
    expect(session).toHaveBeenCalledWith(id);
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['--session',id,'--no-extensions']));
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({usageScope:'message'}));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
it('does not report success for an API error with process exit zero', async () => {
  const directory = await mkdtemp(join(tmpdir(),'pi-error-'));
  const child = Object.assign(new EventEmitter(), { stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as never);
  try {
    const provider = new PiAgentProvider({enabled:true,piPath:process.execPath,workingDirectory:directory,agentDirectory:directory});
    const run = await provider.start({runId:'r2',prompt:'x',maxTurns:1},{event:async()=>{},session:async()=>{},reportDecision:async()=>{}});
    child.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'API failed'}})+'\n');
    child.stdout.write('{"type":"agent_end"}\n'); child.emit('close',0);
    expect(await run.completion).toMatchObject({status:'failed',errorCode:'PI_MODEL_ERROR'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});
