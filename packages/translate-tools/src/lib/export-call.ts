import { type CallExpression, Node, type SourceFile } from 'ts-morph';

export function variableCall(
  sf: SourceFile,
  name: string,
): CallExpression | undefined {
  const init = sf.getVariableDeclaration(name)?.getInitializer();
  return init && Node.isCallExpression(init) ? init : undefined;
}

/** The `create*` call behind a discovered binding: a named const, or the default export (an
 * inline call, or an identifier bound to a const). */
export function exportedCall(
  sf: SourceFile,
  exportName: string,
  isDefaultExport: boolean,
): CallExpression | undefined {
  if (!isDefaultExport) return variableCall(sf, exportName);
  const expr = sf
    .getExportAssignment((a) => !a.isExportEquals())
    ?.getExpression();
  if (!expr) return undefined;
  if (Node.isIdentifier(expr)) return variableCall(sf, expr.getText());
  return Node.isCallExpression(expr) ? expr : undefined;
}
