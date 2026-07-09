Rails.application.routes.draw do
  get '/about' => 'pages#about'

  namespace :api do
    resources :users, only: [:index]
  end
end
