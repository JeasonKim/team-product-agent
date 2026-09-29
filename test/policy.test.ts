import { describe, expect, it } from 'vitest';
import { authorizeReply, needsOwner, validateRelativePath } from '../src/domain/policy.js';

describe('人员与模型边界', () => {
  it('业务澄清归需求方，架构决定只接受技术负责人', () => {
    expect(authorizeReply('clarification', 'requester', 'requester', ['owner'])).toBe(true);
    expect(authorizeReply('architecture', 'requester', 'requester', ['owner'])).toBe(false);
    expect(authorizeReply('architecture', 'owner', 'requester', ['owner'])).toBe(true);
    expect(authorizeReply('acceptance', 'stranger', 'requester', ['owner'])).toBe(false);
  });
  it('已有扩展实现不升级审批，敏感路径和声明的模型变化需要负责人', () => {
    expect(needsOwner('ready', ['src/handlers/new.ts'], ['db/', 'package.json'])).toBe(false);
    expect(needsOwner('ready', ['db/schema.sql'], ['db/'])).toBe(true);
    expect(needsOwner('architecture', ['src/service.ts'], [])).toBe(true);
    expect(needsOwner('ready', ['database-view.ts'], ['db/'])).toBe(false);
  });
  it.each(['../outside', '/etc/passwd', 'src/../../x', '.git/config', '.env', 'a\\b', 'src//a', 'src/./a'])('拒绝非规范或保留路径 %s', path => {
    expect(() => validateRelativePath(path)).toThrow();
  });
  it('接受普通项目文件', () => expect(validateRelativePath('src/main.ts')).toBe('src/main.ts'));
});
