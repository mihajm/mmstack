import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'mm-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <nav>
      <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Chess</a>
      <a routerLink="/list" routerLinkActive="active">List</a>
      <a routerLink="/kanban" routerLinkActive="active">Kanban</a>
    </nav>
    <router-outlet />
  `,
  styles: `
    nav {
      display: flex;
      gap: 1rem;
      padding: 1rem;
      border-bottom: 1px solid #e5e7eb;
      font-family: system-ui, sans-serif;
    }
    nav a {
      color: #475569;
      text-decoration: none;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
    }
    nav a.active {
      background: #1e293b;
      color: white;
    }
  `,
})
export class App {}
