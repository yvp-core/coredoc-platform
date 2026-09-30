# frozen_string_literal: true

# Namespaced class: a `module` wrapping a `class`, with one instance method and one
# singleton method. Generic fixture — no client-specific names.
module Sample
  class Gadget < ApplicationRecord
    def build
      normalize
    end

    def self.lookup(id)
      id
    end

    def normalize
      1
    end
  end
end
