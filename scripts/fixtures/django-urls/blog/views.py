from rest_framework.decorators import api_view


@api_view(["GET", "POST"])
def feed(request):
    return None
