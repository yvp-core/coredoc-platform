import { describe, expect, it } from 'vitest';
import { aggregateLogRecords, parseOtlpLogRecords, parseOtlpMetrics } from './otlp-parser.js';

/** Every record aggregated, no watermark filtering. */
const parseOtlpLogs = (body: unknown) => parseOtlpLogRecords(body).map((entry) => aggregateLogRecords(entry, -1n));

const attr = (key: string, value: string | number | boolean) => ({
  key,
  value:
    typeof value === 'string'
      ? { stringValue: value }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : { intValue: String(value) },
});

function logs(records: unknown[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('session.id', 'session-1'), attr('user.email', 'dev@example.com')] },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

describe('parseOtlpMetrics', () => {
  it('extracts cumulative native metrics', () => {
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [attr('session.id', 'session-1')] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: { dataPoints: [{ asInt: '12', attributes: [attr('type', 'input')] }] },
                },
                { name: 'claude_code.active_time.total', sum: { dataPoints: [{ asDouble: 3.5 }] } },
              ],
            },
          ],
        },
      ],
    };

    expect(parseOtlpMetrics(body)[0]).toMatchObject({
      provider: 'claude-code',
      sessionId: 'session-1',
      tokensInput: 12,
      activeTimeSec: 3.5,
    });
  });
});

describe('parseOtlpLogs', () => {
  it('counts native API usage and Coredoc MCP results', () => {
    const [delta] = parseOtlpLogs(
      logs([
        {
          timeUnixNano: '100',
          body: { stringValue: 'claude_code.api_request' },
          attributes: [attr('input_tokens', 50), attr('output_tokens', 10), attr('cost_usd', 1)],
        },
        {
          timeUnixNano: '200',
          body: { stringValue: 'claude_code.tool_result' },
          attributes: [
            attr('tool_name', 'mcp__coredoc__search_symbols'),
            attr('success', true),
            attr('duration_ms', 20),
          ],
        },
      ]),
    );

    expect(delta).toMatchObject({
      tokensInput: 50,
      tokensOutput: 10,
      costUsd: 1,
      coredocToolCalls: 1,
      countedEvents: 2,
      maxEventNanos: 200n,
    });
    expect(delta.coredocTools).toEqual({ search_symbols: 1 });
    expect(delta.coredocToolStats.search_symbols).toEqual({ calls: 1, errors: 0, totalDurationMs: 20 });
  });

  it('filters replayed records at the stored watermark', () => {
    const [entry] = parseOtlpLogRecords(
      logs([
        { timeUnixNano: '100', body: { stringValue: 'api_request' }, attributes: [attr('input_tokens', 5)] },
        { timeUnixNano: '200', body: { stringValue: 'api_request' }, attributes: [attr('input_tokens', 7)] },
      ]),
    );
    expect(aggregateLogRecords(entry, 100n)).toMatchObject({ tokensInput: 7, countedEvents: 1 });
  });

  it('does not project retired SpecFlow, SDLC, or workflow compatibility events', () => {
    const [delta] = parseOtlpLogs(
      logs([
        {
          timeUnixNano: '100',
          body: { stringValue: 'specflow.skill_used' },
          attributes: [attr('spec.id', 'SF-1'), attr('skill.name', 'specflow-tdd')],
        },
        {
          timeUnixNano: '200',
          body: { stringValue: 'coredoc-sdlc.run_opened' },
          attributes: [attr('run.id', 'cdr-20260818-abcdef')],
        },
        {
          timeUnixNano: '300',
          body: { stringValue: 'coredoc-workflows.workflow_finished' },
          attributes: [attr('run.id', 'cdr-20260818-abcdef')],
        },
      ]),
    );

    expect(delta.countedEvents).toBe(0);
    expect(delta.skillsUsed).toEqual({});
    expect(delta).not.toHaveProperty('specId');
    expect(delta).not.toHaveProperty('runId');
    expect(delta).not.toHaveProperty('workflowSummary');
    expect(delta).not.toHaveProperty('flowRecords');
  });

  it('rejects ambiguous provider identity', () => {
    const body = logs([]);
    body.resourceLogs[0].resource.attributes.push(attr('conversation.id', 'codex-1'));
    expect(parseOtlpLogs(body)).toEqual([]);
  });
});
