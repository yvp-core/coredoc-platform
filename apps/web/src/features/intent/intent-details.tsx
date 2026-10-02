import {
  contextConditionText,
  formatPayload,
  inheritedConditionGroups,
  inheritedConditionSourceLabel,
  intentDetailFields,
  intentFlowSteps,
  intentPayloadVariants,
  isUnevaluatedCondition,
  variantWhenCell,
} from './intent-presentation.js';
import type { ContextCondition, TreeCondition } from './types.js';

/** `appliesWhen` is item-level, not part of the payload (ADR-1), so it is a sibling prop. */
export function IntentDetails({
  payload,
  appliesWhen,
  inheritedConditions,
  domainId,
  featureId,
}: {
  payload: unknown;
  appliesWhen?: ContextCondition[];
  inheritedConditions?: { domain?: TreeCondition[]; feature?: TreeCondition[] };
  domainId?: string | null;
  featureId?: string | null;
}) {
  const fields = intentDetailFields(payload);
  const steps = intentFlowSteps(payload);
  const variants = intentPayloadVariants(payload);
  const rawPayload = fields.length === 0 && steps === null && variants === null ? formatPayload(payload) : null;
  const inheritedGroups = inheritedConditionGroups(inheritedConditions);
  return (
    <div className="min-w-0 space-y-2 break-words">
      {inheritedGroups.length > 0 && (
        <ul className="space-y-1 text-[13px] text-ink-2">
          {inheritedGroups.map((group) => (
            <li key={group.source} className="space-y-0.5">
              <span className="text-[11.5px] uppercase tracking-[0.03em] text-ink-4">Inherited</span>
              <ul className="space-y-0.5 pl-2.5">
                {group.clauses.map((clause) => (
                  <li key={JSON.stringify(clause)} className="flex flex-wrap items-baseline gap-1.5">
                    <span>{contextConditionText(clause)}</span>
                    <span className="text-[11.5px] text-ink-4">
                      {inheritedConditionSourceLabel(group, domainId, featureId)}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {appliesWhen && appliesWhen.length > 0 && (
        <ul className="space-y-0.5 text-[13px] text-ink-2">
          {appliesWhen.map((clause) => (
            <li key={JSON.stringify(clause)} className="flex items-baseline gap-1.5">
              <span>{contextConditionText(clause)}</span>
              {isUnevaluatedCondition(clause) && (
                <span className="text-[11.5px] uppercase tracking-[0.03em] text-ink-4">not machine-evaluated</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {variants !== null && (
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-[11.5px] uppercase tracking-[0.03em] text-ink-4">
              <th className="pb-1 pr-2 font-normal">When</th>
              <th className="pb-1 pr-2 font-normal">Outcome</th>
              <th className="pb-1 font-normal">Inputs</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant, index) => (
              <tr key={index} className="border-t border-border-soft align-top">
                <td className="py-1 pr-2 text-ink-2">{variantWhenCell(variant)}</td>
                <td className="py-1 pr-2 text-ink-1">{variant.outcome}</td>
                <td className="py-1 text-ink-3">{variant.inputs?.join(', ') ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {fields.length > 0 && (
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[13.5px]">
          {fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className="pt-px text-[12.5px] text-ink-4">{field.label}</dt>
              <dd className="text-ink-1">
                {field.values ? (
                  <ul className="list-disc pl-4">
                    {field.values.map((value) => (
                      <li key={value}>{value}</li>
                    ))}
                  </ul>
                ) : (
                  field.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {steps !== null && (
        <ol className="mt-2">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className="relative border-b border-dashed border-border-soft py-[5px] pl-[30px] text-[13.5px] last:border-b-0"
            >
              <span className="absolute left-0 top-1.5 flex size-5 items-center justify-center rounded-full bg-brand-wash text-[11.5px] font-medium text-brand-text">
                {index + 1}
              </span>
              <span className="text-ink-1">
                {step.actor && <span className="font-medium">{step.actor} </span>}
                {step.action ?? step.id}
                {step.outcome ? ` → ${step.outcome}` : ''}
              </span>
              {step.branches.map((branch) => (
                <span key={`${branch.condition}\n${branch.toStepId}`} className="mt-0.5 block text-[12px] text-ink-3">
                  if {branch.condition} → step “{branch.toStepId}”
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}

      {rawPayload && (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-2 font-mono text-[12px] leading-4 text-ink-2">
          {rawPayload}
        </pre>
      )}
    </div>
  );
}
