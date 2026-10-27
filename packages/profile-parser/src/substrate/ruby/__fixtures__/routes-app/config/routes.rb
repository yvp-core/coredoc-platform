Rails.application.routes.draw do
  namespace 'api', module: 'admin_api', path: 'api/admin' do
    resources :widgets, only: [:index, :create, :destroy]
  end
end
