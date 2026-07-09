from django.shortcuts import render
from django.views.generic import TemplateView
from rest_framework.decorators import api_view
from rest_framework.response import Response


class HomeView(TemplateView):
    template_name = "home.html"


# Intermediate project base — DashboardView inherits TemplateView *indirectly*.
class SiteBaseView(TemplateView):
    pass


class DashboardView(SiteBaseView):
    template_name = "dashboard.html"


def about_page(request):
    return render(request, "about.html", {"title": "About"})


# Single-line function view that renders a template on the same line as `def`.
def status_page(request): return render(request, "status.html")


# Sync JSON view immediately followed by an async template view: the sync view
# must NOT absorb the async view's render() into its body (stays api), and the
# async view must be indexed and classified page.
def json_only(request):
    return JsonResponse({"ok": True})


async def async_page(request):
    return render(request, "async.html", {"title": "Async"})


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})
