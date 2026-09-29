import { describe, expect, it } from 'vitest';
import { promotionVerdict, type EvaluationCaseResult } from '../src/improvement.js';

const row = (id: string, split: 'regression' | 'holdout', baseline: boolean, candidate: boolean): EvaluationCaseResult => ({ caseId: id, engine: 'codex', split, baseline: { passed: baseline, taskId: 'base', durationMs: 100 }, candidate: { passed: candidate, taskId: 'next', durationMs: 100 } });
describe('经验晋升', () => {
  it('缺少独立保留场景或没有改善，不能晋升', () => {
    expect(promotionVerdict([row('a', 'regression', false, true)]).allowed).toBe(false);
    expect(promotionVerdict([row('a', 'regression', true, true), row('b', 'holdout', true, true)]).allowed).toBe(false);
  });
  it('任何原先成功的场景退化，不能被总分改善掩盖', () => {
    expect(promotionVerdict([row('a', 'regression', true, false), row('b', 'holdout', false, true)]).allowed).toBe(false);
  });
  it('回归与保留场景均通过且有实际改善时可以晋升', () => {
    expect(promotionVerdict([row('a', 'regression', true, true), row('b', 'holdout', false, true)]).allowed).toBe(true);
  });
});
