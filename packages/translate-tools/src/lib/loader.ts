import {
  type ArrowFunction,
  type FunctionExpression,
  Node,
  SyntaxKind,
} from 'ts-morph';

export type ParsedLoader = {
  /** The module specifier of the dynamic `import(...)`. */
  importPath: string;
  /**
   * The property chain accessed on the resolved module (`m.quote.translation` → `['quote',
   * 'translation']`). Empty for the `() => import('path')` shorthand, where `@mmstack/translate`
   * auto-resolves the module's `default` / `translation` export.
   */
  accessor: string[];
};

/**
 * Parse a namespace loader into its import path + accessor chain, matching every shape
 * `@mmstack/translate` accepts at runtime:
 *   - `() => import('path').then((m) => m.a.b)` → `['a', 'b']`
 *   - `() => import('path').then((m) => m.default)` → `['default']`
 *   - `() => import('path')` (shorthand) → `[]` (default / translation auto-resolve)
 * Returns `null` for any other shape (async/await, computed access) — the caller warns and skips.
 */
export function parseLoader(
  fn: ArrowFunction | FunctionExpression,
): ParsedLoader | null {
  const body = Node.isArrowFunction(fn) ? fn.getBody() : undefined;
  if (!body || !Node.isCallExpression(body)) return null;

  // `() => import('path')` shorthand — no `.then`, no accessor.
  if (body.getExpression().getKind() === SyntaxKind.ImportKeyword) {
    const pathArg = body.getArguments()[0];
    if (!isPathLiteral(pathArg)) return null;
    return { importPath: pathArg.getLiteralText(), accessor: [] };
  }

  const thenAccess = body.getExpression();
  if (!Node.isPropertyAccessExpression(thenAccess) || thenAccess.getName() !== 'then')
    return null;

  const importCall = thenAccess.getExpression();
  if (
    !Node.isCallExpression(importCall) ||
    importCall.getExpression().getKind() !== SyntaxKind.ImportKeyword
  )
    return null;

  const pathArg = importCall.getArguments()[0];
  if (!isPathLiteral(pathArg)) return null;

  const cb = body.getArguments()[0];
  if (!cb || !Node.isArrowFunction(cb)) return null;
  const accessor = accessorChain(cb.getBody());
  if (!accessor) return null;

  return { importPath: pathArg.getLiteralText(), accessor };
}

// runtime `import()` accepts a template-literal specifier too — treat `` import(`./x`) `` like import('./x')
function isPathLiteral(
  node: Node | undefined,
): node is Node & { getLiteralText(): string } {
  return (
    !!node &&
    (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
  );
}

function accessorChain(node: Node): string[] | null {
  const parts: string[] = [];
  let cur: Node = node;
  while (Node.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.getName());
    cur = cur.getExpression();
  }
  // the chain must bottom out at the callback parameter identifier (e.g. `m`)
  return Node.isIdentifier(cur) && parts.length > 0 ? parts : null;
}
