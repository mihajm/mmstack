import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-forms-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Forms"
      pkg="@mmstack/forms"
      lead="A small toolbox on top of Angular Signal Forms. Signal Forms owns the model, the field tree, and validation; this fills the ergonomic gaps around them."
    >
      <docs-code [code]="install" lang="bash" />
      <p>
        Signal Forms give you <code>form(model, schema)</code>, which builds a
        reactive field tree from a model signal, and a <code>[formField]</code>
        directive that binds a control to one field. They own the model, the
        tree, and validation. What they leave thin is the ergonomics around
        them: attaching typed metadata to a field, reusing a field type, knowing
        what changed. This library fills those gaps and nothing else.
      </p>
      <p>
        It is not a forms framework. It layers on the stable
        <code>&#64;angular/forms/signals</code> API, so you keep the native
        model and rules and add only the pieces you need. It requires
        <code>&#64;angular/core</code> and <code>&#64;angular/forms</code> at
        v22 or newer.
      </p>

      <docs-section title="Three pieces" id="pieces">
        <table class="doc-table">
          <thead>
            <tr>
              <th>You want to</th>
              <th>Reach for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Attach typed metadata (a label, options) to a field</td>
              <td>
                <a mmLink="/docs/forms/field-metadata">Field metadata</a>
              </td>
            </tr>
            <tr>
              <td>Define a reusable field type once and apply it everywhere</td>
              <td><a mmLink="/docs/forms/composition">Composition</a></td>
            </tr>
            <tr>
              <td>Know what changed from a baseline, for diffs and guards</td>
              <td>
                <a mmLink="/docs/forms/change-tracking">Change tracking</a>
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Each piece is independent. You can add field metadata without
          touching composition, or track changes on a plain Signal Form.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class FormsOverview {
  protected readonly install = 'npm install @mmstack/forms';
}
