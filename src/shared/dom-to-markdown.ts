/**
 * 浏览器可视编辑 DOM → 共同 Markdown 子集的转换（RichBodyEditor 与 CaptureComposer 共用）。
 *
 * 只识别本应用 `renderSafeHtml` 生成的标签（p/h1-h3/ul/ol/li/blockquote/pre/table/
 * strong/em/s/br/a/img/code/checkbox），其余元素按行内文本拼接，不引入额外语法。
 * 表格单元格文本由 `splitTableRow` 拼接回 `| a | b |`；复选框映射为 `- [ ]` / `- [x]`。
 */

function textOf(node: Node): string {
  return (node.textContent ?? '').replace(/ /g, ' ');
}

export function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return textOf(node);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const children = Array.from(element.childNodes).map(inlineMarkdown).join('');
  switch (element.tagName.toLowerCase()) {
    case 'strong':
    case 'b': return `**${children}**`;
    case 'em':
    case 'i': return `*${children}*`;
    case 's':
    case 'strike':
    case 'del': return `~~${children}~~`;
    case 'code': return `\`${children}\``;
    case 'input':
      return (element as HTMLInputElement).type === 'checkbox'
        ? ((element as HTMLInputElement).checked ? '[x] ' : '[ ] ')
        : '';
    case 'a': {
      const href = element.getAttribute('href') ?? '';
      return href ? `[${children}](${href})` : children;
    }
    case 'img': {
      const assetId = element.getAttribute('data-asset-id');
      return assetId ? `![${element.getAttribute('alt') ?? ''}](asset:${assetId})` : '';
    }
    case 'br': return '\n';
    default: return children;
  }
}

function tableMarkdown(element: HTMLElement): string {
  const rows: string[][] = [];
  const header = element.querySelector('thead tr');
  if (header) rows.push(Array.from(header.children).map((cell) => inlineMarkdown(cell).trim()));
  const body = element.querySelector('tbody');
  if (body) {
    for (const tr of Array.from(body.children)) {
      if (tr.tagName.toLowerCase() !== 'tr') continue;
      rows.push(Array.from(tr.children).map((cell) => inlineMarkdown(cell).trim()));
    }
  }
  if (rows.length === 0) return '';
  const columnCount = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => Array.from({ length: columnCount }, (_, index) => row[index] ?? '').join(' | ');
  const headerLine = `| ${pad(rows[0])} |`;
  const separatorLine = `| ${Array(columnCount).fill('---').join(' | ')} |`;
  const bodyLines = rows.slice(1).map((row) => `| ${pad(row)} |`);
  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return textOf(node);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    return Array.from(element.children).filter((child) => child.tagName.toLowerCase() === 'li')
      .map((child, index) => `${ordered ? `${index + 1}.` : '-'} ${inlineMarkdown(child)}`).join('\n');
  }
  if (tag === 'blockquote') {
    return Array.from(element.children).map((child) => `> ${inlineMarkdown(child)}`).join('\n');
  }
  if (tag === 'pre') {
    const code = element.querySelector('code');
    return `\`\`\`\n${code ? textOf(code) : textOf(element)}\n\`\`\``;
  }
  if (tag === 'hr') return '---';
  if (tag === 'table') return tableMarkdown(element);
  if (/^h[1-3]$/.test(tag)) return `${'#'.repeat(Number(tag.slice(1)))} ${inlineMarkdown(element)}`;
  if (tag === 'p' || tag === 'div') return inlineMarkdown(element);
  return inlineMarkdown(element);
}

/** 将浏览器可视编辑 DOM 转回共同 Markdown 子集。 */
export function editableHtmlToMarkdown(root: HTMLElement): string {
  const blocks = Array.from(root.childNodes).map(blockMarkdown).filter((part) => part.trim() !== '');
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
