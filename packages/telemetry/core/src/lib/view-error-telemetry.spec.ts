import {
  Component,
  ErrorHandler,
  signal,
  type ErrorDetails,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import {
  provideViewErrorTelemetry,
  VIEW_ERROR_FINDING,
} from './view-error-telemetry';

function boom(): string {
  throw new Error('bad row');
}

@Component({ selector: 'mm-thrower', template: `{{ read() }}` })
class Thrower {
  protected readonly read = boom;
}

// angular-eslint (22.5) cannot parse `@boundary` yet; a template held in a const is not extracted for template lint.
const GUARDED_TEMPLATE = `
    @boundary {
      <mm-thrower />
    } @error {
      <span class="caught">caught</span>
    }
  `;

@Component({
  selector: 'mm-guarded',
  imports: [Thrower],
  template: GUARDED_TEMPLATE,
})
class Guarded {}

const armed = signal(false);

@Component({
  selector: 'mm-unguarded',
  template: `{{ armed() ? read() : 'ok' }}`,
})
class Unguarded {
  protected readonly armed = armed;
  protected readonly read = boom;
}

class Recorder extends ErrorHandler {
  readonly handled: unknown[] = [];
  override handleError(error: unknown): void {
    this.handled.push(error);
  }
}

class ViewAwareRecorder extends Recorder {
  readonly viewErrors: ErrorDetails[] = [];
  override onViewError(_error: Error, details: ErrorDetails): void {
    this.viewErrors.push(details);
  }
}

function setup(delegate: Recorder) {
  const sink = memorySink();
  TestBed.configureTestingModule({
    providers: [
      provideTelemetry({ sinks: [sink] }),
      provideViewErrorTelemetry({ delegate: () => delegate }),
    ],
  });
  return sink;
}

describe('provideViewErrorTelemetry', () => {
  it('a throw under @boundary lands one finding with the declaring and the boundary component names', () => {
    const delegate = new Recorder();
    const sink = setup(delegate);
    const fixture = TestBed.createComponent(Guarded);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.caught')).not.toBeNull();
    expect(sink.findings.length).toBe(1);
    expect(sink.findings[0].finding).toMatchObject({
      code: VIEW_ERROR_FINDING,
      severity: 'error',
      path: Thrower.name, // the runtime class name (the compiler may prefix it, a bundler minifies it)
      node: Guarded.name,
    });
    expect(sink.findings[0].attrs).toMatchObject({
      declarationType: Thrower.name,
      boundaryType: Guarded.name,
    });
    // a delegate without onViewError gets handleError, as Angular would have called it
    expect(delegate.handled.length).toBe(1);
  });

  it('a delegate with onViewError receives the details instead of handleError', () => {
    const delegate = new ViewAwareRecorder();
    setup(delegate);
    TestBed.createComponent(Guarded).detectChanges();
    expect(delegate.viewErrors.map((d) => d.boundary?.type)).toEqual([Guarded]);
    expect(delegate.handled).toEqual([]);
  });

  it('a throw outside any boundary still reaches handleError and records no finding', async () => {
    const delegate = new Recorder();
    const sink = setup(delegate);
    armed.set(false);
    const fixture = TestBed.createComponent(Unguarded);
    fixture.autoDetectChanges();
    // the scheduler's tick hands an uncaught render error to the application's ErrorHandler
    armed.set(true);
    await expect(fixture.whenStable()).rejects.toThrow('bad row');
    expect(delegate.handled.length).toBe(1);
    expect((delegate.handled[0] as Error).message).toBe('bad row');
    expect(sink.findings).toEqual([]);
  });

  it('without a delegate, errors continue to the default ErrorHandler', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({ sinks: [sink] }),
        provideViewErrorTelemetry(),
      ],
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      TestBed.createComponent(Guarded).detectChanges();
      expect(sink.findings.length).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
