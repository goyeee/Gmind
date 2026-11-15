import { describe, expect, it } from 'vitest';
import { unzipEntries } from '@gmind/xmind-io';
import { buildXlsxBytes } from './docExport';

const sheetXml = (bytes: Uint8Array): string =>
  new TextDecoder().decode(unzipEntries(bytes)['xl/worksheets/sheet1.xml']);

describe('buildXlsxBytes（最小 OOXML 任务表）', () => {
  it('zip 含五个标准部件', () => {
    const parts = Object.keys(unzipEntries(buildXlsxBytes([['序号']])));
    expect(parts).toEqual(expect.arrayContaining([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml',
    ]));
  });
  it('表头 7 列与 CSV 同序', () => {
    const xml = sheetXml(buildXlsxBytes([['序号','主题','负责人','截止时间','进度','状态','优先级']]));
    for (const h of ['序号','主题','负责人','截止时间','进度','状态','优先级']) {
      expect(xml).toContain(`<t>${h}</t>`);
    }
  });
  it('字符串经 XML 实体转义', () => {
    expect(sheetXml(buildXlsxBytes([['主题&<1>']]))).toContain('主题&amp;&lt;1&gt;');
  });
  it('数字单元格 t="n"（序号/进度用），文本单元格 inlineStr', () => {
    const xml = sheetXml(buildXlsxBytes([[1, '甲', '', '', 85, '', '']]));
    expect(xml).toContain('<c r="A1" t="n"><v>1</v></c>');
    expect(xml).toContain('<v>85</v>');
    expect(xml).toContain('<c r="B1" t="inlineStr"><is><t>甲</t></is></c>');
  });
});

const colsXml = (xml: string): string => xml.match(/<cols>([\s\S]*?)<\/cols>/)?.[1] ?? '';

describe('buildXlsxBytes 列宽自适应（宽度=列内最大显示宽+2，钳制 [8,60]）', () => {
  it('中文长标题列：4 汉字→显示宽 8→width 10', () => {
    const xml = sheetXml(buildXlsxBytes([[1, '需求整理', '', '', 85, '', '']]));
    expect(xml).toContain('<col min="2" max="2" width="10" customWidth="1"/>');
  });
  it('全短列钳到下限 width=8（7 列逐列断言）', () => {
    const cols = colsXml(sheetXml(buildXlsxBytes([['序', '题', '人', '时', '度', '态', '级']])));
    expect((cols.match(/<col /g) ?? [])).toHaveLength(7);
    for (let i = 1; i <= 7; i += 1) {
      expect(cols).toContain(`<col min="${i}" max="${i}" width="8" customWidth="1"/>`);
    }
  });
  it('超长列钳到上限 width=60', () => {
    const xml = sheetXml(buildXlsxBytes([['长'.repeat(40), '', '', '', '', '', '']]));
    expect(xml).toContain('<col min="1" max="1" width="60" customWidth="1"/>');
  });
  it('数字单元格显示宽按字符串化长度（12345678→8→width 10）', () => {
    const xml = sheetXml(buildXlsxBytes([[12345678, '', '', '', '', '', '']]));
    expect(xml).toContain('<col min="1" max="1" width="10" customWidth="1"/>');
  });
  it('cols 置于 sheetData 前，7 个 col 且 min/max 逐列对齐', () => {
    const xml = sheetXml(
      buildXlsxBytes([['序号', '主题', '负责人', '截止时间', '进度', '状态', '优先级'], [1, '需求整理', '', '', 100, '', '']]),
    );
    expect(xml.indexOf('<cols>')).toBeGreaterThan(-1);
    expect(xml.indexOf('<cols>')).toBeLessThan(xml.indexOf('<sheetData>'));
    const found = [...colsXml(xml).matchAll(/<col min="(\d+)" max="(\d+)" width="\d+" customWidth="1"\/>/g)];
    expect(found).toHaveLength(7);
    found.forEach((m, i) => {
      expect(m[1]).toBe(String(i + 1));
      expect(m[2]).toBe(String(i + 1));
    });
  });
});
