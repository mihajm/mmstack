import { isPlatformServer, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  effect,
  inject,
  InjectionToken,
  input,
  PLATFORM_ID,
  Provider,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import {
  FloatLabelType,
  MAT_FORM_FIELD_DEFAULT_OPTIONS,
  MatError,
  MatFormField,
  MatFormFieldAppearance,
  MatHint,
  MatLabel,
  MatPrefix,
  MatSuffix,
  SubscriptSizing,
} from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import {
  MatOption,
  MatSelect,
  MatSelectTrigger,
} from '@angular/material/select';
import { MatTooltip } from '@angular/material/tooltip';
import { queryResource, QueryResourceOptions } from '@mmstack/resource';
import { SearchState, SignalErrorValidator } from './adapters';
import { SelectOptionContent } from './select-field';

const SEARCH_QUERY_RESOURCE_OPTIONS = new InjectionToken<
  QueryResourceOptions<any>
>('MMSTACK_SEARCH_QUERY_RESOURCE_OPTIONS');

export function provideSearchResourceOptions(
  opt: QueryResourceOptions<any>,
): Provider {
  return {
    provide: SEARCH_QUERY_RESOURCE_OPTIONS,
    useValue: opt,
  };
}

export function injectSearchResourceOptions(): QueryResourceOptions<any> {
  return (
    inject(SEARCH_QUERY_RESOURCE_OPTIONS, { optional: true }) ?? {
      keepPrevious: true,
      defaultValue: [],
    }
  );
}

@Component({
  selector: 'mm-search-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    MatFormField,
    MatLabel,
    MatHint,
    MatError,
    MatSelect,
    MatOption,
    MatSelectTrigger,
    MatPrefix,
    MatSuffix,
    MatInput,
    MatProgressSpinner,
    SignalErrorValidator,
    MatTooltip,
    NgTemplateOutlet,
  ],
  host: {
    class: 'mm-search-field',
  },
  template: `
    <mat-form-field
      [appearance]="appearance()"
      [floatLabel]="floatLabel()"
      [subscriptSizing]="subscriptSizing()"
      [hideRequiredMarker]="hideRequiredMarker()"
    >
      <mat-label>{{ state().label() }}</mat-label>

      @if (prefix()) {
        <ng-container matPrefix>
          <ng-content select="[matPrefix]" />
        </ng-container>
      }

      <mat-select
        [class.readonly]="state().readonly()"
        [(ngModel)]="state().value"
        [required]="state().required()"
        [mmSignalError]="state().error()"
        [panelWidth]="panelWidth()"
        [disabled]="state().disabled()"
        [compareWith]="state().equal"
        [placeholder]="state().placeholder()"
        [disableOptionCentering]="disableOptionCentering()"
        [hideSingleSelectionIndicator]="hideSingleSelectionIndicator()"
        (blur)="state().markAsTouched()"
        (closed)="state().markAsTouched(); cancelFocus()"
        (opened)="focus(searchInput)"
      >
        <mat-select-trigger>{{ state().valueLabel() }}</mat-select-trigger>

        <mat-option disabled>
          <div>
            <input
              #searchInput
              #searchModel="ngModel"
              class="mm-search-select-input"
              matInput
              [disabled]="state().disabled() || state().readonly()"
              [(ngModel)]="state().query"
              [placeholder]="searchPlaceholder()"
              (input)="$event.stopPropagation()"
            />
            <mat-progress-spinner
              matSuffix
              [style.visibility]="resource.isLoading() ? 'visible' : 'hidden'"
              mode="indeterminate"
              diameter="15"
            />
          </div>
        </mat-option>

        @for (opt of options(); track opt.id) {
          <mat-option
            [value]="opt.value"
            [disabled]="opt.disabled()"
            (onSelectionChange)="
              $event.isUserInput && state().onSelected(opt.value)
            "
          >
            <ng-container
              [ngTemplateOutlet]="optionTemplate()?.template ?? fallback"
              [ngTemplateOutletContext]="{ $implicit: opt }"
            />
          </mat-option>
        }
      </mat-select>

      <mat-error
        [matTooltip]="state().errorTooltip()"
        matTooltipPositionAtOrigin
        matTooltipClass="mm-multiline-tooltip"
        >{{ state().error() }}</mat-error
      >

      @if (state().hint()) {
        <mat-hint
          [matTooltip]="state().hintTooltip()"
          matTooltipPositionAtOrigin
          matTooltipClass="mm-multiline-tooltip"
          >{{ state().hint() }}</mat-hint
        >
      }

      @if (suffix()) {
        <ng-container matSuffix>
          <ng-content select="[matSuffix]" />
        </ng-container>
      }
    </mat-form-field>

    <ng-template #fallback let-opt>{{ opt.label() }}</ng-template>
  `,
  styles: `
    .mm-search-field {
      display: contents;

      mat-form-field {
        width: 100%;

        .mat-mdc-notch-piece.mdc-notched-outline__notch:has(mat-label:empty) {
          display: none;
        }
      }
    }

    .mat-mdc-option[aria-disabled='true']:has(input.mm-search-select-input) {
      position: sticky;
      top: -8px;
      z-index: 1;
      opacity: 1;
      margin-top: -8px;
      pointer-events: all;
      background: inherit;
      border-bottom: 1px solid var(--mat-sys-outline);
      span.mdc-list-item__primary-text {
        width: 100%;
      }

      div {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }

      .mdc-list-item__primary-text {
        opacity: 1;
      }
    }

    input.mm-search-select-input {
      padding-top: 10px;

      &::placeholder {
        opacity: 0.8;
      }
    }
  `,
})
export class SearchFieldComponent<T, TParent = undefined> {
  readonly state = input.required<SearchState<T, TParent>>();

