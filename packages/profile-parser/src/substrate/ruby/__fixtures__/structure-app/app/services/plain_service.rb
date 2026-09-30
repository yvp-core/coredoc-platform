# frozen_string_literal: true

# A file-scope def (no enclosing class/module) beside a module method.
def top_level_helper(value)
  value
end

module Util
  def self.format_value(value)
    value.to_s
  end
end
