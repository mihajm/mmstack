import { Component, effect } from '@angular/core';
import { idb } from '@mmstack/local';

type Task = {
  id: number;
  title: string;
  status: 'pending' | 'completed';
};

@Component({
  selector: 'app-task-list',
  template: `
    @if (tasks.isLoading()) {
      <p>Loading tasks...</p>
    }
    <ul>
      @for (task of tasks.value(); track task.id) {
        <li>{{ task.title }}</li>
      }
    </ul>
    <button (click)="addTask()">Add New Task</button>
  `,
})
export class TaskListComponent {
  // a call to 'tasks' will always return the same instance, so updates happen across the entire application
  tasks = idb<Task, 'id'>('tasks');

  constructor() {
    effect(() => {
      console.log('Tasks in the database:', this.tasks.value());
    });
  }

  async addTask() {
    await this.tasks.add({ title: 'A new adventure!', status: 'pending' });
    console.log('Task added successfully!');
  }
}
