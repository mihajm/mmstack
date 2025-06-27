import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Row } from '@mmstack/table-core';

@Component({
  selector: 'tr[mmRow]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
  styles: ``,
})
export class RowComponent<T> {
  readonly row = input.required<Row<T>>();
}
