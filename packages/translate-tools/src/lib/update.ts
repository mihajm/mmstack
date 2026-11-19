import { type Project } from 'ts-morph';
import { objectLiteralText } from './codegen';
import { exportedCall } from './export-call';
import { type NestedTranslation } from './nested';

/**
 * Replace the translation object of an existing `createTranslation(...)` call in place (used when
 * re-importing a locale that already exists), preserving the rest of the file. Returns `false` if
 * the export/call can't be found. The file is re-formatted so the replacement indents cleanly.
 * Pass `isDefaultExport` for a call that is the module's default export (inline or via a const).
 */
export function replaceTranslationLiteral(
  project: Project,
  filePath: string,
  exportName: string,
  translation: NestedTranslation,
  isDefaultExport = false,
): boolean {
  const sf = project.getSourceFile(filePath);
  const init = sf && exportedCall(sf, exportName, isDefaultExport);
  if (!init) return false;

  const arg = init.getArguments()[1];
  if (!arg) return false;

  arg.replaceWithText(objectLiteralText(translation, 1));
  sf?.formatText();
  return true;
}
