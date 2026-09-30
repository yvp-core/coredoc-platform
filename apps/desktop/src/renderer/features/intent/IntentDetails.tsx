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
} from './intent-presentation';
import type { ContextCondition, TreeCondition } from '../../../shared/intent-types.js';

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
    <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      {inheritedGroups.length > 0 && (
        <ul className="flex flex-col gap-1 text-[11px] leading-4 text-content-secondary">
          {inheritedGroups.map((group) => (
            <li key={group.source} className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-[0.03em] text-content-tertiary">Inherited</span>
              <ul className="flex flex-col gap-0.5 pl-2.5">
                {group.clauses.map((clause) => (
                  <li key={JSON.stringify(clause)} className="flex flex-wrap items-baseline gap-1.5">
                    <span>{contextConditionText(clause)}</span>
                    <span className="text-[10px] text-content-tertiary">
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
        <ul className="flex flex-col gap-0.5 text-[11px] leading-4 text-content-secondary">
          {appliesWhen.map((clause) => (
            <li key={JSON.stringify(clause)} className="flex flex-wrap items-baseline gap-1.5">
              <span>{contextConditionText(clause)}</span>
              {isUnevaluatedCondition(clause) && (
                <span className="text-[10px] uppercase tracking-[0.03em] text-content-tertiary">
                  not machine-evaluated
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {variants !== null && (
        <table className="w-full text-left text-[11px] leading-4">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.03em] text-content-tertiary">
              <th className="pb-1 pr-2 font-normal">When</th>
              <th className="pb-1 pr-2 font-normal">Outcome</th>
              <th className="pb-1 font-normal">Inputs</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant, index) => (
              <tr key={index} className="border-t border-border-input align-top">
                <td className="py-1 pr-2 text-content-secondary">{variantWhenCell(variant)}</td>
                <td className="py-1 pr-2 text-content-primary">{variant.outcome}</td>
                <td className="py-1 text-content-tertiary">{variant.inputs?.join(', ') ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {fields.length > 0 && (
        <dl className="flex flex-col gap-1.5">
          {fields.map((field) => (
            <div key={field.key} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
              <dt className="text-[11px] leading-4 text-content-tertiary">{field.label}</dt>
              <dd className="text-[11px] leading-4 text-content-primary">
                {field.values ? (
                  <ul className="flex flex-col gap-0.5">
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
        <ol className="mt-2 flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step.id} className="flex gap-2">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-bg-tertiary font-mono text-[10px] text-content-secondary">
                {index + 1}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                {step.actor && (
                  <span className="text-[11px] font-medium leading-4 text-content-secondary">{step.actor}</span>
                )}
                <span className="text-[11px] leading-4 text-content-primary">
                  {step.action ?? step.id}
                  {step.outcome ? ` → ${step.outcome}` : ''}
                </span>
                {step.branches.map((branch) => (
                  <span
                    key={`${branch.condition}\n${branch.toStepId}`}
                    className="text-[11px] leading-4 text-content-tertiary"
                  >
                    if {branch.condition} → step {branch.toStepId}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}

      {rawPayload && (
        <pre className="whitespace-pre-wrap break-all rounded-md bg-bg-input p-2 font-mono text-[11px] leading-4 text-content-secondary">
          {rawPayload}
        </pre>
      )}
    </div>
  );
}
