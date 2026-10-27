/**
 * Is a decorated entity class an abstract base that owns no table? MikroORM's
 * `@Entity({ abstract: true })`, or the entity decorator on an `abstract class` (TypeORM): its
 * columns live on the concrete subclasses. A single-table-inheritance root is the exception,
 * since it owns the table its subclasses share: TypeORM `@TableInheritance(…)`, MikroORM
 * `discriminatorColumn`/`discriminatorMap`.
 *
 * `decorators` is the source text of the class's decorators. Shared by the engine and the
 * coverage scorer, so the scorer's denominator counts exactly the entities the engine emits.
 */
export function isAbstractEntityBase(decorators: string, classIsAbstract: boolean): boolean {
  if (/\bTableInheritance\s*\(|\bdiscriminator(?:Column|Map)\b/.test(decorators)) return false;
  return classIsAbstract || /\babstract\s*:\s*true\b/.test(decorators);
}
