from django.urls import path
from . import views

urlpatterns = [
    path("api/dashboard/", views.DashboardView.as_view(), name="api-dashboard"),
]
