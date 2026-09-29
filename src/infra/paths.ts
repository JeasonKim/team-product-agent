import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
let directory = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(directory, 'package.json'))) {
  if (directory === parse(directory).root) throw new Error('找不到应用目录');
  directory = dirname(directory);
}
export const applicationDirectory = directory;
