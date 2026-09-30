# frozen_string_literal: true

# Generic fixture for the scip-ruby Tier-A tests. Every internal edge below is a BARE
# self-send (no explicit receiver) — exactly the case the tree-sitter Tier-B heuristic
# cannot resolve but Sorbet (scip-ruby) can. No client-specific names.
module Sample
  class Widget
    def build
      validate!          # build -> validate!
    end

    def validate!
      normalize(name)    # validate! -> normalize  AND  validate! -> name
    end

    def normalize(value)
      value.to_s         # to_s is stdlib — no in-repo edge
    end

    def name
      @name              # ivar read — not a method call, no edge
    end
  end
end
