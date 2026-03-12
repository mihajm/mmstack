import { type Validator } from '../validator.type';

export function defaultMinDateMessageFactory(dateLabel: string) {
  return `Must be after ${dateLabel}`;
}

export function createMinDateValidator<TDate = Date>(
  createMsg: (dateLabel: string) => string,
  toDate: (date: TDate | string) => Date,
  formatDate: (date: Date, locale: string) => string,
  locale: string,
): (date: TDate | string) => Validator<TDate | string | null> {
  return (date) => {
    const d = toDate(date);
    const matchTime = d.getTime();

    const msg = createMsg(formatDate(d, locale));
    return (value) => {
      if (value === null) return '';
      if (toDate(value).getTime() < matchTime) return msg;
      return '';
    };
  };
}
