import { defineConfig } from 'vitest/config';

export default defineConfig({
  // data/tasks 下是被接管的产品仓库，须由该产品自己的配置与检查命令验证。
  test: { include: ['test/**/*.test.ts'] },
});
