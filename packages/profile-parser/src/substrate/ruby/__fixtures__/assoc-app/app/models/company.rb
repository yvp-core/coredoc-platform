class Company < ApplicationRecord
  has_many :employees

  def headcount
    self.employees.size
  end
end
