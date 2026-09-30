/**
 * The rejection shape the global class-validator `ValidationPipe` used to produce, kept for the
 * schemas that replaced the DTO classes (`.scratch/server-structure-cleanup/spec.md`, Track B3).
 *
 * class-validator emitted one message per failing field, in property-declaration order, each
 * naming its own field and prefixed by the parent path when the field is nested
 * (`targets.0.parsedVersion must be …`). Nest carried them as a string array and
 * `GlobalExceptionFilter` joined them with '; '. A client matching on that message keeps
 * matching, so the schemas carry the same message text and this mapper does the same assembly —
 * zod's issue order is the shape-declaration order, which is the same order the decorators ran in.
 */
import { BadRequestException } from '@nestjs/common';
import type { ZodError } from 'zod';

export function dtoFieldMessages(error: ZodError): BadRequestException {
  return new BadRequestException(
    error.issues.map((issue) => {
      const parent = issue.path.slice(0, -1).join('.');
      return parent ? `${parent}.${issue.message}` : issue.message;
    }),
  );
}
