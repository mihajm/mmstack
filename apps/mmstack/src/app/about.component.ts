import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-about',
  imports: [RouterLink],
  template: `about component <a routerLink="/home">Home</a>`,
})
export class AboutComponent {}
