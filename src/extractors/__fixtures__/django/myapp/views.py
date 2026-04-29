from django.shortcuts import render
from django.views.generic import TemplateView
from rest_framework.decorators import api_view
from rest_framework.response import Response


class HomeView(TemplateView):
    template_name = "home.html"


def about_page(request):
    return render(request, "about.html", {"title": "About"})


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})
