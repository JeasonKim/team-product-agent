import { createHash } from 'node:crypto';
import type { InteractionKind } from './model.js';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
export function authorizeReply(kind: InteractionKind, actor: string, requester: string, owners: string[]): boolean {
  if (kind === 'architecture' || kind === 'recovery') return owners.includes(actor);
  return actor === requester || owners.includes(actor);
}
export function matchesBoundary(path: string, boundary: string): boolean {
  return boundary.endsWith('/') ? path.startsWith(boundary) : path === boundary;
}
export function needsOwner(decision: string, paths: string[], sensitivePaths: string[]): boolean {
  return decision === 'architecture' || paths.some(path => sensitivePaths.some(boundary => matchesBoundary(path, boundary)));
}
export function validateRelativePath(path: string): string {
  const segments = path.split('/');
  if (!path || path.includes('\\') || path.includes('\0') || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git' || segment.toLowerCase() === '.env' || segment.toLowerCase().startsWith('.env.'))) {
    throw new Error(`禁止访问非规范或保留路径：${path}`);
  }
  return path;
}
