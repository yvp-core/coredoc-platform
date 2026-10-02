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
  if (isOpenQuestion(match)) {
    lines.push(
      `This is an open question. Answer: ${note.trim()}`,
      '',
      `Read the node with intent_read {action: "node"} for context. Then propose a successor decision with intent_propose: same id prefix, proposedSuccessorOfId "${match.id}", payload.choiceStatus "proposed" and payload.choice set to the answer. If the answer changes behaviour, also propose the resulting business rule.`,
    );
  } else {
    lines.push(`Requested change: ${note.trim()}`, '');
    lines.push(
      match.authority === IntentAuthority.Accepted
        ? `Read the node with intent_read {action: "node"} for context. Then propose a corrected successor with intent_propose (proposedSuccessorOfId "${match.id}"), keeping what the request does not mention.`
        : `Read the node with intent_read {action: "node"} for context. This item is still a candidate: propose a corrected candidate with intent_propose and say in its rationale that it replaces ${match.id}, so a reviewer can reject the old one.`,
    );
  }
  lines.push('Do not accept anything; a person reviews the proposal in Coredoc.');
  return lines.join('\n');
}
