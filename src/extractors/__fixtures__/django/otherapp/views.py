from rest_framework.views import APIView
from rest_framework.response import Response


# Same class name as myapp.DashboardView, but this one is a DRF APIView (api).
# Directory-scoped resolution must keep the two apps' kinds separate.
class DashboardView(APIView):
    def get(self, request):
        return Response({"ok": True})
