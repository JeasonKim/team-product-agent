import { createHash } from 'node:crypto';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_TASK_ATTACHMENTS = 16;
export const MAX_DOCUMENT_CHARACTERS = 60_000;

export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  status: 'pending' | 'ready' | 'failed';
  messageId: string;
  key: string;
  bytes?: number;
  mimeType?: string;
  sha256?: string;
  textSha256?: string;
  error?: string;
  warning?: string;
}
export interface EngineAttachment {
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  path: string;
}
export type DownloadAttachment = (attachment: Attachment, destination: string, signal: AbortSignal) => Promise<void>;

export function attachment(messageId: string, key: string, kind: Attachment['kind'], name?: string): Attachment {
  return { id: createHash('sha256').update(JSON.stringify([messageId, key])).digest('hex'), kind, name: (name?.split(/[\\/]/).at(-1)?.replace(/\p{C}/gu, '').slice(0, 180) || (kind === 'image' ? '参考图片' : '参考文件')), status: 'pending', messageId, key };
}
export function mergeAttachments(current: Attachment[] = [], incoming: Attachment[] = []): Attachment[] {
  const retained = current.filter(item => !(item.status === 'failed' && incoming.some(next => next.status === 'ready' && next.name === item.name)));
  const merged = [...new Map([...retained, ...incoming].map(item => [item.id, item])).values()];
  if (merged.length > MAX_TASK_ATTACHMENTS) throw new Error(`一个需求最多保留 ${MAX_TASK_ATTACHMENTS} 个附件，请将新增资料作为独立需求提交`);
  return merged;
}
