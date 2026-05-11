import { Component } from '@angular/core';
import { Board } from './chess/board';

@Component({
  selector: 'mm-playground',
  imports: [Board],
  template: `<mm-board />`,
  styles: ``,
})
export class Playground {}
