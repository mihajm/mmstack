import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { queryResource } from '@mmstack/resource';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet /> `,
  styles: ``,
})
export class AppComponent {
  test = queryResource(
    () => ({
      url: 'https://jsonplaceholder.typicode.com/pos2ts',
    }),
    {
      retry: 3,
    },
  );
}
