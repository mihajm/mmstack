import { prependDelim, replaceWithDelim } from './delim';

describe('delim', () => {
  it('should prepend delimiter', () => {
    expect(prependDelim('app', 'title')).toBe('app::MMT_DELIM::title');
  });

  it('should replace strings with delimiter', () => {
    expect(replaceWithDelim('app.title')).toBe('app::MMT_DELIM::title');
    expect(replaceWithDelim('foo_bar_baz', '_')).toBe('foo::MMT_DELIM::bar::MMT_DELIM::baz');
  });
});
