class ReportService
  def run
    Company.where(active: true)
    Kaminari.paginate_array([]).where(x: 1)
    self.scope.where(y: 2)
  end
end
