import { describe, expect, it } from 'vitest';
import type { ArgRef } from '../types.js';
import { resolveQueueTopic, resolveQueueTopicReference } from './scip/url-topic-helpers.js';

const noConst = () => undefined;

describe('resolveQueueTopic', () => {
  it('reads a bare string-literal topic (kafkajs/microservices client.emit("x"))', () => {
    const ref: ArgRef = { arg: 0, as: 'string-literal' };
    expect(resolveQueueTopic("'user.created'", ref, noConst)).toBe('user.created');
    expect(resolveQueueTopic('`shifts.sync`', ref, noConst)).toBe('shifts.sync');
  });

  it('resolves a const-ref topic via the const resolver (emit(Topics.USER_CREATED, …))', () => {
    const ref: ArgRef = { arg: 0, as: 'const-string' };
    const resolve = (ident: string) => (ident === 'Topics.USER_CREATED' ? 'user.created' : undefined);
    expect(resolveQueueTopic('Topics.USER_CREATED', ref, resolve)).toBe('user.created');
  });

  it('reads an object-property topic (nestjs emit({ pattern: "x" }) / kafkajs send({ topic: "x" }))', () => {
    const pattern: ArgRef = { arg: 0, as: 'object-property', key: 'pattern' };
    expect(resolveQueueTopic("{ pattern: 'order.paid', data }", pattern, noConst)).toBe('order.paid');
    const topic: ArgRef = { arg: 0, as: 'object-property', key: 'topic' };
    expect(resolveQueueTopic('{ topic: "billing.charge", messages: [] }', topic, noConst)).toBe('billing.charge');
  });

  it('resolves a const-string dotted-member topic (emit(Topics.ShiftsUpdatedV2, …))', () => {
    const ref: ArgRef = { arg: 0, as: 'const-string' };
    // Simulate a callback that handles dotted refs (as the substrate does via resolveConstMember).
    const resolve = (r: string) => (r === 'Topics.ShiftsUpdatedV2' ? 'shifts.updated.v2' : undefined);
    expect(resolveQueueTopic('Topics.ShiftsUpdatedV2', ref, resolve)).toBe('shifts.updated.v2');
    expect(resolveQueueTopicReference('Topics.ShiftsUpdatedV2', ref, resolve)).toEqual({
      topic: 'Topics.ShiftsUpdatedV2',
      topicValue: 'shifts.updated.v2',
    });
  });

  it('returns undefined when const-string callback cannot resolve dotted member (edge dropped)', () => {
    const ref: ArgRef = { arg: 0, as: 'const-string' };
    expect(resolveQueueTopic('Topics.UnknownEvent', ref, noConst)).toBeUndefined();
  });

  it('returns undefined for a non-literal, unresolvable topic (no empty-string topic)', () => {
    const ref: ArgRef = { arg: 0, as: 'string-literal' };
    expect(resolveQueueTopic('dynamicTopic', ref, noConst)).toBeUndefined();
    expect(resolveQueueTopic('', ref, noConst)).toBeUndefined();
    expect(resolveQueueTopic(undefined, ref, noConst)).toBeUndefined();
  });

  describe('identifier (temporal workflow-start destinations)', () => {
    const ref: ArgRef = { arg: 0, as: 'identifier' };

    it('takes a bare identifier as the destination key (workflow.start(workflowFn, …))', () => {
      expect(resolveQueueTopicReference('calculateHoursBankBasedOnSignalWf', ref, noConst)).toEqual({
        topic: 'calculateHoursBankBasedOnSignalWf',
      });
    });

    it('attaches the resolved value when the identifier is a string const', () => {
      const resolve = (ident: string) => (ident === 'TOPIC' ? 'user.created' : undefined);
      expect(resolveQueueTopicReference('TOPIC', ref, resolve)).toEqual({ topic: 'TOPIC', topicValue: 'user.created' });
    });

    it('refuses member expressions and calls — bare identifiers only', () => {
      expect(resolveQueueTopicReference('this.workflows.calc', ref, noConst)).toBeUndefined();
      expect(resolveQueueTopicReference('pick()', ref, noConst)).toBeUndefined();
      expect(resolveQueueTopicReference("'literal'", ref, noConst)).toBeUndefined();
    });
  });

  describe('wrapped-enum-member (getTopicInNamespace / getTopicInCdcNamespace)', () => {
    const ref: ArgRef = {
      arg: 0,
      as: 'wrapped-enum-member',
      unwrapCalls: ['getTopicInNamespace', 'getTopicInCdcNamespace'],
    };

    it('extracts the enum member reference from getTopicInNamespace(Topics.X)', () => {
      expect(resolveQueueTopic('getTopicInNamespace(Topics.ShiftsUpdatedV2)', ref, noConst)).toBe(
        'Topics.ShiftsUpdatedV2',
      );
    });

    it('preserves the wrapped member token and attaches its resolved runtime value', () => {
      const resolve = (r: string) => (r === 'Topics.ShiftsUpdatedV2' ? 'shifts.updated.v2' : undefined);
      expect(resolveQueueTopicReference('getTopicInNamespace(Topics.ShiftsUpdatedV2)', ref, resolve)).toEqual({
        topic: 'Topics.ShiftsUpdatedV2',
        topicValue: 'shifts.updated.v2',
      });
    });

    it('extracts from getTopicInCdcNamespace(Topics.CdcWebPermissionRolesUserProfiles)', () => {
      expect(resolveQueueTopic('getTopicInCdcNamespace(Topics.CdcWebPermissionRolesUserProfiles)', ref, noConst)).toBe(
        'Topics.CdcWebPermissionRolesUserProfiles',
      );
    });

    it('returns undefined for a dynamic inner arg (e.g. getTopicInNamespace(someVar) — no dot)', () => {
      // Risk 3 from the design doc: dynamic topic variable, not a qualified member
      expect(resolveQueueTopic('getTopicInNamespace(topic)', ref, noConst)).toBeUndefined();
    });

    it('returns undefined when the arg is not a recognized wrapper call', () => {
      expect(resolveQueueTopic('unknownWrapper(Topics.X)', ref, noConst)).toBeUndefined();
    });

    it('returns undefined for a bare string-literal arg (not a wrapped call)', () => {
      expect(resolveQueueTopic("'schedules.evt.shifts.updated.v2'", ref, noConst)).toBeUndefined();
    });

    it('returns undefined when rawArg is undefined or empty', () => {
      expect(resolveQueueTopic(undefined, ref, noConst)).toBeUndefined();
      expect(resolveQueueTopic('', ref, noConst)).toBeUndefined();
    });
  });
});
