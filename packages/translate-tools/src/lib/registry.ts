import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';
import { isIdentifier } from './identifier';

/**
 * Find every `registerNamespace(...)` call in a source file. `registerRemoteNamespace` is
 * deliberately ignored — its translations are served, not authored in files, so there's nothing to
 * export or round-trip.
 */
export function findRegisterNamespaceCalls(sf: SourceFile): CallExpression[] {
  return sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === 'registerNamespace');
}

function localeProperty(obj: ObjectLiteralExpression, locale: string) {
  return obj.getProperties().find((p) => {
    if (!Node.isPropertyAssignment(p)) return false;
    const name = p.getNameNode();
    const text = Node.isStringLiteral(name) ? name.getLiteralText() : name.getText();
    return text === locale;
  });
}

/**
 * Insert (or replace) a locale's loader in a `registerNamespace(default, other)` call's `other`
 * map, so a freshly-imported locale is actually registered. Mutates the call in place — the caller
 * saves the source file afterwards.
 */
export function addLocaleLoader(
  call: CallExpression,
  locale: string,
  importPath: string,
  exportName: string,
): void {
  if (call.getArguments().length < 2) call.addArgument('{}');

  const other = call.getArguments()[1];
  if (!other || !Node.isObjectLiteralExpression(other))
    throw new Error(
      "registerNamespace's second argument must be an object literal of locale loaders.",
    );

  localeProperty(other, locale)?.remove();

  other.addPropertyAssignment({
    name: isIdentifier(locale) ? locale : JSON.stringify(locale),
    initializer: `() => import(${JSON.stringify(importPath)}).then((m) => m.${exportName})`,
  });
}
