/**
 * Karafka queue ENTRYPOINT extraction — a Ruby/Rails app as a Kafka CONSUMER.
 * Generic Karafka routing DSL only; NO client topics or consumer class names.
 *
 * Karafka declares consumed topics in a routing block:
 *
 *   routes.draw do
 *     consumer_group :group do          # optional grouping
 *       topic :orders do                # symbol OR string topic name
 *         consumer OrdersConsumer       # the handler class (may be namespaced)
 *       end
 *     end
 *   end
 *
 * We match each `topic <name> do … consumer <Const> … end` block (the presence of a
 * `consumer` call disambiguates a Karafka route from any other `topic` usage), and capture
 * the topic name, the consumer class, and the enclosing `consumer_group` if present. The
 * topic is the cross-repo key — a publisher egress with the same topic resolves to it.
 */
import {
  type TsNode,
  collectCalls,
  firstArg,
  isCall,
  isNestedOption,
  methodName,
  ownBlock,
  withParsedRuby,
} from './ruby-cst.js';

export interface RubyQueueEntrypoint {
  topic: string;
  consumerClass?: string;
  consumerGroup?: string;
  line: number;
}

/**
 * The POSITIONAL constant/scope_resolution class ref of a call: `consumer A::B` → "A::B".
 * Excludes constants inside an option hash (`consumer X, dlq: Topics::Dlq` → "X", not the
 * option) and inside the call's own block. The earliest qualifying node wins; at an equal
 * start a `scope_resolution` (`A::B`) is preferred over its inner `constant` (`A`).
 */
function firstConstantArg(call: TsNode): string | undefined {
  const block = ownBlock(call);
  const blockStart = block ? block.startIndex : Number.POSITIVE_INFINITY;
  const candidates: Array<{ start: number; rank: number; text: string }> = [];
  // rank 0 = scope_resolution (wins ties against its inner constant at the same start).
  for (const n of call.descendantsOfType('scope_resolution') as TsNode[]) {
    if (n.startIndex >= blockStart || isNestedOption(n, call)) continue;
    candidates.push({ start: n.startIndex, rank: 0, text: n.text as string });
  }
  for (const n of call.descendantsOfType('constant') as TsNode[]) {
    if (n.startIndex >= blockStart || isNestedOption(n, call)) continue;
    candidates.push({ start: n.startIndex, rank: 1, text: n.text as string });
  }
  candidates.sort((a, b) => a.start - b.start || a.rank - b.rank);
  return candidates[0]?.text;
}

/** The name arg of the nearest enclosing `consumer_group <name> do` call, if any. */
function enclosingConsumerGroup(node: TsNode): string | undefined {
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (isCall(cur) && methodName(cur) === 'consumer_group') return firstArg(cur)?.value;
    cur = cur.parent;
  }
  return undefined;
}

export function rubyQueueFromRoot(root: TsNode): RubyQueueEntrypoint[] {
  const out: RubyQueueEntrypoint[] = [];
  for (const call of collectCalls(root)) {
    if (methodName(call) !== 'topic') continue;
    const block = ownBlock(call);
    if (!block) continue; // a routing entry is a `topic … do … end` block
    const name = firstArg(call);
    if (!name) continue;

    // The block must contain a `consumer <Const>` call — that both names the handler and
    // disambiguates a Karafka route from any unrelated `topic` block.
    let consumerClass: string | undefined;
    for (const inner of collectCalls(block)) {
      if (methodName(inner) === 'consumer') {
        const c = firstConstantArg(inner);
        if (c) {
          consumerClass = c;
          break;
        }
      }
    }
    if (!consumerClass) continue;

    out.push({
      topic: name.value,
      consumerClass,
      consumerGroup: enclosingConsumerGroup(call),
      line: call.startPosition.row + 1,
    });
  }
  return out;
}

export async function extractRubyQueue(source: string): Promise<RubyQueueEntrypoint[]> {
  return withParsedRuby(source, (root) => rubyQueueFromRoot(root));
}
