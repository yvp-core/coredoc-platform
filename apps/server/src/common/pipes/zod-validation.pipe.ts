/**
 * The single request-body validation mechanism at the controller boundary
 * (`.scratch/server-structure-cleanup/spec.md`, Track B): `@Body(new ZodValidationPipe(Schema))`.
 *
 * The default failure is `BadRequestException(firstIssue.message)`, which the global exception
 * filter surfaces verbatim as the response `message`. A module whose rejection body is not a plain
 * 400 — a typed `code`, a different status — passes `mapError` and owns that mapping; the schema
 * still carries the message, so there is exactly one place per route that decides what a bad body
 * says.
 */
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodError, ZodType } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly mapError: (error: ZodError) => unknown = (error) =>
      new BadRequestException(error.issues[0]?.message ?? 'Invalid request body'),
  ) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw this.mapError(result.error);
  }
}
