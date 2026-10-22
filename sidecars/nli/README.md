# NLI sidecar

The sidecar serves purpose-trained natural language inference cross-encoders to Speck's `nli` processors. Each model takes a premise and a hypothesis and returns entailment, contradiction or neutral.

Speck uses an NLI processor only as a **checker** of hypothesis requirements (S30). It is used only after the model has been measured qualified for atomic entailment (S31, invariant 20). It never fills a role, writes a reply or validates one.

## Run

Requires Python 3.10+, `torch` and `transformers`. A GPU is used when available.

```
python sidecars/nli/server.py --port 8765
```

- **Model loading:** each request names its model, which is loaded on first use and kept, so one sidecar can serve several models. To load one at startup, add `--preload MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli`.
- **Downloads:** models come from Hugging Face on first use.
- **Memory:** DeBERTa-v3-large takes about 1.7 GB of VRAM in fp32.

## Configure

Add a processor with `provider: "nli"` to `data/genesis-runtime/model-processors.json`:

```json
{
  "id": "nli-checker", "provider": "nli",
  "model": "MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli",
  "baseUrl": "http://127.0.0.1:8765", "tier": 1, "contextSize": 512,
  "specialties": ["atomic-entailment"], "enabled": true
}
```

Make it the checker by setting `"roles": { ..., "checker": "nli-checker" }`, or choose it as **Checker processor** under System → Brains. It cannot fill any other role; configuration rejects that.

The Brains page shows whether its checks count. A configured checker's verdicts move beliefs only once it has been measured qualified (S31). Until then the page shows "void" with the measured numbers.

## Qualify

```
node dist/cli.js probe qualify --repetitions 1 --models "nli:MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli"
```

The result is recorded as the model's qualification in the competence store. A cross-encoder is deterministic, so one repetition measures it fully. Until the model qualifies, every check it would make is void. Results are in `docs/experiments/qualification/README.md`.

## API

- `POST /classify` with `{"model", "premise", "hypothesis"}` returns `{"label", "scores": {"entailment", "contradiction", "neutral"}}`.
- `GET /health` returns `{"ok", "loaded", "device"}`.
