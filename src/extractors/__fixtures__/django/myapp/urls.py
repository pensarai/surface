from django.urls import path
from . import views

urlpatterns = [
    path("api/health/", views.health),
    path("", views.HomeView.as_view(), name="home"),
    path("about/", views.about_page, name="about"),
]
