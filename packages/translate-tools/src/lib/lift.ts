import { Node, type ObjectLiteralExpression } from 'ts-morph';
import { type NestedTranslation } from './nested';

/**
 * Statically lift a `createNamespace`/`createTranslation` translation object literal into a plain
 * {@link NestedTranslation} — no code execution. String leaves and nested objects pass through;
 * `withParams<…>('msg')` is unwrapped to its message string (the type arg is compile-time only and
 * irrelevant to the round-trip). Anything dynamic (a variable, a concatenation, a spread) throws —
 * the author must inline a literal for the tool to round-trip it.
 */
export function liftObjectLiteral(obj: ObjectLiteralExpression): NestedTranslation {
  const out: NestedTranslation = {};

  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop))
      throw new Error(
        `Unsupported entry in translation object (only "key: value" is supported): ${prop.getText()}`,
      );

    out[propKey(prop.getNameNode())] = liftValue(prop.getInitializerOrThrow());
  }

  return out;
}

function propKey(name: Node): string {
  if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name))
    return name.getLiteralText();
  if (Node.isIdentifier(name)) return name.getText();
  throw new Error(`Unsupported translation key: ${name.getText()}`);
}

function liftValue(node: Node): string | NestedTranslation {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralText();

  if (Node.isObjectLiteralExpression(node)) return liftObjectLiteral(node);

  if (Node.isCallExpression(node)) {
    if (node.getExpression().getText() === 'withParams') {
      const arg = node.getArguments()[0];
      if (
        arg &&
        (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
      )
        return arg.getLiteralText();
    }
    throw new Error(
      `Unsupported call in a translation value (only withParams('literal') is supported): ${node.getText()}`,
    );
  }

  throw new Error(
    `Unsupported translation value (expected a string literal, withParams('literal'), or a nested object): ${node.getText()}`,
  );
}
