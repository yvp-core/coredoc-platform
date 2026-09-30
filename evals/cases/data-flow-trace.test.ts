import { describe, expect, it } from 'vitest';
import type { Target } from '../harness/types.js';
import {
  dataFlowTraceCase,
  responseNamesSink,
  sinkTokens,
  type DataFlowTraceParams,
} from './data-flow-trace.js';

const target = { name: 'acme-calculations' } as Target;
const params: DataFlowTraceParams = {
  path: 'Topics.DailySummaryRecalculateV2',
  field: 'event.createdAt',
  expectedSinks: ['ShiftSummary.status', 'ShiftSummary.processedAt', 'Temporal signalWithStart'],
};

const verifyResponse = (responseText: string) =>
  dataFlowTraceCase.verify(target, params, {
    responseText,
  } as Parameters<typeof dataFlowTraceCase.verify>[2]);

describe('sinkTokens', () => {
  it('splits dotted and multi-word composites into identifier tokens', () => {
    expect(sinkTokens('ShiftSummary.status')).toEqual(['shiftsummary', 'status']);
    expect(sinkTokens('Temporal signalWithStart')).toEqual(['temporal', 'signalwithstart']);
  });
});

describe('responseNamesSink', () => {
  it('requires every token, in any order and any separator', () => {
    expect(
      responseNamesSink(
        'the written value is `status = pending` on the `shiftsummary` row',
        'ShiftSummary.status',
      ),
    ).toBe(true);
  });

  it('rejects a response carrying only part of the composite', () => {
    expect(responseNamesSink('it signals the workflow via signalwithstart', 'Temporal signalWithStart')).toBe(
      false,
    );
    expect(responseNamesSink('nothing relevant here', 'ShiftSummary.status')).toBe(false);
  });
});

describe('dataFlowTraceCase.verify sink recall', () => {
  it('credits sinks phrased as separate words in prose', async () => {
    // Observed 2026-08-24: this shape of answer scored 0 because the verifier
    // looked for the literal substring `shiftsummary.status`.
    const result = await verifyResponse(
      'The handler updates `ShiftSummary` rows: it sets `status = Pending` where ' +
        '`processedAt` is older than the event, then calls the Temporal client ' +
        '`signalWithStart` to schedule the workflow.',
    );

    expect(result.details.recall).toBe(1);
    expect(result.score).toBe(100);
  });

  it('scores 0 when the response names none of the sinks', async () => {
    const result = await verifyResponse('The field is validated and discarded.');

    expect(result.details.recall).toBe(0);
    expect(result.score).toBe(0);
  });

  it('does not credit a sink whose tokens are only half present', async () => {
    const result = await verifyResponse(
      'It writes `ShiftSummary` rows and updates `processedAt`; no workflow is signalled.',
    );

    expect(result.details.recall).toBeCloseTo(1 / 3, 5);
  });
});
