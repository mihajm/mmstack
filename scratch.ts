import { isDevMode } from '@angular/core';
import { resolveHitbox, ɵclearWarnedPlugins } from './packages/dnd/src/lib/provide';

// We just need a dummy injector, resolveHitbox uses runInInjectionContext
// But outside of injection context it might throw or not work.
// Let's just look at the code!
