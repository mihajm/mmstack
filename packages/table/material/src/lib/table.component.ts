import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Table } from '@mmstack/table-core';
import { TableBodyComponent } from './table-body.component';

@Component({
  selector: 'mm-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TableBodyComponent],
  template: `
    <table>
      <tbody mmTableBody [table]="table()"></tbody>
    </table>
  `,
  styles: ``,
})
export class TableComponent<T> {
  readonly table = input.required<Table<T>>();
}
