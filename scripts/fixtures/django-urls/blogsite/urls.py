from django.contrib import admin
from django.urls import path, include
from . import views

# Root URLconf: plain-quoted routes plus an include() into the blog app.
urlpatterns = [
    path("admin/", admin.site.urls),
    path("", views.home),
    path("blog/", include("blog.urls")),
]
