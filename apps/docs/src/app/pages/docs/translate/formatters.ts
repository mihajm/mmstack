import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-translate-formatters',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Formatters"
      pkg="@mmstack/translate"
      lead="Reactive wrappers over the Intl.* APIs for dates, numbers, currency, percent, units, lists, relative time, and display names. They read the active locale from a signal, so a price or a date reformats itself when the language changes."
    >
      <p>
        A translated string handles the words; a formatter handles the numbers,
        dates, and lists between them. These wrap the platform
        <code>Intl</code> APIs, which means no new formatting engine and no zone
        dependency, and because they read the locale from
        <code>injectDynamicLocale()</code>, a value wrapped in a
        <code>computed</code> recomputes on a locale switch without you wiring
        anything up. (Inline number and date formatting inside ICU messages is
        deliberately not the focus; format here and pass the result as a
        variable to a translation.)
      </p>

      <docs-section title="Recipe: format a price" id="price">
        <p>
          <code>injectFormatters()</code> returns all of them as one facade, and
          the injected functions resolve the locale for you. This is the
          recommended path in components and services. Here a price signal and
          the active locale both feed one <code>computed</code>: change either
          and the displayed string updates.
        </p>
        <docs-code [code]="facade" lang="ts" />
        <p>
          On <code>en-US</code> that reads <code>€1,234.56</code>; switch to
          <code>de-DE</code> and the same value becomes <code>1.234,56 €</code>,
          grouping and symbol placement included, with no extra code. If you
          only need one formatter, each has a single-purpose companion
          (<code>injectFormatDate</code>, <code>injectFormatCurrency</code>, and
          so on) that works the same way.
        </p>
      </docs-section>

      <docs-section title="Recipe: relative time (3 days ago)" id="relative">
        <p>
          <code>formatRelativeTime</code> wraps
          <code>Intl.RelativeTimeFormat</code>. Give it a value and a unit and
          it phrases the difference in the active language. Set
          <code>numeric: 'auto'</code> and it prefers words like "yesterday"
          over "1 day ago" where the locale has them.
        </p>
        <docs-code [code]="relative" lang="ts" />
        <p>
          <code>formatRelativeTime</code> formats a value against a unit; it
          does not compute the difference for you. When you have a timestamp and
          want the diff computed, reach for its sibling
          <code>formatRelativeTimeToNow</code> (and
          <code>injectFormatRelativeTimeToNow</code>). Hand it a date or
          timestamp and it diffs against now, picks the largest fitting unit,
          and phrases it: <code>toNow(post.createdAt)</code> reads "3 days ago".
          Pass <code>numeric: 'auto'</code> for the natural phrasing, or a fixed
          <code>now</code> instant when you need a stable value in a test.
        </p>
      </docs-section>

      <docs-section title="Recipe: units and plural categories" id="unit">
        <p>
          <code>formatUnit</code> renders a number with a measurement unit
          through <code>Intl.NumberFormat</code>'s unit style. Give it any
          ECMA-402 unit or a <code>-per-</code> compound and a display style:
          <code>formatUnit(16, 'kilometer-per-hour')</code> reads "16 km/h" on
          <code>en-US</code>, or "16 kilometers per hour" with
          <code>unitDisplay: 'long'</code>.
        </p>
        <p>
          <code>selectPluralCategory</code> returns the CLDR plural category
          (<code>one</code>, <code>few</code>, <code>other</code>, and the rest)
          for a value via <code>Intl.PluralRules</code>. Reach for it when you
          want to branch a class or a custom message map on plurality without
          writing a full ICU <code>plural</code> arm, and it re-resolves on a
          locale switch like the others.
          <code>injectSelectPlural</code> is the injected form.
        </p>
        <docs-code [code]="unit" lang="ts" />
      </docs-section>

      <docs-section title="What ships" id="what">
        <p>
          Eight formatters, each a thin reactive wrapper over one Intl API.
          <code>formatRelativeTimeToNow</code> rides on
          <code>Intl.RelativeTimeFormat</code> too, as the auto-unit sibling of
          <code>formatRelativeTime</code>, and
          <code>selectPluralCategory</code> pairs alongside them over
          <code>Intl.PluralRules</code>.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>Formatter</th>
              <th>Wraps</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>formatDate</code></td>
              <td><code>Intl.DateTimeFormat</code></td>
            </tr>
            <tr>
              <td><code>formatNumber</code></td>
              <td><code>Intl.NumberFormat</code></td>
            </tr>
            <tr>
              <td><code>formatCurrency</code></td>
              <td><code>Intl.NumberFormat</code> (currency style)</td>
            </tr>
            <tr>
              <td><code>formatPercent</code></td>
              <td><code>Intl.NumberFormat</code> (percent style)</td>
            </tr>
            <tr>
              <td><code>formatList</code></td>
              <td><code>Intl.ListFormat</code></td>
            </tr>
            <tr>
              <td><code>formatUnit</code></td>
              <td><code>Intl.NumberFormat</code> (unit style)</td>
            </tr>
            <tr>
              <td><code>formatRelativeTime</code></td>
              <td><code>Intl.RelativeTimeFormat</code></td>
            </tr>
            <tr>
              <td><code>formatDisplayName</code></td>
              <td><code>Intl.DisplayNames</code></td>
            </tr>
          </tbody>
        </table>
      </docs-section>

      <docs-section title="Standalone functions and SSR" id="standalone">
        <p>
          Outside an injection context, call the standalone functions and pass
          the locale explicitly, either as a string or through the options
          object. This matters for SSR: the overloads that require a locale are
          safe, while the deprecated form that omits the locale reads a
          process-level global that can cross-contaminate concurrent requests
          rendering different locales on one Node process. Prefer the injected
          formatters, or pass the locale.
        </p>
        <docs-code [code]="explicit" lang="ts" />
      </docs-section>

      <docs-section title="App-wide defaults" id="defaults">
        <p>
          If you always want dates in a medium format or currency shown as a
          code, set it once with <code>provideFormatDefaults</code> (or the
          per-formatter <code>provideFormat*Defaults</code>). The injected
          formatters merge these with the active locale, so call sites stay
          short and consistent.
        </p>
        <docs-code [code]="providerDefaults" lang="ts" />
      </docs-section>

      <docs-section title="Escape hatch: injectIntl" id="intl">
        <p>
          For the rare case that no wrapper covers, <code>injectIntl()</code>
          hands you the underlying <code>Signal&lt;IntlShape&gt;</code> from
          <code>&#64;formatjs/intl</code> that the store keeps in step with the
          active locale. Read it inside a <code>computed</code> and call
          <code>intl().formatMessage(...)</code> or any other formatjs API
          directly. Prefer the named formatters where they fit; reach here only
          when they do not.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class FormattersDoc {
  protected readonly facade = `import { computed, signal } from '@angular/core';
import { injectFormatters } from '@mmstack/translate';

export class ProductComponent {
  private readonly fmt = injectFormatters();

  readonly price = signal(1234.56);
  readonly date = new Date();

  // recomputes on price changes AND locale changes, no explicit locale needed
  readonly displayPrice = computed(() => this.fmt.currency(this.price(), 'EUR'));
  readonly displayDate = computed(() => this.fmt.date(this.date));
}`;

  protected readonly relative = `import { computed, signal } from '@angular/core';
import { injectFormatRelativeTime } from '@mmstack/translate';

export class ActivityComponent {
  private readonly formatRelative = injectFormatRelativeTime();

  readonly daysAgo = signal(-3);

  // en-US: "3 days ago"  ·  de-DE: "vor 3 Tagen"
  readonly when = computed(() =>
    this.formatRelative(this.daysAgo(), 'day', { numeric: 'auto' }),
  );
}`;

  protected readonly unit = `import { computed, signal } from '@angular/core';
import { injectFormatUnit, injectSelectPlural } from '@mmstack/translate';

export class WeatherComponent {
  private readonly formatUnit = injectFormatUnit();
  private readonly plural = injectSelectPlural();

  readonly speed = signal(16);
  readonly count = signal(3);

  // en-US: "16 km/h"
  readonly wind = computed(() =>
    this.formatUnit(this.speed(), 'kilometer-per-hour'),
  );

  // CLDR category for class/branch logic: 'one' | 'few' | 'other' | ...
  readonly badgeClass = computed(() => 'badge--' + this.plural(this.count()));
}`;

  protected readonly explicit = `import { computed } from '@angular/core';
import {
  formatCurrency,
  formatDate,
  injectDynamicLocale,
} from '@mmstack/translate';

const locale = injectDynamicLocale();

readonly displayPrice = computed(() =>
  formatCurrency(this.price(), 'EUR', { locale: locale() }),
);
readonly displayDate = computed(() => formatDate(this.date, locale()));`;

  protected readonly providerDefaults = `import { provideFormatDefaults } from '@mmstack/translate';

bootstrapApplication(AppComponent, {
  providers: [
    provideFormatDefaults({
      date: { format: 'mediumDate' },
      number: { useGrouping: true, maxFractionDigits: 2 },
      currency: { display: 'code' },
      relativeTime: { numeric: 'auto' },
      list: { type: 'disjunction' },
      percent: { maxFractionDigits: 1 },
      displayName: { style: 'short' },
    }),
  ],
});`;
}