  readonly appearance = input<MatFormFieldAppearance>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })?.appearance ??
      'fill',
  );
  readonly floatLabel = input<FloatLabelType>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })?.floatLabel ??
      'auto',
  );
  readonly subscriptSizing = input<SubscriptSizing>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })
      ?.subscriptSizing ?? 'fixed',
  );
  readonly hideRequiredMarker = input<boolean>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })
      ?.hideRequiredMarker ?? false,
  );

  protected readonly optionTemplate = contentChild(SelectOptionContent);

  protected readonly searchPlaceholder = computed(
    () => this.state().searchPlaceholder?.() ?? '',
  );

  protected readonly panelWidth = computed(
    () => this.state().panelWidth?.() ?? 'auto',
  );

  protected readonly disableOptionCentering = computed(
    () => this.state().disableOptionCentering?.() ?? false,
  );

  protected readonly hideSingleSelectionIndicator = computed(
    () => this.state().hideSingleSelectionIndicator?.() ?? false,
  );

  private readonly model = viewChild.required(NgModel);

  protected readonly resource = queryResource<T[]>(
    () => this.state().request(),
    injectSearchResourceOptions(),
  );

  private readonly identifiedOptions = computed(() => {
    const identify = this.state().identify();

    return (this.resource.value() ?? []).map((value) => ({
      value,
      id: identify(value),
    }));
  });

  private readonly allOptions = computed(() =>
    this.identifiedOptions().map((o) => {
      return {
        ...o,
        label: computed(() => this.state().displayWith()(o.value)),
        disabled: computed(() => {
          if (o.id === this.state().valueId()) return false;
          return (
            this.state().disabled() ||
            this.state().readonly() ||
            this.state().disableOption()(o.value)
          );
        }),
      };
    }),
  );

  protected readonly options = computed(() => {
    const curId = this.state().valueId();
    const opt = this.allOptions();
    if (!curId) return opt;

    if (opt.length && opt.some((o) => o.id === curId)) return opt;

    return [
      ...opt,
      {
        id: curId,
        value: this.state().value(),
        label: computed(() => this.state().valueLabel()),
        disabled: computed(() => false),
      },
    ];
  });

  protected readonly prefix = contentChild(MatPrefix);

  protected readonly suffix = contentChild(MatSuffix);

  constructor() {
    effect(() => {
      if (this.state().touched()) this.model().control.markAsTouched();
      else this.model().control.markAsUntouched();
    });
  }

  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private focusTimeout: ReturnType<typeof setTimeout> | undefined;
  protected focus(el?: HTMLInputElement) {
    if (this.isServer) return;
    if (this.focusTimeout) clearTimeout(this.focusTimeout);
    this.focusTimeout = setTimeout(() => el?.focus());
  }

  protected cancelFocus() {
    if (this.isServer) return;
    if (this.focusTimeout) clearTimeout(this.focusTimeout);
  }
}
