import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-di-injectable',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="injectable"
      pkg="@mmstack/di"
      lead="A typed token with matching inject and provide functions, so you skip the InjectionToken boilerplate. Think of it as createContext for Angular."
    >
      <docs-section title="Basic usage" id="basic">
        <p>
          <code>injectable&lt;T&gt;(name)</code> returns a
          <code>[inject, provide, token]</code> tuple. Name the first two at the
          call site, provide the value where you want it, and inject it anywhere
          below. Without a provider the injector returns
          <code>null</code>.
        </p>
        <docs-code [code]="basic" lang="ts" />
      </docs-section>

      <docs-section title="Factory providers" id="factory">
        <p>
          <code>provide</code> accepts a factory. Pass a dependency array when
          the factory needs other services. A zero-argument factory needs no
          array and can still call <code>inject()</code>, since it runs in an
          injection context.
        </p>
        <docs-code [code]="factory" lang="ts" />
      </docs-section>

      <docs-section title="Fallbacks and required values" id="fallbacks">
        <p>
          The options object changes what a missing provider does. Give a
          <code>fallback</code> for a default value, <code>lazyFallback</code>
          when the default needs <code>inject()</code> or is expensive, or
          <code>errorMessage</code> to make the value required. The reader's
          return type follows: <code>T</code> with a fallback, never
          <code>null</code> with an error message.
        </p>
        <docs-code [code]="fallbacks" lang="ts" />
      </docs-section>

      <docs-section title="Providing a function value" id="function-value">
        <p>
          <code>provide</code> treats any function as a factory. When the
          token's type is itself a function, wrap the value in a factory that
          returns it, or it gets called as one.
        </p>
        <docs-code [code]="functionValue" lang="ts" />
      </docs-section>

      <docs-section title="The raw token" id="token">
        <p>
          The third tuple element is the underlying
          <code>InjectionToken</code>, for <code>deps</code> arrays,
          <code>Injector.create</code>, or overriding in tests.
        </p>
        <docs-code [code]="token" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class DiInjectable {
  protected readonly basic = `import { injectable } from '@mmstack/di';

const [injectLogger, provideLogger] = injectable<Logger>('Logger');

// provide it on a component or in a providers array
providers: [provideLogger({ log: (m) => console.log(m) })];

// inject it anywhere below
const logger = injectLogger(); // Logger | null`;

  protected readonly factory = `const [injectApiConfig, provideApiConfig] = injectable<ApiConfig>('ApiConfig');

// with dependencies
provideApiConfig(
  (http: HttpClient) => ({ baseUrl: '/api', timeout: 5000 }),
  [HttpClient],
);

// zero-arg factory, still allowed to inject()
provideApiConfig(() => ({ baseUrl: inject(BASE_URL), timeout: 5000 }));`;

  protected readonly fallbacks = `// default value
const [injectTheme] = injectable<Theme>('Theme', {
  fallback: { primary: '#007bff' },
});

// lazily evaluated default (can inject, runs at most once per app)
const [injectTheme2] = injectable<Theme>('Theme', {
  lazyFallback: () => ({ primary: inject(APP_PRIMARY) }),
});

// required, throws if not provided
const [injectApiKey] = injectable<string>('ApiKey', {
  errorMessage: 'Provide it with provideApiKey().',
});`;

  protected readonly functionValue = `type Validator = (value: string) => boolean;

const [injectValidator, provideValidator] = injectable<Validator>('Validator');

provideValidator(() => isLongEnough); // factory returns the function
// provideValidator(isLongEnough);     // would be called as a factory`;

  protected readonly token = `const [injectApi, provideApi, API_TOKEN] = injectable<ApiClient>('Api');

// use the token in a classic provider or a test
{ provide: OTHER, useFactory: (api) => new Other(api), deps: [API_TOKEN] }
TestBed.overrideProvider(API_TOKEN, { useValue: fakeApi });`;
}
