import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { AgentStore } from '../src/infra/store.js';
import { TaskService } from '../src/service.js';
import { executeCommand } from '../src/infra/process.js';
import { evaluateCandidate, promoteCandidate } from '../src/improvement.js';
import type { AgentEngine, AgentResponse } from '../src/domain/model.js';

afterEach(() => vi.unstubAllEnvs());
it('Codex 本机登录可独立对比评估；保留场景改善后只晋升给已验证引擎（SDK 替身、真实工作副本和验收）', async () => {
  vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('ANTHROPIC_API_KEY', '');
  const root = await mkdtemp(join(tmpdir(), 'agent-learning-')); const repo = join(root,'repo'); await mkdir(repo);
  await writeFile(join(repo,'product.mjs'), "export const message = 'original';\n");
  await writeFile(join(repo,'check.mjs'), "import {message} from './product.mjs'; if(typeof message !== 'string')process.exit(1);\n");
  for (const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']]) expect((await executeCommand({ name:'git',argv:['git',...args],timeoutMs:5000 },repo)).exitCode).toBe(0);
  const configPath=join(root,'config.json');
  const manifestPath=join(root,'cases.json');
  const manifest={ cases: ['regression','holdout'].map(split=>({ id:split,split,request:`${split} 改进提示`,expected:'ready',acceptance:{argv:[process.execPath,'--input-type=module','-e',"import {message} from './product.mjs'; if(message!=='correct')process.exit(1);"]}})) };
  await writeFile(manifestPath,JSON.stringify(manifest));
  await writeFile(configPath,JSON.stringify({dataDirectory:join(root,'data'),localActorId:'owner',projects:[{id:'demo',name:'Demo',repository:repo,engine:'codex',authentication:{codex:'local_login'},ownerIds:['owner'],requesterIds:['user'],evaluationManifest:manifestPath,checks:[{name:'check',argv:[process.execPath,'check.mjs']}]}]}));
  const config=await loadConfig(configPath); const store=new AgentStore(join(root,'state.sqlite')); const instructions={role:'role',skill:'skill'};
  let calls=0;
  const engine: AgentEngine={id:'codex',async execute(request){calls++;const prompt=JSON.parse(request.prompt); const correct=prompt.需求.startsWith('regression')||request.instructions.includes('EVAL_EXPERIENCE'); const response: AgentResponse={decision:'ready',summary:'改进提示',rationale:'现有模型',question:null,affectedPaths:['product.mjs'],acceptance:['检查文案'],edits:prompt.阶段==='plan'?[]:[{path:'product.mjs',before:"'original'",after:correct?"'correct'":"'wrong'"}],learning:null};return {response,sessionId:`trial-${request.taskId}`,usage:{inputTokens:null,outputTokens:null,costUsd:null}};}};
  const service=new TaskService(config,store,{codex:engine},instructions); const source=service.submit('demo','user','来源');
  store.recordImprovement({id:'a1234567',taskId:source.id,status:'candidate',content:'EVAL_EXPERIENCE',createdAt:new Date().toISOString(),promotedAt:null,evaluatedHash:null});
  try {
    const report=await evaluateCandidate(config,store,instructions,{codex:engine},'a1234567',manifestPath);
    expect(report.engines).toEqual(['codex']); expect(calls).toBe(16); expect(report.verdict.allowed).toBe(true);
    expect(report.results.find(r=>r.split==='holdout')?.baseline.passed).toBe(false);
    expect(report.results.every(r=>r.candidate.passed)).toBe(true);
    config.profile={name:'changed',role:'role',style:'style',preferences:'changed'};
    await expect(promoteCandidate(config,store,instructions,'a1234567',report.id,'owner')).rejects.toThrow(/不一致/);
    delete config.profile;
    await promoteCandidate(config,store,instructions,'a1234567',report.id,'owner');
    expect(store.projectExperience('demo','codex')).toBe('EVAL_EXPERIENCE'); expect(store.projectExperience('demo','claude')).toBe('');
    expect(store.improvements()[0]?.validatedEngines).toEqual(['codex']);
    expect(await readFile(join(repo,'product.mjs'),'utf8')).toContain('original');
  } finally {store.close();}
},20000);
