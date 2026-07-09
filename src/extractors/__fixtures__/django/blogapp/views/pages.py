from django.views.generic import TemplateView


# Lives in a nested `views/` PACKAGE (blogapp/views/pages.py), not next to
# blogapp/urls.py. Resolution must still reach it via the app subtree — and
# prefer it over the same-named APIView in otherapp (global collision).
class ArticleView(TemplateView):
    template_name = "article.html"
