from django.urls import path
from . import views

urlpatterns = [
    path("api/dashboard/", views.DashboardView.as_view(), name="api-dashboard"),
    path("api/article/", views.ArticleView.as_view(), name="api-article"),
]
