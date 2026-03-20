import { attemptToDate } from './util';

describe('Date Utils - attemptToDate', () => {
  it('should return native Date if passed a native Date', () => {
    const d = new Date();
    expect(attemptToDate(d)).toBe(d);
  });

  it('should return native Date if passed a string or number', () => {
    const val = 1710940150000;
    const d = attemptToDate(val);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(val);

    const ds = '2024-03-20T13:09:10Z';
    const dd = attemptToDate(ds);
    expect(dd).toBeInstanceOf(Date);
    expect(dd.toISOString()).toBe('2024-03-20T13:09:10.000Z');
  });

  it('should return current Date if passed null or undefined', () => {
    const before = Date.now();
    const d = attemptToDate(null as any);
    const after = Date.now();
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBeGreaterThanOrEqual(before);
    expect(d.getTime()).toBeLessThanOrEqual(after);
  });

  it('should handle Moment-like objects', () => {
    const d = new Date();
    const mockMoment = {
      toDate: () => d,
      unix: () => Math.floor(d.getTime() / 1000)
    };
    expect(attemptToDate(mockMoment)).toBe(d);
  });

  it('should handle Luxon-like objects', () => {
    const d = new Date();
    const mockLuxon = {
      toJSDate: () => d,
      toUnixInteger: () => Math.floor(d.getTime() / 1000)
    };
    expect(attemptToDate(mockLuxon)).toBe(d);
  });

  it('should throw Error if passed unsupported type', () => {
    expect(() => attemptToDate(true as any)).toThrow('Date is not');
  });

  it('should return current Date if passed unknown object', () => {
    const d = attemptToDate({} as any);
    expect(d).toBeInstanceOf(Date);
  });
});
