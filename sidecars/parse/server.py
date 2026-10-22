"""Dependency parse for Speck's perception (docs/experiments/parse/).

Speck asks a language model only for meaning; the structure of a sentence
(its clauses, each clause's predicate and participants, negation, tense,
amounts and conditions) comes from a deterministic dependency parse.

    python sidecars/parse/server.py [--port 8766] [--host 127.0.0.1] [--model en_core_web_sm]

POST /parse {"text": "..."} returns every token with its character offset,
(and, since 2026-10-21, its named-entity type and whether it is number-like)
lemma, coarse and fine part of speech, dependency, head and morphology.
GET /health reports the loaded model.
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import spacy

NLP = None
MODEL = ""


def parse(text):
    doc = NLP(text)
    return {
        "model": MODEL,
        "tokens": [
            {
                "i": token.i, "text": token.text, "idx": token.idx, "ws": token.whitespace_,
                "lemma": token.lemma_, "pos": token.pos_, "tag": token.tag_, "dep": token.dep_,
                "head": token.head.i, "morph": str(token.morph), "sentStart": bool(token.is_sent_start),
                "ent": token.ent_type_, "likeNum": bool(token.like_num),
            }
            for token in doc
        ],
    }


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "model": MODEL})
        else:
            self.reply(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/parse":
            self.reply(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            text = body.get("text")
            if not isinstance(text, str):
                raise ValueError("text is required")
            self.reply(200, {"ok": True, **parse(text)})
        except Exception as error:  # a bad request is the caller's, not a crash
            self.reply(400, {"ok": False, "error": str(error)})

    def log_message(self, *args):
        pass


def main():
    global NLP, MODEL
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="en_core_web_sm")
    args = parser.parse_args()
    NLP = spacy.load(args.model)
    MODEL = f"{args.model}/{NLP.meta.get('version', '')}"
    print(f"parse sidecar on http://{args.host}:{args.port} ({MODEL})", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
