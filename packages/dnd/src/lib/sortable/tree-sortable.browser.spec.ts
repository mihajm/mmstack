import {
  byText,
  center,
  drag,
  labels,
  mount,
  resetPointer,
  until,
} from '../testing/browser';
import { TreeSortableExample } from '../testing/fixtures/tree-sortable';

let root: HTMLElement;
const childrenOf = (node: string) =>
  labels(root, `ul[data-node="${node}"] > li > app-tree-node > .tn-label`);
const grip = (text: string) => byText(root, '.tn-label', text);
const list = (node: string) =>
  root.querySelector(`ul[data-node="${node}"]`) as HTMLElement;

beforeEach(async () => {
  root = (await mount(TreeSortableExample)).nativeElement as HTMLElement;
  expect(root.textContent).toContain('mmstack');
});
afterEach(resetPointer);

describe('tree sortable (recursive, one group)', () => {
  it('renders the recursive tree', () => {
    expect(root.textContent).toContain('dnd');
    expect(root.textContent).toContain('primitives');
  });

  it('moves a leaf DOWN into a deeper node', async () => {
    await drag(grip('Photos'), center(list('21')), { steps: 24, settle: 80 });
    await until(() => expect(childrenOf('21')).toContain('Photos'));
  });

  it('moves a deep node UP to the root', async () => {
    // the "Documents" label sits in the root list, above Documents' own child zone
    await drag(grip('dnd'), center(grip('Documents')), {
      steps: 24,
      settle: 80,
    });
    await until(() => expect(childrenOf('root')).toContain('dnd'));
  });

  it('CYCLE GUARD: a node cannot be dropped into its own subtree', async () => {
    await drag(grip('Projects'), center(list('21')), { steps: 24, settle: 80 });
    await until(() => {
      expect(childrenOf('21')).not.toContain('Projects');
      expect(childrenOf('2')).toEqual(['mmstack', 'playground']);
    });
  });
});
