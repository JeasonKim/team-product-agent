import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { type Attachment, type EngineAttachment, type DownloadAttachment, MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_CHARACTERS, MAX_IMAGE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '../domain/attachments.js';
import { executeCommand } from './process.js';
import { applicationDirectory } from './paths.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const textTypes = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.java', '.py', '.sql', '.log']);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class AttachmentLibrary {
  constructor(private readonly dataDirectory: string) {}
  private async directory(item: Attachment): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(item.id)) throw new Error('附件标识不合法');
    const root = join(this.dataDirectory, 'attachments');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    const directory = join(canonicalRoot, item.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('附件路径包含符号链接');
    return directory;
  }
  private async file(item: Attachment, name: string): Promise<string> {
    const path = join(await this.directory(item), name);
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('附件路径不是普通文件或包含符号链接'); }
    catch (error) { if (!missing(error)) throw error; }
    return path;
  }
  async original(item: Attachment): Promise<string> {
    const path = await this.file(item, 'original.bin');
    const info = await lstat(path);
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 20 MB');
    if (item.sha256 && hash(await readFile(path)) !== item.sha256) throw new Error('附件文件已变化，请重新发送');
    return path;
  }
  async receive(items: Attachment[], download: DownloadAttachment, signal: AbortSignal): Promise<Attachment[]> {
    if (items.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`一条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个附件，请分开发送`);
    const result: Attachment[] = [];
    for (const item of items) {
      signal.throwIfAborted();
      try {
        if ((item.bytes ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 20 MB，请压缩或拆分后发送');
        const metadata = await this.file(item, 'metadata.json');
        try {
          const cached = JSON.parse(await readFile(metadata, 'utf8')) as Attachment;
          if (cached.id !== item.id || cached.messageId !== item.messageId || cached.key !== item.key || cached.status !== 'ready') throw new Error('附件缓存不完整，请重新发送');
          await this.inputs([cached]); result.push(cached); continue;
        } catch (error) { if (!missing(error)) throw error; }
        // 缓存完成前只写临时文件，事件重放不会使用上次中断留下的半个附件。
        const original = await this.file(item, 'original.bin');
        const temporary = await this.file(item, 'download.bin');
        try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
        await download(item, temporary, signal);
        signal.throwIfAborted();
        const stat = await lstat(temporary);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('附件下载结果不是普通文件');
        if (!stat.size || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('附件为空或超过 20 MB，请压缩或拆分后发送');
        const bytes = await readFile(temporary);
        const { text, ...prepared } = await this.decode(item, bytes, temporary, signal);
        await rename(temporary, original);
        const ready: Attachment = { ...item, ...prepared, status: 'ready', bytes: bytes.length, sha256: hash(bytes) };
        if (text !== undefined) {
          const textBytes = Buffer.from(text); ready.textSha256 = hash(textBytes);
          await writeFile(await this.file(item, 'text.txt'), textBytes, { mode: 0o600 });
        }
        const temporaryMetadata = await this.file(item, 'metadata.tmp');
        await writeFile(temporaryMetadata, JSON.stringify(ready), { mode: 0o600 });
        await rename(temporaryMetadata, metadata);
        result.push(ready);
      } catch (error) {
        signal.throwIfAborted();
        console.warn('附件未读取', { attachmentId: item.id, messageId: item.messageId, reason: String(error).slice(0, 500) });
        result.push({ ...item, status: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : '附件读取失败，请重新发送' });
      } finally {
        try { await unlink(await this.file(item, 'download.bin')); }
        catch (error) { if (!missing(error)) console.warn('附件临时文件未清理', { attachmentId: item.id, reason: String(error) }); }
      }
    }
    return result;
  }
  private async decode(item: Attachment, bytes: Buffer, path: string, signal: AbortSignal): Promise<{ mimeType: string; text?: string; warning?: string }> {
    const imageType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
      : /^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')) ? 'image/gif'
      : bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
    if (imageType) {
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MB，请压缩后发送');
      return { mimeType: imageType, ...(imageType === 'image/gif' ? { warning: '动图仅按静态画面理解，关键变化请另发截图。' } : {}) };
    }
    if (item.kind === 'image') throw new Error('图片格式无法读取，请发送 PNG、JPEG、WebP 或 GIF');
    const extension = extname(item.name).toLowerCase();
    if (extension === '.pdf' || extension === '.docx') {
      if (extension === '.pdf' && bytes.subarray(0,5).toString() !== '%PDF-' || extension === '.docx' && bytes.subarray(0,2).toString() !== 'PK') throw new Error('文件内容与扩展名不匹配，请重新导出后发送');
      const result = await executeCommand({ name: '读取参考文档', argv: [process.execPath, '--max-old-space-size=256', join(applicationDirectory, 'resources', 'extract-document.mjs'), extension.slice(1), path], timeoutMs: 30_000 }, applicationDirectory, signal, 300_000);
      signal.throwIfAborted();
      if (result.timedOut) throw new Error('文档解析超时，请拆分后发送');
      if (result.exitCode !== 0 || result.truncated) throw new Error(`文档无法完整读取：${result.output.slice(-500)}`);
      const line = result.output.split('\n').find(line => line.startsWith('TEAM_AGENT_DOCUMENT='));
      if (!line) throw new Error('文档解析未返回内容');
      const { text } = JSON.parse(line.slice('TEAM_AGENT_DOCUMENT='.length)) as { text: string };
      return { mimeType: extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text, warning: '已读取文档文字；内嵌图片和版式未作为视觉参考，请单独发送相关截图。' };
    }
    if (!textTypes.has(extension)) throw new Error('暂不支持此文件类型；请使用 PDF、Word（.docx）、TXT、Markdown、CSV 或代码文本，压缩包和音视频请先整理为相关资料');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('文本不是 UTF-8 编码，请另存为 UTF-8 后发送'); }
    if (text.includes('\0')) throw new Error('文件包含二进制内容，无法作为文本读取');
    if (!text.trim() || text.length > MAX_DOCUMENT_CHARACTERS) throw new Error('文本为空或超过 60000 字符，请只发送相关部分');
    return { mimeType: 'text/plain', text };
  }
  async inputs(items: Attachment[] = []): Promise<EngineAttachment[]> {
    const result: EngineAttachment[] = []; let textLength = 0; let imageBytes = 0;
    for (const item of items) {
      if (item.status !== 'ready') continue;
      const original = await this.original(item);
      if (item.mimeType?.startsWith('image/')) {
        imageBytes += item.bytes ?? 0;
        if (imageBytes > MAX_ATTACHMENT_BYTES) throw new Error('本需求图片总量超过 20 MB，请压缩或分为独立需求');
        result.push({ name: item.name, kind: 'image', mimeType: item.mimeType, path: original });
      } else {
        const path = await this.file(item, 'text.txt'); const bytes = await readFile(path);
        if (!item.textSha256 || hash(bytes) !== item.textSha256) throw new Error('附件文字缓存已变化，请重新发送');
        textLength += bytes.toString('utf8').length;
        if (textLength > 120_000) throw new Error('本需求参考文档合计超过 120000 字符，请只发送相关部分');
        result.push({ name: item.name, kind: 'text', mimeType: 'text/plain', path });
      }
    }
    return result;
  }
}
