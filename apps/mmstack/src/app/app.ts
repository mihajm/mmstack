import { Component } from '@angular/core';
import { TaskListComponent } from './todo.component';

@Component({
  selector: 'app-root',
  imports: [TaskListComponent],
  template: `<app-task-list />`,
  styles: ``,
})
export class App {}

export function test() {
  return 'yay';
}
