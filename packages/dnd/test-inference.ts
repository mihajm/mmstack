export type CreateDraggableOptions<TData> = {
  data: TData | (() => TData);
};

export type Draggable<TData> = {
  _data: TData;
};

// Overload for no data
export function draggable(): Draggable<void>;
// Overload for when data is provided
export function draggable<TData>(
  opt: CreateDraggableOptions<TData>,
): Draggable<TData>;
// Implementation
export function draggable<TData>(
  opt?: CreateDraggableOptions<TData>,
): Draggable<TData> {
  return {} as any;
}

// Test 1: No data
const d1 = draggable();
// Expected: Draggable<void>
type T1 = typeof d1;

// Test 2: With data (inference)
const d2 = draggable({ data: 123 });
// Expected: Draggable<number>
type T2 = typeof d2;

// Test 3: Explicit TData - should FAIL if data is missing
// @ts-expect-error testing types
const d3 = draggable<string>({});

// Test 4: Explicit TData - should WORK if data is present
const d4 = draggable<string>({ data: 'hello' });
type T4 = typeof d4;

// Assertions
const check1: T1 = {} as Draggable<void>;
const check2: T2 = {} as Draggable<number>;
const check4: T4 = {} as Draggable<string>;

console.log('Type checks passed!');
