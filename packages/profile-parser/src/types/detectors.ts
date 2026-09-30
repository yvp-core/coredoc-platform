// ─────────────────────────────────────────────────────────────────────────────
// Detectors — how the engine recognizes a construct
// ─────────────────────────────────────────────────────────────────────────────

export type Detector =
  | { via: 'class-decorator'; name: string }
  | { via: 'method-decorator'; names: Record<string, string> }
  | { via: 'property-decorator'; names: string[] }
  | {
      via: 'call-shape';
      /** Callee text or glob, e.g. 'sequelize.define', 'initHandler', 'router.*'. */
      callee: string;
      /** Optional nesting scope: only match inside a parent call's callback. */
      scopedBy?: { callee: string; basePathArg: number };
    };

// ─────────────────────────────────────────────────────────────────────────────
// Argument extraction references — how the engine reads a value out of an arg
// ─────────────────────────────────────────────────────────────────────────────

export type ArgRef =
  | { arg: number; as: 'string-literal' }
  /** Resolve an identifier to its string-literal const declaration. */
  | { arg: number; as: 'const-string' }
  /** `() => Companies` → "Companies". */
  | { arg: number; as: 'arrow-target' }
  /** A bare identifier argument → its text. */
  | { arg: number; as: 'identifier' }
  /** Read a property out of an object-literal argument: `@Tool({ name: 'x' })` with key 'name' → "x". */
  | { arg: number; as: 'object-property'; key: string }
  /**
   * Unwrap a wrapper call and resolve the inner enum member reference.
   * Handles: topicFor(Topics.X), topicForCdc(Topics.X)
   *
   * Resolution:
   *  1. Detect that arg is a call to one of `unwrapCalls`
   *  2. Take first arg of that call
   *  3. If that arg is `Enum.MEMBER`, return the qualified reference as the stable key
   *     e.g. "Topics.EntityUpdatedV1"
   *
   * The resolved key is the enum member reference, NOT the string value —
   * it matches identically on publisher and consumer sides without needing the
   * enum's cross-package values.
   */
  | {
      arg: number;
      as: 'wrapped-enum-member';
      /** Wrapper function names to unwrap, e.g. ['topicFor','topicForCdc'] */
      unwrapCalls: string[];
    };
