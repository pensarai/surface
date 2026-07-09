from rest_framework.views import APIView
from rest_framework.response import Response


# Same class name as myapp.DashboardView, but this one is a DRF APIView (api).
# Directory-scoped resolution must keep the two apps' kinds separate.
class DashboardView(APIView):
    def get(self, request):
        return Response({"ok": True})


# Collides by name with blogapp.views.ArticleView (a page in a nested package).
# This app's route must resolve to THIS api view, not blogapp's page view.
class ArticleView(APIView):
    def get(self, request):
        return Response({"article": None})
