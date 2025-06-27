import { Component, input } from '@angular/core';
import { Table } from '@mmstack/table-core';

@Component({
  selector: 'tbody[mmTableBody]',
  template: `yay`,
  styles: ``,
})
export class TableBodyComponent<T> {
  readonly table = input.required<Table<T>>();
}
