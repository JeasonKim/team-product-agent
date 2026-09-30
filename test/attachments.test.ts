import { mkdtemp, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseFeishuMessage } from '../src/adapters/messages.js';
import { parseLarkCliMessage } from '../src/adapters/lark-cli.js';
import { attachment, MAX_ATTACHMENT_BYTES } from '../src/domain/attachments.js';
import { AttachmentLibrary } from '../src/infra/attachments.js';
import { hydrateMessage } from '../src/adapters/feishu.js';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4m8AAAAASUVORK5CYII=', 'base64');
function event(type: string, content: unknown, group = false) {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'user' } }, message: { message_id: 'om_source', chat_id: 'chat', chat_type: group ? 'group' : 'p2p', message_type: type, content: JSON.stringify(content) } };
}
describe('飞书附件消息', () => {
  it('从原始消息读取资源时校验身份和聊天，授权后续接仍使用原飞书消息 ID', () => {
    const message = { id: 'access:request', actorId: 'user', chatId: 'private:user', chatType: 'p2p' as const, text: '', replyTo: null, source: { messageId: 'om_source', chatId: 'chat' }, needsHydration: true };
    const item = { message_id: 'om_source', chat_id: 'chat', sender: { id: 'user', sender_type: 'user' }, msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_demo' }) } };
    expect(hydrateMessage(message, { items: [item] }).attachments?.[0]?.messageId).toBe('om_source');
    expect(() => hydrateMessage(message, { items: [{ ...item, chat_id: 'another' }] })).toThrow(/归属/);
    expect(() => hydrateMessage(message, { items: [{ ...item, sender: { id: 'other', sender_type: 'user' } }] })).toThrow(/归属/);
    expect(() => hydrateMessage(message, { items: [{ ...item, deleted: true }] })).toThrow(/不可用/);
  });
  it('独立图片和文件保留来源、名称，不把资源标识当用户文字', () => {
    expect(parseFeishuMessage(event('image', { image_key: 'img_demo' }))?.attachments?.[0]).toMatchObject({ messageId: 'om_source', key: 'img_demo', kind: 'image', status: 'pending' });
    expect(parseFeishuMessage(event('file', { file_key: 'file_demo', file_name: '需求.docx' }))?.attachments?.[0]?.name).toBe('需求.docx');
    expect(parseFeishuMessage(event('image', { image_key: 'img_demo' }))?.text).toBe('');
  });
  it('富文本保留标题、文字、链接与图片；同图去重', () => {
    const message = parseFeishuMessage(event('post', { zh_cn: { title: '调整商品卡片', content: [[{ tag: 'text', text: '按这个效果' }, { tag: 'img', image_key: 'img_demo' }], [{ tag: 'a', text: '参考', href: 'https://example.com' }, { tag: 'img', image_key: 'img_demo' }]] } }));
    expect(message?.text).toContain('调整商品卡片'); expect(message?.text).toContain('https://example.com'); expect(message?.attachments).toHaveLength(1);
  });
  it('未知格式和损坏内容产生可反馈的问题，群里未定向消息仍忽略', () => {
    expect(parseFeishuMessage(event('audio', { file_key: 'file_audio' }))?.problem).toMatch(/暂不支持/);
    expect(parseFeishuMessage(event('image', {}))?.problem).toBeTruthy();
    expect(parseFeishuMessage(event('image', { image_key: 'img_demo' }, true), 'bot')).toBeNull();
    const quoted = event('image', { image_key: 'img_demo' }, true);
    expect(parseFeishuMessage({ ...quoted, message: { ...quoted.message, parent_id: 'reply' } }, 'bot')?.addressedToBot).toBe(false);
  });
  it('CLI 的图文和文件先保留消息身份，随后获取原始内容，不解析可伪造的展示占位符', () => {
    const message = parseLarkCliMessage({ type: 'im.message.receive_v1', sender_id: 'user', sender_type: 'user', message_id: 'om_source', chat_id: 'dm', chat_type: 'p2p', message_type: 'post', content: '参考 ![Image](img_fake)' });
    expect(message).toMatchObject({ id: 'om_source', needsHydration: true }); expect(message?.attachments).toBeUndefined();
  });
});

describe('附件下载与读取', () => {
  it.each([['pdf', 'Start now'], ['docx', '立即体验']])('真实 %s 文件能提取需求文字，并明确标记视觉内容的限制', async (extension, expected) => {
    const library = new AttachmentLibrary(await mkdtemp(join(tmpdir(), 'agent-document-')));
    const [ready] = await library.receive([attachment(`om_${extension}`, `file_${extension}`, 'file', `参考.${extension}`)], async (_a, path) => { await writeFile(path, await readFile(new URL(`./fixtures/reference.${extension}`, import.meta.url))); }, new AbortController().signal);
    expect(ready?.status, ready?.error).toBe('ready'); expect(ready?.warning).toContain('内嵌图片');
    const [input] = await library.inputs([ready!]); expect(await readFile(input!.path, 'utf8')).toContain(expected);
  });
  it('真实图片按内容识别，文本按 UTF-8 读取；重复消息复用完整缓存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-assets-')); const library = new AttachmentLibrary(root);
    const download = vi.fn(async (_a, path: string) => { await writeFile(path, image); });
    const source = attachment('om_source', 'img_demo', 'image', '../../参考图.png');
    const [ready] = await library.receive([source], download, new AbortController().signal);
    expect(ready).toMatchObject({ status: 'ready', mimeType: 'image/png', name: '参考图.png' });
    expect((await library.inputs([ready!]))[0]?.kind).toBe('image');
    await library.receive([source], download, new AbortController().signal); expect(download).toHaveBeenCalledTimes(1);
    const [text] = await library.receive([attachment('om_text', 'file_text', 'file', '说明.md')], async (_a, path) => { await writeFile(path, '按钮改成「开始体验」'); }, new AbortController().signal);
    expect(await readFile((await library.inputs([text!]))[0]!.path, 'utf8')).toContain('开始体验');
  });
  it('超限、伪图片、无法下载均保留失败原因，不伪装已读取；取消向上传播', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-assets-')); const library = new AttachmentLibrary(root);
    const tooLarge = { ...attachment('om_big', 'file_big', 'file', '大文件.txt'), bytes: MAX_ATTACHMENT_BYTES + 1 };
    const download = vi.fn(async () => {});
    expect((await library.receive([tooLarge], download, new AbortController().signal))[0]?.error).toMatch(/20 MB/); expect(download).not.toHaveBeenCalled();
    expect((await library.receive([attachment('om_fake', 'img_fake', 'image')], async (_a, path) => { await writeFile(path, '<script>fake</script>'); }, new AbortController().signal))[0]?.status).toBe('failed');
    expect((await library.receive([attachment('om_err', 'file_err', 'file', '需求.txt')], async () => { throw new Error('没有权限'); }, new AbortController().signal))[0]?.error).toContain('没有权限');
    const control = new AbortController(); control.abort(); await expect(library.receive([tooLarge], download, control.signal)).rejects.toThrow();
  });
  it('下载中断后重放消息会重新下载，不采用或被旧的半成品阻塞', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-assets-')); const library = new AttachmentLibrary(root);
    const item = attachment('interrupted', 'file_text', 'file', '说明.md');
    const directory = join(root, 'attachments', item.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'download.bin'), '中断的半个附件');
    const [ready] = await library.receive([item], async (_item, path) => { await writeFile(path, '完整内容', { flag: 'wx' }); }, new AbortController().signal);
    expect(ready?.status, ready?.error).toBe('ready');
    expect(await readFile((await library.inputs([ready!]))[0]!.path, 'utf8')).toBe('完整内容');
  });
  it('读取和后台下载拒绝符号链接越界，文档内容不落入产品仓库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-assets-')); const library = new AttachmentLibrary(root);
    const [ready] = await library.receive([attachment('om_x', 'file_x', 'file', '说明.txt')], async (_a, path) => { await writeFile(path, '要求'); }, new AbortController().signal);
    const file = await library.original(ready!); const outside = join(root, 'outside.txt'); await writeFile(outside, '不可读取');
    const { unlink } = await import('node:fs/promises'); await unlink(file); await symlink(outside, file);
    await expect(library.original(ready!)).rejects.toThrow(/路径|链接/);
    const other = attachment('om_y', 'file_y', 'file', '说明.txt');
    await mkdir(join(root, 'attachments', other.id), { recursive: true });
    await symlink(outside, join(root, 'attachments', other.id, 'original.bin'));
    expect((await library.receive([other], async (_a, path) => { await writeFile(path, '覆盖'); }, new AbortController().signal))[0]?.status).toBe('failed');
    expect(await readFile(outside, 'utf8')).toBe('不可读取');
  });
});
