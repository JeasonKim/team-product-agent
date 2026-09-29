import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applicationDirectory } from './paths.js';
const manifest = JSON.parse(readFileSync(join(applicationDirectory, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
export function runtimeVersions(): Record<string, string> {
  return { application: manifest.version, node: process.versions.node, claudeSdk: manifest.dependencies['@anthropic-ai/claude-agent-sdk']!, codexSdk: manifest.dependencies['@openai/codex-sdk']! };
}
