/**
 * Python `class_definition` → `ClassNode` (audit gap G1).
 *
 * Every method the call-graph lane emits already carries `classId =
 * idGen.classId(relPath, <enclosing class chain>)`, but no class node was ever emitted — so on a
 * Django repo tens of thousands of methods pointed at phantom classes and `explain`/
 * `list-file-symbols` returned nothing class-side. This lane closes that hole by minting the node
 * the ids already reference; the id is derived the SAME way (`pythonClassChain` + own name), so
 * `class.id === method.classId` by construction, not by coincidence.
 *
 * BASE CLASSES are captured VERBATIM (`class X(UUIDModel, mixins.Named)` → 'UUIDModel',
 * 'mixins.Named'), unresolved. `ClassNode` models single inheritance (`extends`) plus a list
 * (`implements`), so Python's MRO is mapped first-base → `extends`, remaining bases →
 * `implements`. Both round-trip to the graph store today (`extendsName` / `implements`), which a
 * new bespoke field would not — and the consumer that needs them (Django base transitivity, G3)
 * only needs the NAMES.
 */
import type { ClassNode, DecoratorInfo, StableIdGenerator, TypeReference } from '@coredoc/core';
import type { PythonDefIndex } from './python-callgraph.js';
import {
  CLASS_DEF,
  type PythonFile,
  type TsNode,
  baseNames,
  decoratorName,
  decoratorsOf,
  defName,
  pythonClassChain,
} from './python-cst.js';

/** Bases that mark a class as abstract in stdlib terms (`abc`), matched by dotted suffix. */
const ABC_BASES = new Set(['ABC', 'abc.ABC']);

/** `class X(metaclass=ABCMeta)` — the keyword arg the superclass list carries. */
function hasAbcMetaclass(classNode: TsNode): boolean {
  const supers = classNode.childForFieldName?.('superclasses');
  if (!supers) return false;
  for (let i = 0; i < supers.childCount; i++) {
    const c = supers.child(i);
    if (c?.type !== 'keyword_argument') continue;
    if ((c.childForFieldName?.('name')?.text as string | undefined) !== 'metaclass') continue;
    const v = (c.childForFieldName?.('value')?.text ?? '') as string;
    if (v === 'ABCMeta' || v.endsWith('.ABCMeta')) return true;
  }
  return false;
}

/** The decorators on a class as `DecoratorInfo`s (`@dataclass(frozen=True)`). */
function classDecorators(classNode: TsNode): DecoratorInfo[] | undefined {
  const decs = decoratorsOf(classNode);
  if (decs.length === 0) return undefined;
  return decs.map((d) => ({ name: decoratorName(d), expression: (d.text as string).replace(/^@/, '') }));
}

/**
 * The file-qualified class key used by the def index (`${relPath}#${chain}`), for the class's OWN
 * chain — i.e. including its own name, since a method's chain is its enclosing classes.
 */
function classKey(relPath: string, classNode: TsNode, name: string): string {
  return `${relPath}#${[...pythonClassChain(classNode), name].join('.')}`;
}

/**
 * Emit one `ClassNode` per `class_definition` across `files`. `methods` are the DIRECT methods
 * from the def index (a closure nested inside a method is not a method of the class), so the
 * emitted ids are always real `FunctionNode`s. De-duped by id, first occurrence wins — the same
 * documented collapse the def index applies to redefinitions.
 */
export function extractPythonClasses(
  files: PythonFile[],
  index: PythonDefIndex,
  idGen: StableIdGenerator,
): ClassNode[] {
  const byId = new Map<string, ClassNode>();

  for (const { relPath, root } of files) {
    for (const classNode of root.descendantsOfType(CLASS_DEF) as TsNode[]) {
      const name = defName(classNode);
      if (!name) continue;
      const chain = [...pythonClassChain(classNode), name];
      const id = idGen.classId(relPath, chain.join('.'));
      if (byId.has(id)) continue;

      const bases = baseNames(classNode);
      const [first, ...rest] = bases;
      const methods = [...(index.methodsByClass.get(classKey(relPath, classNode, name))?.values() ?? [])];
      const source = classNode.text as string;
      const decorators = classDecorators(classNode);

      const node: ClassNode = {
        id,
        versionedId: idGen.versionedId(id, source),
        name,
        kind: 'class',
        fileId: idGen.fileId(relPath),
        // Python has no export gate — every module-level (and nested) name is importable, so the
        // honest answer is "yes" rather than a leading-underscore guess (`_Private` is a
        // convention, not a rule, and plenty of frameworks import such names).
        isExported: true,
        isAbstract: bases.some((b) => ABC_BASES.has(b)) || hasAbcMetaclass(classNode),
        ...(first ? { extends: { name: first } satisfies TypeReference } : {}),
        ...(rest.length > 0 ? { implements: rest.map((n) => ({ name: n })) } : {}),
        ...(decorators ? { decorators } : {}),
        methods,
        // Spelled out so TS doesn't pick up the implicit `Object.prototype.constructor` shape
        // (same reason as the TS structural path). Python's `__init__` is an ordinary method and
        // is already in `methods`.
        constructor: undefined,
        // Class-level assignments are modelled per-lane (entity FIELDS for ORM models); a generic
        // property lane would duplicate that with no consumer, so it stays empty here.
        properties: [],
        location: {
          filePath: relPath,
          startLine: classNode.startPosition.row + 1,
          endLine: classNode.endPosition.row + 1,
        },
      };
      byId.set(id, node);
    }
  }

  return [...byId.values()];
}
