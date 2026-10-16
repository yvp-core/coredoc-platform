/** The hand-off prompt behind "Needs a fix" / "Answer with an agent" (`item-ask-agent.tsx`). */

import { IntentAuthority, type IntentContextMatch } from './types.js';

export function isOpenQuestion(match: IntentContextMatch): boolean {
  return (match.payload as { choiceStatus?: string } | null)?.choiceStatus === 'open';
}

export function agentPrompt(match: IntentContextMatch, note: string): string {
  const where = match.featureId
    ? `feature ${match.featureId}`
    : match.domainId
      ? `domain ${match.domainId}`
      : 'the product root';
  const lines = [
    `Coredoc product intent, item ${match.id} (${match.kind}, ${match.authority}, v${match.version}) in ${where}.`,
    `Current text: ${match.statement}`,
    '',
  ];
  // An accepted item is never edited: the agent proposes a successor that names it. A candidate is
  // the proposal itself, and propose updates it in place when the call carries its exact id, so the
  // prompt asks for that: a second candidate beside the first would leave both for the reviewer, and
  // `proposedSuccessorOfId` is refused for anything that is not accepted.
  const accepted = match.authority === IntentAuthority.Accepted;
  if (isOpenQuestion(match)) {
    lines.push(`This is an open question. Answer: ${note.trim()}`, '');
    lines.push(
      accepted
        ? `Read the node with intent_read {action: "node"} for context. Then propose a successor decision with intent_propose: same id prefix, proposedSuccessorOfId "${match.id}", payload.choiceStatus "proposed" and payload.choice set to the answer. If the answer changes behaviour, also propose the resulting business rule.`
        : `Read the node with intent_read {action: "node"} for context. This question is still a candidate: update it in place with intent_propose using id "${match.id}" and the whole payload again (question, rationale, alternatives, consequences) with payload.choiceStatus "proposed" and payload.choice set to the answer; a field you leave out keeps its stored value. Do not set proposedSuccessorOfId and do not propose a second decision. If the answer changes behaviour, also propose the resulting business rule.`,
    );
  } else {
    lines.push(`Requested change: ${note.trim()}`, '');
    lines.push(
      accepted
        ? `Read the node with intent_read {action: "node"} for context. Then propose a corrected successor with intent_propose (proposedSuccessorOfId "${match.id}"), keeping what the request does not mention.`
        : `Read the node with intent_read {action: "node"} for context. This item is still a candidate: update it in place with intent_propose using id "${match.id}" and the corrected title and statement; a field you leave out keeps its stored value, and a payload or body you send replaces the stored one whole. Do not set proposedSuccessorOfId and do not propose a second item.`,
    );
  }
  lines.push('Do not accept anything; a person reviews the proposal in Coredoc.');
  return lines.join('\n');
}
