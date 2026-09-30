import { describe, expect, it } from 'vitest';
import { extractRubyQueue } from './ruby-queue.js';

/**
 * B5 — Karafka queue ENTRYPOINTS (Rails as a Kafka consumer). Generic Karafka routing
 * DSL only (no client topics/classes). A `topic <name> do … consumer <Class> … end` block
 * inside `routes.draw` declares a consumed topic; the enclosing `consumer_group` (if any)
 * is captured. Topic names may be symbols or strings. NOTE: no demo repo uses Karafka, so
 * this is exercised by synthetic fixtures (the same way egress supports HTTParty/Net::HTTP
 * that sample-web doesn't use) — ready for when a Kafka-consuming Rails repo is onboarded.
 */
describe('extractRubyQueue', () => {
  it('extracts a topic→consumer routing entry (symbol topic)', async () => {
    const out = await extractRubyQueue(`
class KarafkaApp < Karafka::App
  routes.draw do
    topic :orders do
      consumer OrdersConsumer
    end
  end
end
`);
    expect(out).toContainEqual(expect.objectContaining({ topic: 'orders', consumerClass: 'OrdersConsumer' }));
  });

  it('handles a string topic name and an enclosing consumer_group', async () => {
    const out = await extractRubyQueue(`
routes.draw do
  consumer_group :payments_group do
    topic 'payments.created.v1' do
      consumer PaymentsConsumer
    end
  end
end
`);
    expect(out).toContainEqual(
      expect.objectContaining({
        topic: 'payments.created.v1',
        consumerClass: 'PaymentsConsumer',
        consumerGroup: 'payments_group',
      }),
    );
  });

  it('resolves a namespaced consumer constant', async () => {
    const out = await extractRubyQueue(`
routes.draw do
  topic :bookings do
    consumer Consumers::BookingsConsumer
  end
end
`);
    expect(out[0]?.consumerClass).toBe('Consumers::BookingsConsumer');
  });

  it('ignores a topic block that has no consumer (not a Karafka route)', async () => {
    const out = await extractRubyQueue(`
config do
  topic :something do
    setting true
  end
end
`);
    expect(out).toEqual([]);
  });

  it('returns [] for a repo with no Karafka routing', async () => {
    expect(await extractRubyQueue('class Foo\n  def bar; 1; end\nend\n')).toEqual([]);
  });

  // Self-review #6: the consumer class is the positional arg, not a constant inside an option.
  it('picks the positional consumer class, not a constant in an option', async () => {
    const out = await extractRubyQueue(`
routes.draw do
  topic :orders do
    consumer OrdersConsumer, dead_letter_queue: Topics::Dlq
  end
end
`);
    expect(out[0]?.consumerClass).toBe('OrdersConsumer');
  });
});
