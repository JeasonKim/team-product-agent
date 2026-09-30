// 文档解析在有内存与时限约束的独立进程中运行；不执行附件内的代码或外部引用。
import { readFile } from 'node:fs/promises';
const [kind, path] = process.argv.slice(2);
const limit = 60_000;
let text = '';
try {
  if (kind === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const job = getDocument({ data: new Uint8Array(await readFile(path)), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    const document = await job.promise;
    try {
      if (document.numPages > 50) throw new Error('PDF 超过 50 页，请只发送相关页面');
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        text += `\n第 ${index} 页\n` + content.items.filter(item => 'str' in item).map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
        if (text.length > limit) throw new Error('文档文字超过 60000 字符，请拆分或只发送相关部分');
        if (!content.items.some(item => 'str' in item && item.str.trim())) throw new Error('PDF 中存在无法提取文字的页面，请将扫描页或设计稿作为图片发送');
        page.cleanup();
      }
    } finally { await document.destroy(); }
  } else if (kind === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: await readFile(path) });
    text = result.value;
    for (const message of result.messages) console.warn('Word 解析提示', message.message);
  } else throw new Error('不支持的文档类型');
  if (!text.trim()) throw new Error('文档没有可读取的文字，请将参考内容作为图片或文字发送');
  if (text.length > limit) throw new Error('文档文字超过 60000 字符，请拆分或只发送相关部分');
  console.log('TEAM_AGENT_DOCUMENT=' + JSON.stringify({ text }));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
