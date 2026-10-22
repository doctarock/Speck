"""NLI cross-encoder sidecar for Speck's "nli" processors.

Serves purpose-trained natural language inference models (premise and
hypothesis in; entailment, contradiction or neutral out) over HTTP. Each
request names its model; a model is loaded on first use and kept.

    python sidecars/nli/server.py [--port 8765] [--host 127.0.0.1] [--preload MODEL ...]

POST /classify  {"model": "...", "premise": "...", "hypothesis": "..."}
             -> {"label": "contradiction", "scores": {"entailment": 0.01, ...}}
GET  /health -> {"ok": true, "loaded": [...], "device": "cuda"}

Requires torch and transformers. Models download from Hugging Face on first
use into the usual cache.
"""

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
_models = {}
_lock = threading.Lock()


def speck_label(label):
    """Maps a model's class name onto Speck's three labels."""
    label = label.lower()
    if label.startswith("entail"):
        return "entailment"
    if label.startswith("contra"):
        return "contradiction"
    if label.startswith("neutral") or label.startswith("not_entail"):
        return "neutral"
    return None


def load(name):
    with _lock:
        if name not in _models:
            tokenizer = AutoTokenizer.from_pretrained(name)
            model = AutoModelForSequenceClassification.from_pretrained(name).to(DEVICE).eval()
            labels = {int(i): speck_label(l) for i, l in model.config.id2label.items()}
            if sorted(l for l in labels.values() if l) != ["contradiction", "entailment", "neutral"]:
                raise ValueError(f"{name} does not have entailment, contradiction and neutral classes: {model.config.id2label}")
            _models[name] = (tokenizer, model, labels)
        return _models[name]


def classify(name, premise, hypothesis):
    tokenizer, model, labels = load(name)
    with torch.no_grad():
        encoded = tokenizer(premise, hypothesis, return_tensors="pt", truncation=True).to(DEVICE)
        probabilities = model(**encoded).logits.softmax(-1)[0].tolist()
    scores = {labels[i]: p for i, p in enumerate(probabilities) if labels.get(i)}
    return {"label": max(scores, key=scores.get), "scores": scores}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode("utf8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "loaded": list(_models), "device": DEVICE})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/classify":
            self.reply(404, {"error": "not found"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            model, premise, hypothesis = body.get("model"), body.get("premise"), body.get("hypothesis")
            if not all(isinstance(value, str) and value for value in (model, premise, hypothesis)):
                self.reply(400, {"error": "model, premise and hypothesis are required"})
                return
            self.reply(200, classify(model, premise, hypothesis))
        except Exception as error:  # reported to Speck as an unusable judgment
            self.reply(500, {"error": str(error)})

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--preload", nargs="*", default=[])
    arguments = parser.parse_args()
    for name in arguments.preload:
        load(name)
    print(f"NLI sidecar on http://{arguments.host}:{arguments.port} ({DEVICE})", flush=True)
    ThreadingHTTPServer((arguments.host, arguments.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
