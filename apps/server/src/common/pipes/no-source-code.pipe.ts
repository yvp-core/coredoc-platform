/**
 * NestJS pipe that rejects any request body containing a `sourceCode` field
 * anywhere in its structure. Applied to push endpoints whose bodies are bare
 * `ParsedRepo` or polymorphic unions that cannot be expressed as a single
 * request schema.
 *
 * This pipe and the `noSourceCode()` schema refinement share the same predicate
 * (`containsSourceCode` from `@coredoc/db`) and the same message constant, so
 * client and server agree on what counts as a violation.
 */
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { containsSourceCode } from '@coredoc/db';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { NO_SOURCE_CODE_MESSAGE } from '../validators/no-source-code.validator.js';

@Injectable()
export class NoSourceCodePipe implements PipeTransform {
  transform(value: unknown): unknown {
    // Default fail-closed: reject source on the wire. On-prem operators opt in via
    // ALLOW_SOURCES_IN_GRAPH to accept and store it (they own the infrastructure).
    if (!allowSourcesInGraph() && containsSourceCode(value)) {
      throw new BadRequestException(NO_SOURCE_CODE_MESSAGE);
    }
    return value;
  }
}
