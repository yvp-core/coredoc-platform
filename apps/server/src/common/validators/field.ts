/**
 * Field schemas that speak class-validator's messages.
 *
 * Track B3 replaced the DTO classes with zod schemas at the controller boundary. The decorator
 * messages are the wire contract a client matches on, so each helper reproduces the exact string
 * its decorator produced — `IsString` → "x must be a string", `MaxLength(n)` → "x must be shorter
 * than or equal to n characters", and so on. `dtoFieldMessages` assembles them into the same
 * array the global `ValidationPipe` used to throw.
 *
 * One difference, and it is inherent: class-validator ran every constraint on a property and
 * reported each failure, while zod stops a field at its first failing check. A body that breaks
 * two rules of the SAME field now reports the first of them instead of both; a body that breaks
 * one rule each on two fields still reports both, in declaration order.
 */
import { z } from 'zod';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface StringFieldOptions {
  /** `@IsNotEmpty()` */
  notEmpty?: boolean;
  /** `@MinLength(n)` */
  min?: number;
  /** `@MaxLength(n)` */
  max?: number;
  /** `@Matches(re, { message })` — the message is the decorator's, verbatim. */
  matches?: { pattern: RegExp; message: string };
}

export function stringField(name: string, options: StringFieldOptions = {}): z.ZodType<string> {
  let schema: z.ZodType<string> = z.custom<string>((value) => typeof value === 'string', `${name} must be a string`);
  if (options.notEmpty) schema = schema.refine((value) => value.length > 0, `${name} should not be empty`);
  if (options.min !== undefined) {
    const min = options.min;
    schema = schema.refine((value) => value.length >= min, `${name} must be longer than or equal to ${min} characters`);
  }
  if (options.max !== undefined) {
    const max = options.max;
    schema = schema.refine(
      (value) => value.length <= max,
      `${name} must be shorter than or equal to ${max} characters`,
    );
  }
  if (options.matches) {
    const { pattern, message } = options.matches;
    schema = schema.refine((value) => pattern.test(value), message);
  }
  return schema;
}

export function booleanField(name: string): z.ZodType<boolean> {
  return z.custom<boolean>((value) => typeof value === 'boolean', `${name} must be a boolean value`);
}

export function intField(name: string, options: { min?: number; max?: number } = {}): z.ZodType<number> {
  let schema: z.ZodType<number> = z.custom<number>(
    (value) => typeof value === 'number' && Number.isInteger(value),
    `${name} must be an integer number`,
  );
  if (options.min !== undefined) {
    const min = options.min;
    schema = schema.refine((value) => value >= min, `${name} must not be less than ${min}`);
  }
  if (options.max !== undefined) {
    const max = options.max;
    schema = schema.refine((value) => value <= max, `${name} must not be greater than ${max}`);
  }
  return schema;
}

export function numberField(name: string, options: { min?: number } = {}): z.ZodType<number> {
  let schema: z.ZodType<number> = z.custom<number>(
    (value) => typeof value === 'number' && Number.isFinite(value),
    `${name} must be a number conforming to the specified constraints`,
  );
  if (options.min !== undefined) {
    const min = options.min;
    schema = schema.refine((value) => value >= min, `${name} must not be less than ${min}`);
  }
  return schema;
}

/** `@IsIn(values)` / `@IsEnum(E)` — the trailing separator of a list containing `null` included. */
export function oneOfField<const T extends readonly unknown[]>(name: string, values: T): z.ZodType<T[number]> {
  return z.custom<T[number]>(
    (value) => values.includes(value),
    `${name} must be one of the following values: ${values.join(', ')}`,
  );
}

export function uuidField(name: string): z.ZodType<string> {
  return z.uuid({ error: `${name} must be a UUID` });
}

export function emailField(name: string): z.ZodType<string> {
  return z.email({ error: `${name} must be an email` });
}

/** `@IsISO8601()` / `@IsDateString()` — both accept a date-only string. */
export function isoDateField(name: string): z.ZodType<string> {
  return z.custom<string>(
    (value) => typeof value === 'string' && ISO_8601.test(value) && !Number.isNaN(Date.parse(value)),
    `${name} must be a valid ISO 8601 date string`,
  );
}

/** `@IsArray()` + `@ArrayMaxSize(n)` + `@ValidateNested({ each: true })`, in that order. */
export function arrayField<T>(name: string, item: z.ZodType<T>, options: { max?: number } = {}) {
  const base = z.custom<unknown[]>(Array.isArray, `${name} must be an array`);
  const max = options.max;
  const sized =
    max === undefined
      ? base
      : base.refine((value) => value.length <= max, `${name} must contain no more than ${max} elements`);
  return sized.pipe(z.array(item));
}
