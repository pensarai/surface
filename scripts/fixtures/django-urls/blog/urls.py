from django.urls import path, re_path
from . import views

# Mixes the idiomatic raw-string `r"..."` route form with plain-quoted routes
# and an re_path() regex route, so the extractor is exercised against every
# common Python string-literal style.
urlpatterns = [
    path(r"posts/", views.post_list),
    path(r"posts/new/", views.post_create),
    path("drafts/", views.draft_list),
    re_path(r"^posts/(?P<pk>[0-9]+)/$", views.post_detail),
]
