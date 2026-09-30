import { z } from 'zod';
import { attachment, MAX_MESSAGE_ATTACHMENTS, type Attachment } from '../domain/attachments.js';

interface MessageContent { text: string; attachments?: Attachment[]; problem?: string }
const resourceKey = z.string().min(1).max(300).regex(/^[a-zA-Z0-9_-]+$/);
const postSchema = z.object({ title: z.string().optional(), content: z.array(z.array(z.record(z.string(), z.unknown()))) });

export function feishuContent(type: string, content: string, messageId: string, botId?: string): MessageContent {
  if (!['text', 'image', 'file', 'post'].includes(type)) return { text: '', problem: '暂不支持这类消息，请发送文字、图片、PDF、Word（.docx）或文本文件。' };
  try {
    const data: unknown = JSON.parse(content);
    if (type === 'text') return { text: z.object({ text: z.string() }).parse(data).text };
    if (type === 'image') return { text: '', attachments: [attachment(messageId, z.object({ image_key: resourceKey }).parse(data).image_key, 'image')] };
    if (type === 'file') {
      const file = z.object({ file_key: resourceKey, file_name: z.string(), file_size: z.number().nonnegative().optional() }).parse(data);
      return { text: '', attachments: [{ ...attachment(messageId, file.file_key, 'file', file.file_name), ...(file.file_size === undefined ? {} : { bytes: file.file_size }) }] };
    }
    const locales = z.record(z.string(), z.unknown()).parse(data);
    const post = postSchema.parse(Array.isArray(locales.content) ? locales : locales.zh_cn ?? locales.en_us ?? Object.values(locales)[0]);
    const resources: Attachment[] = []; const lines: string[] = [post.title ?? '']; let unsupported = false;
    for (const row of post.content) {
      const fragments: string[] = [];
      for (const node of row) {
        if (node.tag === 'text' || node.tag === 'md' || node.tag === 'code_block') fragments.push(String(node.text ?? ''));
        else if (node.tag === 'a') fragments.push(`${String(node.text ?? '')} (${String(node.href ?? '')})`);
        else if (node.tag === 'at') { if (node.user_id !== botId) fragments.push(`@${String(node.user_name ?? node.user_id ?? '')}`); }
        else if (node.tag === 'img') resources.push(attachment(messageId, resourceKey.parse(node.image_key), 'image'));
        else if (node.tag === 'hr') fragments.push('\n');
        else if (node.tag !== 'emotion') unsupported = true;
      }
      lines.push(fragments.join(''));
    }
    const attachments = [...new Map(resources.map(item => [item.id, item])).values()];
    if (attachments.length > MAX_MESSAGE_ATTACHMENTS) return { text: lines.join('\n').trim(), problem: `一条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个附件，请分开发送。` };
    return { text: lines.join('\n').trim(), ...(attachments.length ? { attachments } : {}), ...(unsupported ? { problem: '图文消息中包含暂不支持的内容，请将视频、音频等改为文字或截图后重发。' } : {}) };
  } catch (error) {
    console.warn('飞书消息内容无法解析', { messageId, type, reason: String(error).slice(0, 300) });
    return { text: '', problem: '这条消息的内容没有读取成功，请重新发送文字、图片或文件。' };
  }
}
