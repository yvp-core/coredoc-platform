# Tree and condition rules

The `intent_tree` and `intent_propose` descriptions say how to call them and which refusals to
react to; the `request` parameter of `intent_tree` lists each action's body, and the
`intent_propose` item fields describe themselves. This file holds the longer semantics. Who may
write, and when, is SKILL.md §1.

## Nodes

- Domains and features are created explicitly, never implicitly by a proposal. Ids are immutable.
- `feature.create` with `parentFeatureId` nests a feature under another feature of the same domain;
  `feature.update` with `parentFeatureId: null` moves it to the top level.
- Archiving is a visibility state, not a deletion. A delete is refused (`tree_node_not_empty`) while
  children or attached items remain. Deleting a node removes its relations.
- Archive and delete of a domain, feature or dimension follow an explicit maintainer instruction
  naming the node.

## Layout

`layout` is the node read as a document, in order: `{heading, level: 2|3}` headings,
`{lines: [Markdown]}` prose, and `{item: id, style?}` slots. `style: heading` renders the item as
`### <id>` (use cases, flows), `style: prose` as plain paragraphs (an overview), and the default
`bullet` as a list entry. An item with no slot is appended under its kind. On update, `layout`
replaces the stored one; `[]` clears it.

## Seeds

A seed is identified by `(featureId, repoKey, nodeId)`, so `seed.put` both declares a seed and
re-notes it. A `repoKey` the workspace does not carry is refused (`unknown_repo_key`) with the
registered identities listed: fix the id, do not retry. A seed is an exact graph node id read from
tool output.

## Relations

`relation.put {from: {kind: domain|feature, id}, to: {kind, id}, why}` links two nodes a reader of
one should also read, with the reason in one sentence. A relation is unordered, and a put on an
existing pair re-words `why`. A node cannot relate to itself. `relation.delete {from, to}` removes
the link. Node reads list the related nodes with their `why`.

## Dimensions

- `values` on `dimension.update` replaces the whole list.
- Aliases are the words that name a value in prose; propose hints match aliases only, never a value
  title.
- Archiving or deleting a dimension, or dropping one of its values, is refused with
  `dimension_in_use`, naming the blockers, while a domain, a feature, or a candidate or accepted item
  still references it.

## Tree conditions

- A domain or feature `appliesWhen` holds dimension clauses only (`{dimension, in}` |
  `{dimension, notIn}`). Every item under the node inherits it (AND); `[]` clears it.
- Set structural conditions (which product a domain exists for) on the tree once, not on each item.
- Set or clear a domain or feature `appliesWhen` only on an explicit maintainer instruction naming
  the node, like archive and delete.
- A response that changed it reports `affectedAcceptedItems`; for a domain the count includes its
  features' items.

## Item conditions

- Item `appliesWhen` clauses are AND-joined: `{dimension, in}`, `{dimension, notIn}`, `{item}` and
  `{text}`. A `{text}` clause is never evaluated. `[]` clears the conditions; an absent
  `appliesWhen` keeps what is stored.
- An item's effective conditions are its domain's AND its feature's AND its own.
- One rule with a different outcome per context is a `business_rule` with `variants`
  `[{when?, outcome, inputs?}]`. Two variants that could match one context, or a second variant
  without `when`, are refused (`variant_overlap`).
- An `{item}` clause names an existing item, or a same-batch item proposed with an explicit id. A
  cycle is refused (`condition_cycle`), and so is a rejected or superseded target
  (`condition_item_inactive`); a candidate target is not evaluated.
- Propose may answer with non-blocking `hints[]` (`missing-condition`, `ambiguous-variants`,
  `dead-variant`, `unaccepted-condition-item`) for the reviewer. They never write a condition and are
  not a reason to ask the user.
