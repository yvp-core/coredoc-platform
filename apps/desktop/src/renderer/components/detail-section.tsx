import type { ReactNode } from 'react';
import type { NodeDetailData } from '@coredoc/core';

/**
 * Shared node-detail renderer, extracted from the explorer drawer (Task 7)
 * so both the light explorer and the dark C4 drawer can render the same
 * type-specific detail (entrypoint method/path, function purpose + business
 * logic, entity columns/relations, class fields, interface/enum members…)
 * without duplicating the switch. Sections follow the drawer's text-section
 * recipe: quaternary label over secondary body, no rules between rows.
 */
export function LoadingDetail() {
  return <div className="px-5 pt-2.5 text-xs leading-4 font-semibold text-content-quaternary">Loading details…</div>;
}

/** A labeled key/value row. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs leading-4 font-semibold text-content-quaternary">{label}:</dt>
      <dd className="text-sm leading-5 break-words text-content-secondary">{children}</dd>
    </div>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col gap-2.5 px-5 pt-2.5">{children}</dl>;
}

/** Type-specific detail, dispatched on the discriminated `detail.kind`. */
export function DetailSection({ detail }: { detail: NodeDetailData }) {
  switch (detail.kind) {
    case 'entrypoint':
      return (
        <Section>
          {detail.method ? <Row label="Method">{detail.method}</Row> : null}
          {detail.entrypointType ? <Row label="Protocol">{detail.entrypointType}</Row> : null}
          {detail.fullPath || detail.path ? (
            <Row label="Path">
              <span className="font-mono text-xs leading-4">{detail.fullPath || detail.path}</span>
            </Row>
          ) : null}
          {detail.schedule ? <Row label="Schedule">{detail.schedule}</Row> : null}
          {detail.topic ? <Row label="Topic">{detail.topic}</Row> : null}
          {detail.fieldName ? <Row label="Field">{detail.fieldName}</Row> : null}
          {detail.operationType ? <Row label="Operation">{detail.operationType}</Row> : null}
          {detail.purpose ? <Row label="Purpose">{detail.purpose}</Row> : null}
        </Section>
      );

    case 'function':
      return (
        <Section>
          {detail.purpose ? <Row label="Purpose">{detail.purpose}</Row> : null}
          {detail.businessLogic ? (
            <Row label="Business logic">
              <span className="whitespace-pre-wrap leading-snug">{detail.businessLogic}</span>
            </Row>
          ) : null}
          {detail.sideEffects ? (
            <Row label="Side effects">
              <span className="whitespace-pre-wrap leading-snug">{detail.sideEffects}</span>
            </Row>
          ) : null}
          {detail.visibility || detail.isAsync || detail.complexity != null ? (
            <Row label="Signature">
              {[
                detail.visibility,
                detail.isAsync ? 'async' : null,
                detail.complexity != null ? `complexity ${detail.complexity}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Row>
          ) : null}
        </Section>
      );

    case 'class':
      return (
        <Section>
          {detail.extendsName ? <Row label="Extends">{detail.extendsName}</Row> : null}
          {detail.implements?.length ? <Row label="Implements">{detail.implements.join(', ')}</Row> : null}
          {detail.fields.length ? (
            <Row label={`Fields (${detail.fields.length})`}>
              <MemberList
                items={detail.fields.map((f) => ({
                  name: f.name,
                  meta: [f.visibility, f.typeText].filter(Boolean).join(': '),
                }))}
              />
            </Row>
          ) : null}
          {detail.constructorParams?.length ? (
            <Row label="Constructor">
              <MemberList items={detail.constructorParams.map((c) => ({ name: c.name, meta: c.typeText }))} />
            </Row>
          ) : null}
        </Section>
      );

    case 'interface':
      return (
        <Section>
          {detail.members.length ? (
            <Row label={`Members (${detail.members.length})`}>
              <MemberList
                items={detail.members.map((m) => ({
                  name: m.name,
                  meta: [m.kind, m.returnTypeText ?? m.typeText].filter(Boolean).join(': '),
                }))}
              />
            </Row>
          ) : (
            <Row label="Members">—</Row>
          )}
        </Section>
      );

    case 'enum':
      return (
        <Section>
          <Row label={`Members (${detail.members.length})`}>
            <MemberList
              items={detail.members.map((m) => ({ name: m.name, meta: m.value != null ? String(m.value) : undefined }))}
            />
          </Row>
        </Section>
      );

    case 'entity':
      return (
        <Section>
          {detail.tableName ? (
            <Row label="Table">
              <span className="font-mono text-xs leading-4">{detail.tableName}</span>
              {detail.ormType ? <span className="ml-1 text-content-quaternary">({detail.ormType})</span> : null}
            </Row>
          ) : null}
          {detail.fields.length ? (
            <Row label={`Columns (${detail.fields.length})`}>
              <MemberList
                items={detail.fields.map((f) => ({
                  name: f.columnName || f.name,
                  meta: [
                    f.typeText,
                    f.isPrimaryKey ? 'PK' : null,
                    f.isUnique ? 'unique' : null,
                    f.isNullable ? 'null' : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
              />
            </Row>
          ) : null}
          {detail.relations.length ? (
            <Row label={`Relations (${detail.relations.length})`}>
              <MemberList
                items={detail.relations.map((r) => ({
                  name: r.name,
                  meta: [r.type, r.targetEntityName].filter(Boolean).join(' → '),
                }))}
              />
            </Row>
          ) : null}
          {detail.indexes?.length ? (
            <Row label={`Indexes (${detail.indexes.length})`}>
              <MemberList
                items={detail.indexes.map((i) => ({
                  name: i.name || i.columns.join(', '),
                  meta: i.isUnique ? 'unique' : undefined,
                }))}
              />
            </Row>
          ) : null}
        </Section>
      );

    case 'external_call':
      return (
        <Section>
          {detail.serviceName ? <Row label="Service">{detail.serviceName}</Row> : null}
          {detail.protocol ? <Row label="Protocol">{detail.protocol}</Row> : null}
          {detail.httpMethod || detail.method ? <Row label="Method">{detail.httpMethod || detail.method}</Row> : null}
          {detail.pathTemplate ? (
            <Row label="Path">
              <span className="font-mono text-xs leading-4">{detail.pathTemplate}</span>
            </Row>
          ) : null}
          {detail.messagingSystem ? <Row label="System">{detail.messagingSystem}</Row> : null}
          {detail.messagingDestination ? <Row label="Destination">{detail.messagingDestination}</Row> : null}
          {detail.ipcDirection ? <Row label="IPC direction">{detail.ipcDirection}</Row> : null}
        </Section>
      );

    default:
      return detail.documentation ? (
        <Section>
          <Row label="Docs">{detail.documentation}</Row>
        </Section>
      ) : null;
  }
}

/** A compact name · meta list for members/fields/columns. */
export function MemberList({ items }: { items: Array<{ name: string; meta?: string }> }) {
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5">
      {items.map((it) => (
        <li key={`${it.name}|${it.meta ?? ''}`} className="flex items-baseline gap-1.5">
          <span className="font-mono text-xs leading-4 text-content-secondary">{it.name}</span>
          {it.meta ? <span className="truncate text-xs leading-4 text-content-quaternary">{it.meta}</span> : null}
        </li>
      ))}
    </ul>
  );
}
