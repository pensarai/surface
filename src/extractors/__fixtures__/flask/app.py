from flask import Flask, jsonify, render_template

app = Flask(__name__)


@app.route("/api/users")
def list_users():
    return jsonify({"users": []})


@app.route("/about")
def about():
    return render_template("about.html")
