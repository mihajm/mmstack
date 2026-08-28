// Ratios of zoomWheelDelta follow d3-zoom's defaultWheelDelta (ISC, Mike Bostock).

/**
 * Wheel-event physics for zoomable viewports — shared by `panZoom` and bespoke
 * canvas implementations that own their transform some other way.
 */
export function zoomWheelDelta(event: WheelEvent): number {
  return (
    event.deltaY *
    (event.deltaMode === 1 ? 25 : event.deltaMode ? 500 : 1) *
    (event.ctrlKey ? 10 : 1)
  );
}

/**
 * Safari interop
 */
export function suppressNativePinch(el: HTMLElement): () => void {
  const cancel = (e: Event) => e.preventDefault();
  const types = ['gesturestart', 'gesturechange', 'gestureend'] as const;
  for (const type of types) el.addEventListener(type, cancel);
  return () => {
    for (const type of types) el.removeEventListener(type, cancel);
  };
}
