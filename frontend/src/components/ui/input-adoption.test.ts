import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const sources = import.meta.glob('/src/**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('shared input adoption', () => {
  it('keeps raw form controls inside the shared primitive implementation', () => {
    const violations: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('.test.tsx') || path.endsWith('/ui/OutlinedField.tsx') || path.endsWith('/ui/NativeControls.tsx')) continue
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['input', 'select', 'textarea'].includes(node.tagName.getText(file))) {
          violations.push(`${path}:${file.getLineAndCharacterOfPosition(node.pos).line + 1}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    expect(violations).toEqual([])
  })
})
