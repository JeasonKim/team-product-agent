import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// 只读取非敏感的原生模型目录；不读取或返回账号认证文件。
export async function modelCatalog() {
  const schema = z.object({ fetched_at: z.string().optional(), models: z.array(z.object({ slug: z.string(), display_name: z.string(), visibility: z.string().optional(), supported_reasoning_levels: z.array(z.object({ effort: z.string() })).default([]) })) });
  try {
    const cache = schema.parse(JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), 'utf8')));
    return { source: 'local-cache', fetchedAt: cache.fetched_at ?? null, codex: cache.models.filter(m => m.visibility !== 'hide' && !m.slug.includes('auto-review')).map(m => ({ id: m.slug, name: m.display_name, efforts: m.supported_reasoning_levels.map(l => l.effort) })) };
  } catch { return { source: 'manual', fetchedAt: null, codex: [] }; }
}
